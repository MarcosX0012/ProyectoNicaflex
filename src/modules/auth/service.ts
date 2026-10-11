import argon2 from 'argon2';
import { createHmac, randomUUID } from 'node:crypto';
import type { User, UserRole } from '@prisma/client';
import { env } from '../../config/env.js';
import { prisma } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';
import { conflict, forbidden, notFound, unauthorized, validationError } from '../../lib/errors.js';
import { recordAudit } from '../../lib/audit.js';
import type { FastifyRequest } from 'fastify';
import {
  consumeRefreshToken,
  consumeVerificationToken,
  issueRefreshToken,
  issueVerificationToken,
  revokeAllSessions,
  revokeRefreshToken,
  sha256,
  signAccessToken,
  phoneIndex,
} from './tokens.js';
import type { RegisterInput } from './schema.js';

/**
 * Servicio de autenticacion.
 *
 *argon2id con parametros conservativeos: el coste por login es
 * deliberadamente alto para que un atacante no pueda probar millones
 * de contrasenas por segundo, y porque en este sistema el volumen de
 * logins es bajo comparado con el costo de un compromiso.
 */

// ── Hash de contrasenas ────────────────────────────────────────

const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19456, // 19 MiB (minimo recomendado por OWASP)
  timeCost: 2,
  parallelism: 1,
} as const;

export async function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, ARGON2_OPTIONS);
}

/**
 * Verifica una contrasena. argon2.verify lanza si el hash es
 * malformado; se traduce a false para no filtrar informacion.
 */
export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
}

// ── Registro ───────────────────────────────────────────────────

const PUBLIC_USER_SELECT = {
  id: true,
  email: true,
  firstName: true,
  lastName: true,
  roles: true,
  status: true,
  locale: true,
  emailVerifiedAt: true,
  phoneVerifiedAt: true,
  createdAt: true,
} as const;

export type PublicUser = Pick<
  User,
  | 'id'
  | 'email'
  | 'firstName'
  | 'lastName'
  | 'roles'
  | 'status'
  | 'locale'
  | 'emailVerifiedAt'
  | 'phoneVerifiedAt'
  | 'createdAt'
>;

export async function registerUser(
  input: RegisterInput,
  req?: FastifyRequest,
): Promise<{ user: PublicUser; verificationToken: string | null }> {
  const existing = await prisma.user.findUnique({
    where: { email: input.email },
    select: { id: true },
  });

  if (existing) {
    // No se revela si el correo esta registrado... salvo que la
    // respuesta sea identica en ambos casos. Aqui devolvemos 409
    // explicito porque el registro es publico y un usuario necesita
    // saber que su correo ya existe para iniciar sesion. El login
    // si es generico, a proposito.
    throw conflict('Ya existe una cuenta con ese correo electronico');
  }

  if (input.phone) {
    const phoneTaken = await prisma.user.findUnique({
      where: { phoneHash: phoneIndex(input.phone) },
      select: { id: true },
    });
    if (phoneTaken) throw conflict('Ese numero de telefono ya esta registrado');
  }

  const passwordHash = await hashPassword(input.password);

  const user = await prisma.user.create({
    data: {
      email: input.email,
      passwordHash,
      firstName: input.firstName,
      lastName: input.lastName,
      roles: ['SENDER', 'RECIPIENT'],
      locale: input.locale,
      // El correo queda sin verificar hasta que confirma el token.
      status: 'PENDING_VERIFICATION',
      ...(input.phone ? { phoneHash: phoneIndex(input.phone) } : {}),
    },
    select: PUBLIC_USER_SELECT,
  });

  await recordAudit(
    { userId: user.id, action: 'USER_REGISTER', entity: 'User', entityId: user.id },
    req,
  );

  // En produccion este token viaja por correo; en desarrollo se
  // devuelve para poder probar el flujo sin configurar el proveedor.
  const verificationToken = await issueVerificationToken(user.id, 'EMAIL_VERIFICATION');

  return { user, verificationToken };
}

// ── Login ──────────────────────────────────────────────────────

export interface AuthSession {
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
  user: PublicUser;
}

