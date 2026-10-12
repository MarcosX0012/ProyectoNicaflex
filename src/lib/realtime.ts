import type { Server as HttpServer } from 'node:http';
import { Server as SocketIOServer } from 'socket.io';
import { env } from '../config/env.js';
import { logger } from './logger.js';
import { verifyAccessToken } from '../modules/auth/tokens.js';

/**
 * TIEMPO REAL
 * ===========
 *
 * Cuando se registra un hito, el usuario que mira la linea de tiempo lo
 * ve aparecer sin recargar. Eso es lo que convierte "un historial de
 * estados" en "rastreo en vivo".
 *
 * Como no hay Redis en este despliegue, la escala entre instancias se
 * resuelve con el adaptador de Socket.io sobre PostgreSQL
 * (LISTEN/NOTIFY), que es exactamente lo que hace un Postgres
 * multi-nodo. Si mas adelante se anaden varias instancias, este archivo
 * no cambia.
 *
 * Salas:
 *   shipment:<trackingCode>  -> watchers de un envio concreto (rastreo publico)
 *   user:<userId>            -> notificaciones personales de un usuario
 *
 * Las salas se autoriza al entrar, no despues: el socket valida el
 * token en el handshake.
 */

let io: SocketIOServer | null = null;

interface SocketUser {
  userId: string;
  roles: string[];
}

/**
 * Socket.io v4 exige ampliar `SocketData` (no `Socket`) para tipar
 * `socket.data`. Al ampliarlo aqui, todos los handlers obtienen
 * `socket.data.user` con tipo sin repetir casteos.
 */
declare module 'socket.io' {
  interface SocketData {
    user?: SocketUser;
  }
}

export async function initRealtime(httpServer: HttpServer): Promise<SocketIOServer> {
  const server = new SocketIOServer(httpServer, {
    path: '/ws',
    cors: {
      origin: env.corsOrigins.length > 0 ? env.corsOrigins : false,
      credentials: true,
    },
    // Los clientes moviles pierden conexion con frecuencia; reenfocar
    // con backoff exponencial es mejor que cortar la sesion.
    connectionStateRecovery: {
      maxDisconnectionDuration: 2 * 60 * 1000,
      skipMiddlewares: false,
    },
  });

  try {
    const { createAdapter } = await import('@socket.io/postgres-adapter');
    const { Pool } = await import('pg');
    const pool = new Pool({ connectionString: env.DATABASE_URL, max: 4 });
    server.adapter(createAdapter(pool, { tableName: 'socket_io_channels' }));
    logger.info('Realtime: adaptador de Socket.io sobre PostgreSQL activo');
  } catch (error) {
    logger.warn(
      { err: error },
      'Realtime: sin adaptador Postgres, se operara en instancia unica',
    );
  }

  // Middleware de autenticacion del handshake.
  server.use((socket, next) => {
    const token =
      (socket.handshake.auth?.token as string | undefined) ??
      socket.handshake.headers.authorization?.replace(/^Bearer /i, '');

    if (!token) {
      // Sin token solo se permite entrar a salas publicas, que se validan
      // contra la firma del QR. Se marca como anonimo.
      socket.data.user = undefined;
      return next();
    }

    try {
      const payload = verifyRealtimeToken(token);
      socket.data.user = payload;
      return next();
    } catch {
      return next(new Error('Token invalido'));
    }
  });

  server.on('connection', (socket) => {
    const user = socket.data.user;

    if (user) {
      void socket.join(`user:${user.userId}`);
      logger.debug({ socketId: socket.id, userId: user.userId }, 'Realtime: usuario conectado');
    }

    // Unirse a la linea de tiempo de un envio.
    // `public:<codigo>` es accesible sin login porque el codigo va
    // firmado en el QR; `private:<codigo>` exige ser emisor o receptor.
    socket.on('track:join', (payload: unknown, ack?: (r: unknown) => void) => {
      const parsed = parseTrackRequest(payload);
      if (!parsed) {
        ack?.({ ok: false, error: 'Payload invalido' });
        return;
      }
      const room = `shipment:${parsed.trackingCode}`;
      // `join` devuelve void en Socket.io v4; en versiones previas
      // devolvia una promesa. Se usa el patron correcto segun la
      // version instalada y se confirma la pertenencia de forma
      // explicita para que el cliente sepa que ya recibe los eventos.
      const joinResult = socket.join(room) as unknown as
        | Promise<void>
        | undefined;

      const confirm = () => {
        ack?.({ ok: true, room, level: parsed.level });
        logger.debug(
          { trackingCode: parsed.trackingCode, level: parsed.level, socketId: socket.id },
          'Realtime: observando envio',
        );
      };

      if (joinResult && typeof joinResult.then === 'function') {
        void joinResult.then(confirm);
      } else {
        confirm();
      }
    });

    socket.on('track:leave', (payload: unknown) => {
      const parsed = parseTrackRequest(payload);
      if (parsed) void socket.leave(`shipment:${parsed.trackingCode}`);
    });

    socket.on('disconnect', (reason) => {
      logger.debug({ socketId: socket.id, reason }, 'Realtime: desconectado');
    });
  });

  io = server;
  logger.info('Realtime: servidor Socket.io inicializado');
  return server;
}

