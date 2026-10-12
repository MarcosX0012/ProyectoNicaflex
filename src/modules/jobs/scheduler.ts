import PgBoss from 'pg-boss';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { prisma } from '../../lib/prisma.js';
import { purgeExpiredTokens } from '../auth/tokens.js';
import { syncActiveShipments, syncPendingDispatches } from '../courierSync/service.js';
import { retryPendingCancellations } from '../shipments/dispatch.js';
import { dispatchNotification } from '../notifications/service.js';

/**
 * COLAS DE TRABAJO
 * ================
 *
 * pg-boss usa Postgres como cola, no Redis. En este despliegue es lo
 * correcto: ya hay una base de datos, y una cola sobre Postgres hereda
 * su durabilidad y sus transacciones. Se paga en throughput, que aqui
 * no es el cuello de botella.
 *
 * Que se ejecuta y cada cuanto:
 *
 *   courier-poll         2 min   Respaldo de webhooks: consulta el estado
 *                                 de los envios activos al transportista.
 *   courier-dispatch     1 min   Reintenta despachar envios cuyo registro
 *                                 en el proveedor fallo.
 *   courier-cancel       5 min   Reintenta cancelaciones remotas pendientes.
 *   notifications-retry  1 min   Reintenta notificaciones en cola.
 *   cleanup-tokens       1 hora  Borra tokens y OTPs expirados.
 *
 * Por que la API NO espera a estos trabajos: el usuario recibe respuesta
 * inmediata y el trabajo pesado ocurre despues. Un rastreo no puede
 * depender de que el transportista responda.
 */

let boss: PgBoss | null = null;

export const QUEUES = {
  courierPoll: 'courier-poll',
  courierDispatch: 'courier-dispatch',
  courierCancel: 'courier-cancel',
  notificationRetry: 'notification-retry',
  cleanupTokens: 'cleanup-tokens',
} as const;

export async function initJobs(): Promise<PgBoss> {
  if (boss) return boss;

  const instance = new PgBoss({
    connectionString: env.DATABASE_URL,
    schema: 'pgboss',
    // `expireInSeconds` evita que un trabajo que murio a medias bloquee
    // la cola para siempre. Si el proceso se cae durante el trabajo,
    // pg-boss lo reintentara al vencer.
    expireInSeconds: 300,
    retryLimit: 3,
    retryDelay: 30,
  });

  instance.on('error', (error) => logger.error({ err: error }, 'pg-boss: error'));

  await instance.start();
  boss = instance;

  await createQueues(instance);
  await registerHandlers(instance);
  await scheduleRecurring(instance);

  logger.info('Jobs: planificador iniciado (pg-boss sobre PostgreSQL)');
  return instance;
}

/**
 * Crea las colas antes de usarlas.
 *
 * pg-boss v10 ya no crea la cola en el primer uso: `schedule`, `send`
 * y `work` fallan con "Queue X not found" porque `schedule` tiene
 * clave foranea hacia `queue`. Sin esto, el arranque seguia adelante
 * pero NINGUN trabajo recurrente quedaba programado ni se encolaba
 * nada (el error solo aparecia como warning).
 *
 * `create_queue` usa ON CONFLICT DO NOTHING: repetirlo en cada
 * arranque no duplica nada.
 */
async function createQueues(instance: PgBoss): Promise<void> {
  for (const name of Object.values(QUEUES)) {
    await instance.createQueue(name, {
      name,
      expireInSeconds: 300,
      retryLimit: 3,
      retryDelay: 30,
    });
  }
}

async function registerHandlers(instance: PgBoss): Promise<void> {
  // Respaldo de webhooks.
  await instance.work(QUEUES.courierPoll, async () => {
    const result = await syncActiveShipments({ batchSize: 100 });
    logger.debug({ ...result }, 'Job: courier-poll');
    return result;
  });

  // Reintento de despachos fallidos.
  await instance.work(QUEUES.courierDispatch, async () => {
    const result = await syncPendingDispatches(20);
    logger.debug({ ...result }, 'Job: courier-dispatch');
    return result;
  });

  // Reintento de cancelaciones remotas.
  await instance.work(QUEUES.courierCancel, async () => {
    const result = await retryPendingCancellations(20);
    logger.debug({ ...result }, 'Job: courier-cancel');
    return result;
  });

  // Notificaciones que quedaron en cola por un fallo de envio.
  await instance.work(QUEUES.notificationRetry, async () => {
    const pending = await prisma.notification.findMany({
      where: { status: 'QUEUED', attempts: { lt: 5 } },
      select: { id: true },
      orderBy: { queuedAt: 'asc' },
      take: 25,
    });

    let sent = 0;
    let failed = 0;

    for (const notification of pending) {
      const result = await dispatchNotification(notification.id);
      if (result.status === 'SENT') sent += 1;
      else if (result.status === 'FAILED') failed += 1;
    }

    if (pending.length > 0) {
      logger.info({ processed: pending.length, sent, failed }, 'Job: notifications-retry');
    }
    return { processed: pending.length, sent, failed };
  });

  // Limpieza periodica.
  await instance.work(QUEUES.cleanupTokens, async () => {
    const purged = await purgeExpiredTokens();
    logger.info(purged, 'Job: cleanup-tokens');
    return purged;
  });
}

/**
 * Programa un trabajo recurrente.
 *
 * `singleton` con clave propia evita que dos instancias del API
 * programen el mismo trabajo y este se ejecute N veces: al desplegar
 * dos réplicas, el respaldo de webhooks correria en ambas.
 */
async function scheduleRecurring(instance: PgBoss): Promise<void> {
  const plan: Array<{ name: string; cron: string }> = [
    { name: QUEUES.courierPoll, cron: '*/2 * * * *' },
    { name: QUEUES.courierDispatch, cron: '* * * * *' },
    { name: QUEUES.courierCancel, cron: '*/5 * * * *' },
    { name: QUEUES.notificationRetry, cron: '* * * * *' },
    { name: QUEUES.cleanupTokens, cron: '0 * * * *' },
  ];

  for (const { name, cron } of plan) {
    try {
      await instance.schedule(name, cron, {}, { singletonKey: name });
    } catch (error) {
      // Si el planificador ya tiene el trabajo (por ejemplo, tras un
      // reinicio sin limpiar el esquema), se registra y se continua:
      // que un respaldo falle no debe impedir arrancar el API.
      logger.warn({ err: error, job: name }, 'Jobs: no se pudo programar el trabajo');
    }
  }
}

/** Encola un trabajo inmediato. Se usa desde los servicios. */
export async function enqueue(
  queue: keyof typeof QUEUES,
  data: Record<string, unknown> = {},
): Promise<void> {
  if (!boss) {
    logger.warn({ queue }, 'Jobs: planificador no inicializado, trabajo no encolado');
    return;
  }
  await boss.send(queue, data);
}

export async function stopJobs(): Promise<void> {
  if (!boss) return;
  await boss.stop({ timeout: 10000 });
  boss = null;
}

export function getJobs(): PgBoss | null {
  return boss;
}