export async function loginUser(
  identifier: string,
  password: string,
  context: { userAgent?: string | null; ip?: string | null } = {},
  req?: FastifyRequest,
): Promise<AuthSession> {
  const normalizedEmail = identifier.trim().toLowerCase();
  const isPhone = /^\+?[0-9\s()-]{7,}$/.test(identifier.trim());

  const user = await prisma.user.findFirst({
    where: isPhone
      ? { phoneHash: phoneIndex(identifier) }
      : { email: normalizedEmail },
  });

  if (!user) {
    // Se ejecuta un hash dummy para que el tiempo de respuesta no
    // revele si el correo existe. Sin esto, "no existe" responde
    // mucho mas rapido que "existe pero contrasena incorrecta".
    await verifyPassword(
      '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHRzb21lc2FsdA$abcdefghijklmnopqrstuvwxyz0123456789',
      password,
    );
    await recordAudit(
      {
        action: 'LOGIN_FAILED',
        entity: 'User',
        outcome: 'DENIED',
        metadata: { reason: 'USER_NOT_FOUND', identifier: normalizedEmail },
      },
      req,
    );
    throw unauthorized('Credenciales incorrectas');
  }

  const passwordOk = await verifyPassword(user.passwordHash, password);

  if (!passwordOk) {
    await recordAudit(
      { userId: user.id, action: 'LOGIN_FAILED', entity: 'User', entityId: user.id, outcome: 'DENIED' },
      req,
    );
    throw unauthorized('Credenciales incorrectas');
  }

  if (user.status === 'SUSPENDED') {
    await recordAudit(
      { userId: user.id, action: 'LOGIN_BLOCKED', entity: 'User', entityId: user.id, outcome: 'DENIED' },
      req,
    );
    throw forbidden('La cuenta esta suspendida. Contacta al soporte.');
  }

  // Verificacion pendiente no bloquea el acceso: un usuario con el
  // correo sin confirmar aun debe poder entrar a completar su perfil.
  // Lo que si bloquea es la creacion de envios (ver guard de rol).

  const familyId = randomUUID();
  const [access, refresh] = await Promise.all([
    Promise.resolve(signAccessToken(user)),
    issueRefreshToken(user.id, familyId, context),
  ]);

  await prisma.user.update({
    where: { id: user.id },
    data: { lastLoginAt: new Date() },
  });

  await recordAudit(
    { userId: user.id, action: 'LOGIN_SUCCESS', entity: 'User', entityId: user.id },
    req,
  );

  const { phoneHash: _phoneHash, passwordHash: _passwordHash, phoneCipher, updatedAt, lastLoginAt, ...publicUser } =
    user as User & { phoneHash?: string | null; phoneCipher?: string | null };

  return {
    accessToken: access.token,
    refreshToken: refresh.token,
    expiresInSeconds: access.expiresInSeconds,
    user: publicUser as PublicUser,
  };
}

// ── Renovacion ─────────────────────────────────────────────────

export async function refreshSession(
  rawToken: string,
  context: { userAgent?: string | null; ip?: string | null } = {},
  req?: FastifyRequest,
): Promise<AuthSession> {
  const { userId, familyId } = await consumeRefreshToken(rawToken);

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw unauthorized('El usuario de esta sesion ya no existe');
  if (user.status === 'SUSPENDED') throw forbidden('La cuenta esta suspendida');

  // Rotacion: el token usado se revoca y se emite uno nuevo de la
  // misma familia. Un refresh mas adelante con el token viejo dispara
  // la deteccion de robo.
  await prisma.refreshToken.updateMany({
    where: { familyId, tokenHash: sha256(rawToken) },
    data: { revokedAt: new Date(), reason: 'ROTATED' },
  });

  const [access, refresh] = await Promise.all([
    Promise.resolve(signAccessToken(user)),
    issueRefreshToken(user.id, familyId, context),
  ]);

  await recordAudit(
    { userId, action: 'TOKEN_REFRESHED', entity: 'User', entityId: userId },
    req,
  );

  return {
    accessToken: access.token,
    refreshToken: refresh.token,
    expiresInSeconds: access.expiresInSeconds,
    user: sanitizeUser(user),
  };
}

// ── Logout ─────────────────────────────────────────────────────

export async function logout(rawToken: string, req?: FastifyRequest): Promise<void> {
  await revokeRefreshToken(rawToken, 'LOGOUT');
  await recordAudit({ action: 'LOGOUT', entity: 'User' }, req);
}

// ── Verificacion de correo ─────────────────────────────────────

