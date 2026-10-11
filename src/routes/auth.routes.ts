import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { env } from '../config/env.js';
import { AppError } from '../lib/errors.js';
import {
  assignRoleSchema,
  changePasswordSchema,
  forgotPasswordSchema,
  loginSchema,
  refreshSchema,
  registerSchema,
  resetPasswordSchema,
  serviceLoginSchema,
  updateProfileSchema,
  verifyEmailSchema,
} from '../modules/auth/schema.js';
import * as authService from '../modules/auth/service.js';
import { listSessions, revokeAllSessions, type AccessTokenClaims } from '../modules/auth/tokens.js';

/**
 * RUTAS DE AUTENTICACION
 *
 * Sobre el token de refresco: viaja en cookie httpOnly, no en el cuerpo
 * de la respuesta. Asi el JavaScript de la pagina no puede leerlo, lo
 * que neutraliza el robo por XSS. El token de acceso si va en el
 * cuerpo porque el frontend lo necesita en memoria para los Authorization
 * headers, y por eso es de vida corta.
 */

const REFRESH_COOKIE = 'hossana_rt';

/** Extrae el token de refresco de la cookie o del cuerpo (API clients). */
function readRefreshToken(req: FastifyRequest, body?: { refreshToken?: string }): string | null {
  const fromCookie = req.cookies?.[REFRESH_COOKIE];
  if (fromCookie) return fromCookie;
  if (body?.refreshToken) return body.refreshToken;
  const header = req.headers['x-refresh-token'];
  return typeof header === 'string' ? header : null;
}

function setRefreshCookie(reply: FastifyReply, token: string): void {
  void reply.setCookie(REFRESH_COOKIE, token, {
    path: '/api/auth',
    httpOnly: true,
    // En desarrollo el frontend corre en otro puerto: sin SameSite Lax
    // la cookie no viaja en las peticiones cross-site.
    secure: env.isProduction,
    sameSite: env.isProduction ? 'lax' : 'none',
    maxAge: Math.floor(env.jwtRefreshTtlMs / 1000),
  });
}

function clearRefreshCookie(reply: FastifyReply): void {
  void reply.clearCookie(REFRESH_COOKIE, { path: '/api/auth' });
}

