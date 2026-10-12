import { prisma } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';
import { getCourierAdapter } from '../couriers/index.js';
import { applyStateChange } from '../shipments/service.js';
import { isActive } from '../shipments/stateMachine.js';

/**
 * SINCRONIZACION CON EL TRANSPORTISTA
 * ===================================
 *
 * Los webhooks son el canal principal, pero no son suficientes:
 *
 *  - Un transportista puede no tener webhooks (se resuelve con polling).
 *  - Aunque los tenga, a veces entrega el webhook de forma intermitente.
 *  - Si el sistema estuvo caido cuando llego un evento, el webhook se
 *    entrego mientras no habia quien lo recibiera.
 *
 * Este trabajo recorre periodicamente los envios activos y consulta su
 * estado. Es la red de seguridad que garantiza que la linea de tiempo
 * se complete sola.
 *
 * Idempotencia: cada evento del proveedor se aplica con su
 * `providerEventId` como clave unica, asi que repetir la sincronizacion
 * no duplica hitos ni altera el historial.
 */

export interface SyncResult {
  scanned: number;
  updated: number;
  errors: number;
  skipped: number;
}

export async function syncActiveShipments(options: { batchSize?: number } = {}): Promise<SyncResult> {
  const batchSize = options.batchSize ?? 100;

  const adapter = getCourierAdapter();
  const result: SyncResult = { scanned: 0, updated: 0, errors: 0, skipped: 0 };

  // Solo envios que ya estan en manos del transportista: antes de eso
  // no hay nada que consultar.
  const shipments = await prisma.shipment.findMany({
    where: {
      courierTrackingNumber: { not: null },
      status: {
        in: ['PICKED_UP', 'IN_TRANSIT', 'AT_DISTRIBUTION_CENTER', 'OUT_FOR_DELIVERY', 'DELIVERY_ATTEMPTED', 'ON_HOLD', 'EXCEPTION'],
      },
    },
    select: {
      id: true,
      trackingCode: true,
      status: true,
      courierTrackingNumber: true,
      lastSyncedAt: true,
    },
    orderBy: { lastSyncedAt: { sort: 'asc', nulls: 'first' } },
    take: batchSize,
  });

  for (const shipment of shipments) {
    result.scanned += 1;

    // Un envio sincronizado hace menos de 2 minutos se deja estar: el
    // webhook ya lo trajo y no tiene sentido interrogar al proveedor.
    if (shipment.lastSyncedAt && Date.now() - shipment.lastSyncedAt.getTime() < 2 * 60 * 1000) {
      result.skipped += 1;
      continue;
    }

    try {
      const tracking = await adapter.getTracking(shipment.courierTrackingNumber!);

      for (const event of tracking.events) {
        const applied = await applyStateChange(shipment.id, {
          to: event.status,
          description: event.description ?? undefined,
          locationName: event.locationName ?? undefined,
          occurredAt: event.occurredAt,
          source: 'COURIER_API',
          courierEventId: event.providerEventId,
          metadata: { provider: adapter.code, syncedBy: 'poll' },
        });

        if (applied.changed) result.updated += 1;
      }

      await prisma.shipment.update({
        where: { id: shipment.id },
        data: { lastSyncedAt: new Date() },
      });
    } catch (error) {
      result.errors += 1;
      logger.warn(
        {
          trackingCode: shipment.trackingCode,
          err: error instanceof Error ? error.message : 'error',
        },
        'Sincronizacion: fallo al consultar el transportista',
      );
    }
  }

  if (result.scanned > 0) {
    logger.info({ ...result, provider: adapter.code }, 'Sincronizacion completada');
  }

  return result;
}

/**
 * Marca los envios sin numero de courier que ya estan listos para
 * despacho, para reintentar su registro tras una falla del proveedor.
 */
export async function syncPendingDispatches(batchSize = 20): Promise<SyncResult> {
  const result: SyncResult = { scanned: 0, updated: 0, errors: 0, skipped: 0 };

  const pending = await prisma.shipment.findMany({
    where: {
      courierTrackingNumber: null,
      status: { in: ['CONFIRMED', 'AWAITING_PAYMENT'] },
      paymentStatus: { in: ['PAID', 'NOT_REQUIRED'] },
    },
    select: { id: true, trackingCode: true },
    take: batchSize,
  });

  const { dispatchToCourier } = await import('../shipments/dispatch.js');

  for (const shipment of pending) {
    result.scanned += 1;
    try {
      const dispatched = await dispatchToCourier(shipment.id);
      if (dispatched) result.updated += 1;
      else result.skipped += 1;
    } catch (error) {
      result.errors += 1;
      logger.warn(
        {
          trackingCode: shipment.trackingCode,
          err: error instanceof Error ? error.message : 'error',
        },
        'Sincronizacion: fallo al despachar al transportista',
      );
    }
  }

  return result;
}

// ── Alertas de sincronizacion ────────────────────────────────

/**
 * Envios que el transportista no confirma. Son envios con varios
 * intentos fallidos o sincronizados hace mucho: el panel los muestra
 * porque son la senal de que algo del lado del proveedor se rompio.
 */
export async function findSyncFailures(): Promise<
  Array<{ trackingCode: string; attempts: number; lastError: string | null; status: string }>
> {
  const rows = await prisma.shipment.findMany({
    where: {
      courierSyncAttempts: { gte: 3 },
    },
    select: {
      trackingCode: true,
      courierSyncAttempts: true,
      lastSyncError: true,
      status: true,
    },
    orderBy: { courierSyncAttempts: 'desc' },
    take: 100,
  });

  // Se renombran los campos al nombre que entiende el panel, para que
  // la forma de la respuesta no dependa del nombre de las columnas.
  return rows.map((row) => ({
    trackingCode: row.trackingCode,
    attempts: row.courierSyncAttempts,
    lastError: row.lastSyncError,
    status: row.status,
  }));
}

export { isActive };