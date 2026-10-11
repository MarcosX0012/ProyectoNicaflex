import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';

import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { prisma } from './lib/prisma.js';

import { errorHandlerPlugin } from './plugins/errorHandler.js';
import { authPlugin } from './plugins/auth.js';
import { rawBodyPlugin } from './plugins/rawBody.js';

import { authRoutes } from './routes/auth.routes.js';
import { userRoutes } from './routes/user.routes.js';
import { shipmentRoutes } from './routes/shipments.routes.js';
import { trackingRoutes } from './routes/tracking.routes.js';
import { webhookRoutes } from './routes/webhook.routes.js';
import { paymentRoutes } from './routes/payment.routes.js';

/**
 * Construccion de la aplicacion Fastify.
 *
 * Separar `buildApp` de `index.ts` tiene un motivo practico: las
 * pruebas levantan la app con `app.inject()` sin abrir un puerto, y el
 * worker de jobs no necesita el servidor HTTP.
 *
 * El tipo de retorno se infiere en lugar de anotarse: al pasarle a
 * Fastify la instancia de pino via `loggerInstance`, el tipo concreto
 * del logger del servidor es el de pino y no `FastifyBaseLogger`.
 * Anotar `Promise<FastifyInstance>` obligaria a un cast que romperia
 * el registro de rutas.
 */

export async function buildApp(options: { logger?: boolean } = {}) {
  const app = Fastify({
    // Fastify 5 separo las dos formas de configurar el log: `logger`
    // solo acepta un objeto de opciones, y una instancia de pino ya
    // creada se pasa en `loggerInstance`. Pasar la instancia en
    // `logger` lanza FST_ERR_LOG_INVALID_LOGGER_CONFIG y el proceso
    // muere al arrancar.
    ...(options.logger === false ? { logger: false as const } : { loggerInstance: logger }),
    trustProxy: true, // necessario para que req.ip sea la IP real detras de un proxy
    bodyLimit: 2 * 1024 * 1024, // 2 MB: suficiente para fotos en base64, no para archivos grandes
    disableRequestLogging: env.isProduction,
    ajv: {
      customOptions: {
        removeAdditional: 'all',
        coerceTypes: true,
        allErrors: true,
      },
    },
  });

  // ── Manejo de errores (primero: captura todo) ────────────
  await app.register(errorHandlerPlugin);

  // ── Cuerpo crudo para webhooks ────────────────────────────
  // Va antes que el parser de JSON: necesita interceptar preParsing.
  await app.register(rawBodyPlugin);

  // ── Cabeceras de seguridad ────────────────────────────────
  await app.register(helmet, {
    // La API sirve JSON e imagenes; no necesita CSP de documento HTML.
    // La CSP real la aplica el frontend.
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  });

  // ── CORS ──────────────────────────────────────────────────
  await app.register(cors, {
    origin: (origin, callback) => {
      // Sin Origin: peticiones desde curl, apps moviles o el propio
      // servidor. No es un ataque, es una peticion sin CORS de por medio.
      if (!origin) return callback(null, true);

      if (env.corsOrigins.includes(origin) || env.corsOrigins.includes('*')) {
        return callback(null, true);
      }

      callback(new Error('Origen no permitido por CORS'), false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Idempotency-Key', 'X-Request-Id'],
    exposedHeaders: ['X-RateLimit-Remaining', 'X-RateLimit-Reset'],
    maxAge: 86400,
  });

  await app.register(cookie, {
    // Se firma para que un cliente no pueda falsificar la cookie de
    // refresco; la validacion real es la busqueda del hash en la base.
    secret: env.jwtSecret,
    hook: 'onRequest',
  });

  // ── Limite de tasa global ─────────────────────────────────
  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: '1 minute',
    // El rate limit global se mide por IP autenticada, no solo por IP:
    // sin esto, una oficina con muchos usuarios tras un mismo proxy
    // bloquearia a todos.
    keyGenerator: (req) => req.currentUser?.sub ?? req.ip,
    hook: 'onRequest',
    errorResponseBuilder: (_req, context) => ({
      error: {
        code: 'RATE_LIMITED',
        message: `Demasiadas peticiones. Intenta de nuevo en ${context.after}.`,
      },
    }),
    addHeadersOnExceeding: { 'x-ratelimit-remaining': true },
  });

  // ── Autenticacion ─────────────────────────────────────────
  await app.register(authPlugin);

  // ── Documentacion ─────────────────────────────────────────
  await app.register(swagger, {
    openapi: {
      openapi: '3.0.3',
      info: {
        title: 'Hossana API',
        description:
          'API de rastreo de envios con linea de tiempo en tiempo real.\n\n' +
          '**Modelo de permisos:** los codigos de rastreo son publicos (van impresos ' +
          'en el QR del paquete) pero NO exponen datos personales. El detalle completo ' +
          'lo ven unicamente el emisor, el receptor y el personal operativo.',
        version: '1.0.0',
      },
      servers: [
        { url: `http://localhost:${env.PORT}`, description: 'Local' },
      ],
      tags: [
        { name: 'auth', description: 'Registro, login, tokens y sesiones' },
        { name: 'users', description: 'Perfil del usuario autenticado' },
        { name: 'shipments', description: 'Creacion y gestion de envios' },
        { name: 'tracking', description: 'Rastreo publico (sin autenticacion)' },
        { name: 'payments', description: 'Pagos en linea y cobro contra entrega' },
        { name: 'webhooks', description: 'Recepcion de eventos de terceros' },
        { name: 'health', description: 'Estado del servicio' },
      ],
      components: {
        securitySchemes: {
          bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
        },
      },
      security: [{ bearerAuth: [] }],
    },
  });

  await app.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: { docExpansion: 'list', deepLinking: true },
  });

  // ── Rutas ─────────────────────────────────────────────────
  await app.register(
    async (api) => {
      // Los prefijos NO llevan /api: el bloque ya esta montado con
      // { prefix: '/api' } mas abajo. Duplicarlo dejaba todo en
      // /api/api/... y rompia el path de la cookie de refresh.
      await api.register(authRoutes, { prefix: '/auth' });
      await api.register(userRoutes, { prefix: '/users' });
      await api.register(shipmentRoutes, { prefix: '/shipments' });
      await api.register(trackingRoutes, { prefix: '/public/track' });
      await api.register(paymentRoutes, { prefix: '/payments' });
      await api.register(webhookRoutes, { prefix: '/webhooks' });
    },
    { prefix: '/api' },
  );

  // ── Salud ─────────────────────────────────────────────────
  app.get('/health', async (_req, reply) => {
    return reply.send({
      status: 'ok',
      service: 'hossana-api',
      version: '1.0.0',
      uptime: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
    });
  });

  app.get('/health/ready', async (_req, reply) => {
    // Readiness: a diferencia del liveness, esto SI comprueba la base
    // de datos. Un contenedor con la base caida no debe recibir trafico.
    try {
      await prisma.$queryRaw`SELECT 1`;
      return reply.send({ status: 'ready', database: 'up' });
    } catch (error) {
      return reply.status(503).send({
        status: 'not_ready',
        database: 'down',
        error: error instanceof Error ? error.message : 'Error desconocido',
      });
    }
  });

  return app;
}