function contextOf(req: FastifyRequest) {
  return { userAgent: req.headers['user-agent'] ?? null, ip: req.ip };
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  // ── Registro ───────────────────────────────────────────────
  app.post(
    '/register',
    {
      config: {
        rateLimit: { max: 5, timeWindow: '10 minutes' },
      },
      schema: {
        tags: ['auth'],
        summary: 'Crea una cuenta de usuario',
        body: {
          type: 'object',
          required: ['email', 'password', 'firstName', 'lastName'],
          properties: {
            email: { type: 'string', format: 'email' },
            password: { type: 'string', minLength: 10 },
            firstName: { type: 'string' },
            lastName: { type: 'string' },
            phone: { type: 'string' },
            locale: { type: 'string', enum: ['es', 'en', 'pt'] },
          },
        },
      },
    },
    async (req, reply) => {
      const input = registerSchema.parse(req.body);
      const result = await authService.registerUser(input, req);

      // 201 y no sesion iniciada: el usuario debe verificar su correo
      // primero. Auto-iniciarlo dejaria abierta la puerta al registro
      // masivo de cuentas falsas.
      return reply.status(201).send({
        user: result.user,
        message: 'Cuenta creada. Revisa tu correo para verificarla.',
        // Solo en desarrollo: en produccion este token viaja por correo.
        ...(env.isProduction ? {} : { verificationToken: result.verificationToken }),
      });
    },
  );

  // ── Login ──────────────────────────────────────────────────
  app.post(
    '/login',
    {
      config: {
        rateLimit: { max: 10, timeWindow: '15 minutes' },
      },
      schema: {
        tags: ['auth'],
        summary: 'Inicia sesion',
      },
    },
    async (req, reply) => {
      const input = loginSchema.parse(req.body);
      const session = await authService.loginUser(
        input.identifier,
        input.password,
        contextOf(req),
        req,
      );

      setRefreshCookie(reply, session.refreshToken);

      return reply.send({
        accessToken: session.accessToken,
        expiresIn: session.expiresInSeconds,
        user: session.user,
        // Se devuelve tambien en el cuerpo para clientes no navegador
        // (movil, integraciones), que no manejan cookies.
        refreshToken: session.refreshToken,
      });
    },
  );

  // ── Renovacion ─────────────────────────────────────────────
  app.post(
    '/refresh',
    {
      schema: {
        tags: ['auth'],
        summary: 'Renueva el token de acceso',
      },
    },
    async (req, reply) => {
      const body = refreshSchema.parse(req.body ?? {});
      const token = readRefreshToken(req, body);

      if (!token) {
        throw new AppError('UNAUTHORIZED', 'No hay token de refresco', 401);
      }

      const session = await authService.refreshSession(token, contextOf(req), req);
      setRefreshCookie(reply, session.refreshToken);

      return reply.send({
        accessToken: session.accessToken,
        expiresIn: session.expiresInSeconds,
        refreshToken: session.refreshToken,
      });
    },
  );

  // ── Logout ─────────────────────────────────────────────────
  app.post(
    '/logout',
    { schema: { tags: ['auth'], summary: 'Cierra la sesion actual' } },
    async (req, reply) => {
      const token = readRefreshToken(req);
      if (token) await authService.logout(token, req);
      clearRefreshCookie(reply);
      return reply.send({ message: 'Sesion cerrada' });
    },
  );

  // ── Sesiones activas ───────────────────────────────────────
  app.get(
    '/sessions',
    { preHandler: [app.authenticate], schema: { tags: ['auth'], summary: 'Lista las sesiones activas' } },
    async (req) => {
      const user = req.currentUser as AccessTokenClaims;
      const sessions = await listSessions(user.sub);
      return { data: sessions };
    },
  );

  app.delete(
    '/sessions',
    { preHandler: [app.authenticate], schema: { tags: ['auth'], summary: 'Cierra todas las sesiones' } },
    async (req) => {
      const user = req.currentUser as AccessTokenClaims;
      const count = await revokeAllSessions(user.sub, 'USER_REVOKED_ALL');
      return { message: `Se cerraron ${count} sesion(es)` };
    },
  );

  // ── Verificacion de correo ─────────────────────────────────
  app.post(
    '/verify-email',
    {
      schema: {
        tags: ['auth'],
        summary: 'Confirma el correo con el token recibido',
      },
    },
    async (req) => {
      const input = verifyEmailSchema.parse(req.body);
      const user = await authService.verifyEmail(input.token, req);
      return { user, message: 'Correo verificado' };
    },
  );

  // ── Recuperacion de contrasena ─────────────────────────────
  app.post(
    '/forgot-password',
    {
      config: { rateLimit: { max: 5, timeWindow: '15 minutes' } },
      schema: { tags: ['auth'], summary: 'Solicita un enlace de recuperacion' },
    },
    async (req) => {
      const input = forgotPasswordSchema.parse(req.body);
      // Siempre responde igual: no revela si el correo existe.
      await authService.requestPasswordReset(input.email, req);
      return {
        message: 'Si el correo esta registrado, recibiras instrucciones en breve.',
      };
    },
  );

  app.post(
    '/reset-password',
    {
      config: { rateLimit: { max: 10, timeWindow: '15 minutes' } },
      schema: { tags: ['auth'], summary: 'Establece una nueva contrasena' },
    },
    async (req) => {
      const input = resetPasswordSchema.parse(req.body);
      await authService.resetPassword(input.token, input.newPassword, req);
      return { message: 'Contrasena actualizada. Inicia sesion nuevamente.' };
    },
  );

  app.post(
    '/change-password',
    { preHandler: [app.authenticate], schema: { tags: ['auth'], summary: 'Cambia la contrasena actual' } },
    async (req, reply) => {
      const user = req.currentUser as AccessTokenClaims;
      const input = changePasswordSchema.parse(req.body);
      await authService.changePassword(user.sub, input.currentPassword, input.newPassword, req);
      // La contrasena cambio: la cookie de refresco actual ya no sirve
      // porque changePassword revoca toda la familia de tokens.
      clearRefreshCookie(reply);
      return { message: 'Contrasena actualizada. Inicia sesion nuevamente.' };
    },
  );

  // ── Credenciales de servicio ───────────────────────────────
  app.post(
    '/service',
    {
      config: { rateLimit: { max: 5, timeWindow: '10 minutes' } },
      schema: {
        tags: ['auth'],
        summary: 'Emite un token para integraciones (CI, jobs, webhooks)',
      },
    },
    async (req, reply) => {
      const input = serviceLoginSchema.parse(req.body);
      const session = await authService.issueServiceToken(input.serviceKey, input.audience);
      return reply.send(session);
    },
  );

  // ── Gestion de usuarios (admin) ────────────────────────────
  app.get(
    '/users',
    {
      preHandler: [app.requireRole('ADMIN')],
      schema: { tags: ['auth'], summary: 'Lista usuarios (admin)' },
    },
    async (req) => {
      const query = z
        .object({
          status: z.enum(['PENDING_VERIFICATION', 'ACTIVE', 'SUSPENDED']).optional(),
          role: z.enum(['SENDER', 'RECIPIENT', 'OPERATOR', 'COURIER', 'ADMIN']).optional(),
          search: z.string().optional(),
        })
        .parse(req.query);

      const users = await authService.listUsers(query);
      return { data: users };
    },
  );

  app.post(
    '/users/roles',
    {
      preHandler: [app.requireRole('ADMIN')],
      schema: { tags: ['auth'], summary: 'Asigna roles a un usuario (admin)' },
    },
    async (req) => {
      const input = assignRoleSchema.parse(req.body);
      const actor = req.currentUser as AccessTokenClaims;
      const user = await authService.assignRoles(input.userId, input.roles, actor.sub, req);
      return { user };
    },
  );
}