export async function verifyEmail(token: string, req?: FastifyRequest): Promise<PublicUser> {
  const userId = await consumeVerificationToken(token, 'EMAIL_VERIFICATION');

  const user = await prisma.user.update({
    where: { id: userId },
    data: {
      emailVerifiedAt: new Date(),
      status: 'ACTIVE',
    },
    select: PUBLIC_USER_SELECT,
  });

  await recordAudit(
    { userId, action: 'EMAIL_VERIFIED', entity: 'User', entityId: userId },
    req,
  );

  return user;
}

// ── Recuperacion de contrasena ─────────────────────────────────

/**
 * Siempre resuelve igual, exista o no el correo. Si devolviera un
 * error distinto para "correo no registrado", permitiria enumerar
 * quais correos tienen cuenta.
 */
export async function requestPasswordReset(
  email: string,
  req?: FastifyRequest,
): Promise<{ delivered: boolean }> {
  const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });

  if (user) {
    const token = await issueVerificationToken(user.id, 'PASSWORD_RESET');
    logger.info({ userId: user.id, tokenPreview: `${token.slice(0, 8)}...` }, 'Password reset emitido');
    // Aqui se envia el correo con `token`. El proveedor se conecta en
    // el modulo de notificaciones.
  }

  await recordAudit(
    { action: 'PASSWORD_RESET_REQUESTED', entity: 'User' },
    req,
  );

  return { delivered: true };
}

export async function resetPassword(
  token: string,
  newPassword: string,
  req?: FastifyRequest,
): Promise<void> {
  const userId = await consumeVerificationToken(token, 'PASSWORD_RESET');
  const passwordHash = await hashPassword(newPassword);

  await prisma.user.update({ where: { id: userId }, data: { passwordHash } });

  // Cambiar la contrasena cierra todas las sesiones: si alguien
  // estaba dentro con la contrasena vieja, pierde el acceso.
  const revoked = await revokeAllSessions(userId, 'PASSWORD_CHANGED');

  await recordAudit(
    { userId, action: 'PASSWORD_RESET', entity: 'User', entityId: userId, metadata: { sessionsRevoked: revoked } },
    req,
  );
}

export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
  req?: FastifyRequest,
): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw notFound('Usuario');

  const ok = await verifyPassword(user.passwordHash, currentPassword);
  if (!ok) throw validationError('La contrasena actual no coincide');

  await prisma.user.update({
    where: { id: userId },
    data: { passwordHash: await hashPassword(newPassword) },
  });

  await revokeAllSessions(userId, 'PASSWORD_CHANGED');
  await recordAudit({ userId, action: 'PASSWORD_CHANGED', entity: 'User', entityId: userId }, req);
}

// ── Perfil ─────────────────────────────────────────────────────

export function sanitizeUser(user: User): PublicUser {
  const {
    passwordHash: _p,
    phoneHash: _ph,
    phoneCipher: _pc,
    ...rest
  } = user;
  return rest as unknown as PublicUser;
}

export async function getProfile(userId: string): Promise<PublicUser> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: PUBLIC_USER_SELECT });
  if (!user) throw notFound('Usuario');
  return user;
}

export async function updateProfile(
  userId: string,
  data: { firstName?: string; lastName?: string; phone?: string; locale?: 'es' | 'en' | 'pt' },
): Promise<PublicUser> {
  if (data.phone) {
    const taken = await prisma.user.findUnique({
      where: { phoneHash: phoneIndex(data.phone) },
      select: { id: true },
    });
    if (taken && taken.id !== userId) {
      throw conflict('Ese numero de telefono ya pertenece a otra cuenta');
    }
  }

  return prisma.user.update({
    where: { id: userId },
    data: {
      ...(data.firstName !== undefined ? { firstName: data.firstName } : {}),
      ...(data.lastName !== undefined ? { lastName: data.lastName } : {}),
      ...(data.locale !== undefined ? { locale: data.locale } : {}),
      ...(data.phone !== undefined
        ? {
            phoneHash: phoneIndex(data.phone),
            // Cambiar el telefono invalida la verificacion previa.
            phoneVerifiedAt: null,
          }
        : {}),
    },
    select: PUBLIC_USER_SELECT,
  });
}

// ── Credenciales de servicio ─────────────────────────────

