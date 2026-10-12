import type { FastifyInstance } from 'fastify';
import { getPublicTracking, getPublicTrackingSummary } from '../modules/shipments/publicTracking.js';
import { getTimeline } from '../modules/shipments/service.js';
import { getCourierAdapter } from '../modules/couriers/index.js';

/**
 * RASTREO PUBLICO
 * ===============
 *
 * Endpoints sin autenticacion a los que apunta el QR pegado en el
 * paquete.
 *
 * LIMITE DE TASA ESTRICTO. Esta es la superficie mas expuesta del
 * sistema: los codigos tienen un formato predecible (HOS-2026-000123),
 * asi que sin limite un atacante podria enumerarlos y ver cuantos envios
 * tiene la empresa, cuando se crearon y si ya fueron entregados. El
 * limite es de 20 peticiones por minuto por IP.
 *
 * Se responde 404 (no 403) cuando el codigo existe pero el usuario no
 * es parte del envio: confirmar que un codigo existe ya es informacion.
 */

export async function trackingRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/:code',
    {
      config: {
        rateLimit: { max: 20, timeWindow: '1 minute' },
      },
      schema: {
        tags: ['tracking'],
        summary: 'Rastreo publico por codigo',
        description:
          'Devuelve estado, hitos y fecha estimada. NO expone nombres, ' +
          'direcciones, contenido del paquete ni datos del receptor.',
      },
    },
    async (req) => {
      const { code } = req.params as { code: string };
      const result = await getPublicTracking(code, req);
      return { data: result };
    },
  );

  app.get(
    '/:code/timeline',
    {
      config: {
        rateLimit: { max: 20, timeWindow: '1 minute' },
      },
      schema: {
        tags: ['tracking'],
        summary: 'Linea de tiempo publica (paginada)',
      },
    },
    async (req) => {
      const { code } = req.params as { code: string };
      const query = (req.query ?? {}) as { limit?: string; cursor?: string };

      // `getTimeline` audita el acceso, que es lo que permite detectar
      // intentos de enumeracion a posteriori.
      const timeline = await getTimeline(
        code,
        {
          limit: query.limit ? Number(query.limit) : undefined,
          cursor: query.cursor ? Number(query.cursor) : undefined,
        },
        req,
      );

      // Sin actor, `visibility` es PUBLIC y getTimeline ya omite
      // operador y metadatos. Aqui se refuerza quitando la ubicacion
      // exacta, que en combinacion con el nombre del operador permite
      // localizar a un repartidor.
      return {
        data: timeline.map((event) => ({
          sequence: event.sequence,
          status: event.status,
          statusLabel: event.statusLabel,
          statusIcon: event.statusIcon,
          statusTone: event.statusTone,
          title: event.title,
          description: event.description,
          occurredAt: event.occurredAt,
          source: event.source,
        })),
      };
    },
  );

  app.get(
    '/:code/summary',
    {
      config: {
        rateLimit: { max: 30, timeWindow: '1 minute' },
      },
      schema: {
        tags: ['tracking'],
        summary: 'Consulta rapida: solo estado actual',
        description:
          'Para la pantalla de consulta previa. No expone la linea de tiempo.',
      },
    },
    async (req) => {
      const { code } = req.params as { code: string };
      return { data: await getPublicTrackingSummary(code) };
    },
  );

  // Estado del servicio de rastreo: util para verificar que el QR
  // apunta a una instancia viva sin revelar nada del negocio.
  app.get(
    '/health/tracking',
    {
      schema: {
        tags: ['tracking'],
        summary: 'Estado del subsistema de rastreo',
      },
    },
    async () => {
      const adapter = getCourierAdapter();
      return {
        data: {
          status: 'operational',
          courier: { code: adapter.code, displayName: adapter.displayName },
          realtime: 'websocket://…/ws',
        },
      };
    },
  );
}