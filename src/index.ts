import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { buildApp } from './app.js';
import { connectDatabase, disconnectDatabase } from './lib/prisma.js';
import { initRealtime, closeRealtime } from './lib/realtime.js';
import { initJobs, stopJobs } from './modules/jobs/scheduler.js';
import { getCourierAdapter } from './modules/couriers/index.js';

/**
 * Punto de entrada del servidor.
 *
 * Orden de arranque: base de datos primero, despues HTTP, despues
 * tiempo real y por ultimo los jobs. Si la base no responde, el
 * proceso no abre un puerto que aceptaria trafico para fallar en cada
 * peticion.
 *
 * Apagado ordenado: se deja de aceptar conexiones nuevas, se cierran
 * los trabajos en curso y se cierra la base. Sin esto, un despliegue
 * corta jobs a mitad de una transaccion.
 */

async function main(): Promise<void> {
  logger.info(
    {
      env: env.NODE_ENV,
      port: env.PORT,
      courier: env.COURIER_PROVIDER,
      whatsapp: env.WHATSAPP_ENABLED ? 'enabled' : 'disabled',
      payments: env.PAYMENTS_ENABLED ? 'enabled' : 'disabled',
    },
    'Iniciando Hossana API',
  );

  await connectDatabase();
  logger.info('Base de datos conectada');

  // Instanciar aqui y no al primer uso: si el adaptador de un
  // transportista real esta mal configurado, conviene saberlo al
  // arrancar y no a mitad del primer despacho.
  getCourierAdapter();

  const app = await buildApp();
  await app.listen({ port: env.PORT, host: env.HOST });

  logger.info(`API escuchando en http://${env.HOST}:${env.PORT}`);
  logger.info(`Documentacion en http://localhost:${env.PORT}/docs`);

  await initRealtime(app.server);
  logger.info('Servidor de tiempo real listo (Socket.io)');

  await initJobs();
  logger.info('Colas de trabajo activas (pg-boss)');

  // ── Apagado ordenado ──────────────────────────────────────
  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info({ signal }, 'Apagando el servicio...');

    // Orden inverso al de arranque, con margen para terminar lo que
    // este en curso antes de cerrar la base.
    try {
      await app.close();
      logger.info('Servidor HTTP cerrado');
    } catch (error) {
      logger.error({ err: error }, 'Error cerrando el servidor HTTP');
    }

    try {
      await stopJobs();
      logger.info('Colas de trabajo detenidas');
    } catch (error) {
      logger.error({ err: error }, 'Error cerrando las colas de trabajo');
    }

    try {
      await closeRealtime();
      logger.info('Tiempo real cerrado');
    } catch (error) {
      logger.error({ err: error }, 'Error cerrando el tiempo real');
    }

    try {
      await disconnectDatabase();
      logger.info('Base de datos desconectada');
    } catch (error) {
      logger.error({ err: error }, 'Error desconectando la base de datos');
    }

    logger.info('Apagado completo');
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  process.on('unhandledRejection', (reason) => {
    logger.error({ reason }, 'Promesa rechazada sin manejar');
  });

  process.on('uncaughtException', (error) => {
    // Una excepcion no capturada deja el proceso en estado
    // incierto: se registra y se sale. Un reinicio limpio es mejor
    // que seguir operando con memoria corrupta.
    logger.fatal({ err: error }, 'Excepcion no capturada');
    void shutdown('uncaughtException');
  });
}

main().catch((error) => {
  logger.fatal({ err: error }, 'Fallo al arrancar el servicio');
  process.exit(1);
});