/**
 * Emite un token de acceso para integraciones (CI, jobs, scripts).
 *
 * Por que NO se guardan estos tokens en la base: un token de servicio
 * se valida por comparacion contra el secreto en memoria. Es el mismo
 * modelo que un webhook compartido. La contrapartida es que no se puede
 * revocar individualmente uno sin cambiar el secreto, por eso el
 * secreto es lo que se rota cuando hay que revocar.
 */
export function issueServiceToken(
  serviceKey: string,
  audience: 'webhook' | 'internal' | 'integration',
): { accessToken: string; expiresInSeconds: number; audience: string } {
  if (!env.SERVICE_API_KEYS) {
    throw forbidden('Las credenciales de servicio no estan configuradas en este entorno');
  }

  // Formato esperado: "<audience>:<secreto>" o "<secreto>" para uso generico.
  const configured = env.SERVICE_API_KEYS.split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

  const providedHash = sha256(serviceKey);

  const matched = configured.some((entry) => {
    const [entryAudience, entrySecret] = entry.includes(':')
      ? entry.split(':')
      : [undefined, entry];
    const secret = (entrySecret ?? entry).trim();
    return sha256(secret) === providedHash && (!entryAudience || entryAudience === audience);
  });

  if (!matched) {
    logger.warn({ audience }, 'Credencial de servicio rechazada');
    throw unauthorized('Credencial de servicio invalida');
  }

  const token = signJwtService(audience, serviceKey.slice(-8));
  return { accessToken: token, expiresInSeconds: env.jwtAccessTtlSeconds, audience };
}

function signJwtService(audience: string, subject: string): string {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: `service:${subject}`,
    aud: audience,
    service: true,
    iat: now,
    exp: now + env.jwtAccessTtlSeconds,
    iss: 'hossana',
  };

  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = `${encode(header)}.${encode(payload)}`;
  const signature = createHmac('sha256', env.jwtSecret).update(unsigned).digest('base64url');
  return `${unsigned}.${signature}`;
}

// ── Gestion de roles (admin) ───────────────────────────────────

export async function assignRoles(
  targetUserId: string,
  roles: UserRole[],
  actorId: string,
  req?: FastifyRequest,
): Promise<PublicUser> {
  const target = await prisma.user.findUnique({ where: { id: targetUserId } });
  if (!target) throw notFound('Usuario');

  // Un admin no puede quitarse su propio rol ADMIN: evita dejar el
  // sistema sin nadie que lo administre por accidente.
  if (targetUserId === actorId && target.roles.includes('ADMIN') && !roles.includes('ADMIN')) {
    throw validationError('No puedes quitarte a ti mismo el rol de administrador');
  }

  const user = await prisma.user.update({
    where: { id: targetUserId },
    data: { roles },
    select: PUBLIC_USER_SELECT,
  });

  await recordAudit(
    {
      userId: actorId,
      action: 'ROLES_ASSIGNED',
      entity: 'User',
      entityId: targetUserId,
      metadata: { previous: target.roles, next: roles },
    },
    req,
  );

  return user;
}

export async function listUsers(filters: { status?: string; role?: string; search?: string }) {
  const where: Record<string, unknown> = {};
  if (filters.status) where.status = filters.status;
  if (filters.role) where.roles = { has: filters.role };
  if (filters.search) {
    where.OR = [
      { email: { contains: filters.search.toLowerCase(), mode: 'insensitive' } },
      { firstName: { contains: filters.search, mode: 'insensitive' } },
      { lastName: { contains: filters.search, mode: 'insensitive' } },
    ];
  }

  return prisma.user.findMany({
    where,
    select: PUBLIC_USER_SELECT,
    orderBy: { createdAt: 'desc' },
    take: 200,
  });
}

/**
 * Guard de rol: exige que el usuario tenga AL MENOS UNO de los roles.
 *
 * Nota de diseño: el guard de verdad vive en el plugin de
 * autenticacion (`app.requireRole`), porque necesita acceso a
 * `req.currentUser`. Esta función existe para cuando el rol se decide
 * en tiempo de ejecucion, no en el registro de la ruta.
 */
export function requireRoles(...allowed: UserRole[]) {
  return async (req: import('fastify').FastifyRequest): Promise<void> => {
    const user = req.currentUser;
    if (!user) throw unauthorized();

    const hasAny = user.roles.some((role) => allowed.includes(role));
    if (!hasAny) {
      throw forbidden(`Esta accion requiere uno de estos roles: ${allowed.join(', ')}`);
    }
  };
}