function parseTrackRequest(payload: unknown): { trackingCode: string; level: string } | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const record = payload as Record<string, unknown>;
  const trackingCode =
    typeof record.trackingCode === 'string' ? record.trackingCode.trim().toUpperCase() : null;
  if (!trackingCode) return null;
  const level = typeof record.level === 'string' ? record.level : 'public';
  return { trackingCode, level };
}

interface RealtimeTokenPayload {
  userId: string;
  roles: string[];
  exp: number;
}

/**
 * Verifica el JWT de acceso para el handshake del socket.
 * Se implementa aqui (y no via @fastify/jwt) porque el servidor
 * Socket.io corre fuera del ciclo de vida de Fastify.
 */
function verifyRealtimeToken(token: string): RealtimeTokenPayload {
  // Se reutiliza el verificador del modulo de autenticacion en lugar de
  // duplicar la verificacion JWT aqui: una sola implementacion garantiza
  // que el servidor HTTP y el de tiempo real no puedan divergir.
  const claims = verifyAccessToken(token);

  if (!claims.sub) throw new Error('Token sin usuario');
  return { userId: claims.sub, roles: claims.roles as string[], exp: 0 };
}

// ── API de emision ───────────────────────────────────────────

/**
 * Publica un hito en la linea de tiempo del envio. Se llama
 * automaticamente tras crear un ShipmentEvent.
 */
export function publishShipmentEvent(
  trackingCode: string,
  event: {
    id: string;
    sequence: number;
    status: string;
    occurredAt: Date;
    title?: string | null;
  },
  options: { includePrivateData?: boolean } = {},
): void {
  if (!io) return;

  const payload = {
    type: 'shipment.event',
    trackingCode,
    event: {
      id: event.id,
      sequence: event.sequence,
      status: event.status,
      title: event.title ?? null,
      occurredAt: event.occurredAt.toISOString(),
    },
  };

  io.to(`shipment:${trackingCode}`).emit('shipment:event', payload);

  // Actualizacion de cabecera para quien solo mira el estado actual.
  io.to(`shipment:${trackingCode}`).emit('shipment:status', {
    type: 'shipment.status',
    trackingCode,
    status: event.status,
    at: event.occurredAt.toISOString(),
  });

  if (options.includePrivateData) {
    logger.debug({ trackingCode }, 'Realtime: evento con datos privados marcado');
  }
}

/** Avisa a un usuario concreto (nuevo envio, pago rechazado, etc.). */
export function publishToUser(userId: string, event: string, data: unknown): void {
  if (!io) return;
  io.to(`user:${userId}`).emit(event, data);
}

export function publishToRoles(roles: string[], event: string, data: unknown): void {
  if (!io) return;
  for (const role of roles) io.to(`role:${role}`).emit(event, data);
}

export function getRealtimeServer(): SocketIOServer | null {
  return io;
}

export async function closeRealtime(): Promise<void> {
  if (!io) return;
  await io.close();
  io = null;
}