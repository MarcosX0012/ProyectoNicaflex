import { prisma } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';
import { validationError } from '../../lib/errors.js';
import { getCourierAdapter, safeCreateShipment } from '../couriers/index.js';
import { applyStateChange } from './service.js';

/**
 * DESPACHO AL TRANSPORTISTA
 * ========================
 *
 * Registra el envio en el transportista y lo mueve a AWAITING_PICKUP.
 *
 * Decisiones importantes:
 *
 *  1. El envio se guarda en el sistema ANTES de llamar al proveedor.
 *     Si la llamada falla, queda el envio en el sistema y reintentable,
 *     en vez de perderse. El reintento es el job `syncPendingDispatches`.
 *
 *  2. La transicion a AWAITING_PICKUP ocurre DESPUES de tener el numero
 *     de seguimiento. Nunca antes: un envio sin numero de rastreo no
 *     tiene sentido logistico.
 *
 *  3. El estado previo debe permitir despacho. Un envio en transito no
 *     se vuelve a registrar.
 */

export interface DispatchResult {
  trackingNumber: string;
  providerShipmentId: string;
  labelUrl: string | null;
  estimatedDays: number | null;
}

const DISPATCHABLE_STATES = ['CONFIRMED', 'AWAITING_PAYMENT', 'AWAITING_PICKUP'];

export async function dispatchToCourier(
  shipmentId: string,
  actorId?: string,
): Promise<DispatchResult | null> {
  const shipment = await prisma.shipment.findUnique({
    where: { id: shipmentId },
    include: {
      senderAddress: true,
      recipientAddress: true,
      originBranch: { select: { code: true, name: true, city: true } },
      items: { select: { name: true, quantity: true, sku: true } },
    },
  });

  if (!shipment) throw validationError('El envio no existe');

  // Ya esta en el transportista: no se registra dos veces.
  if (shipment.courierTrackingNumber) return null;

  if (!DISPATCHABLE_STATES.includes(shipment.status)) {
    logger.debug(
      { trackingCode: shipment.trackingCode, status: shipment.status },
      'Despacho omitido: el envio no esta en un estado despachable',
    );
    return null;
  }

  // El pago pendiente bloquea el despacho, salvo que sea contra entrega.
  if (shipment.paymentStatus === 'PENDING' && shipment.paymentMethod === 'ONLINE') {
    logger.debug({ trackingCode: shipment.trackingCode }, 'Despacho omitido: pago pendiente');
    return null;
  }

  const adapter = getCourierAdapter();

  const created = await safeCreateShipment((courier) =>
    courier.createShipment({
      reference: shipment.trackingCode,
      sender: {
        contactName: shipment.senderAddress.contactName,
        phone: shipment.senderAddress.contactPhone,
        line1: shipment.senderAddress.line1,
        line2: shipment.senderAddress.line2,
        city: shipment.senderAddress.city,
        region: shipment.senderAddress.region,
        postalCode: shipment.senderAddress.postalCode,
        countryCode: shipment.senderAddress.countryCode,
      },
      recipient: {
        contactName: shipment.recipientAddress.contactName,
        phone: shipment.recipientAddress.contactPhone,
        line1: shipment.recipientAddress.line1,
        line2: shipment.recipientAddress.line2,
        city: shipment.recipientAddress.city,
        region: shipment.recipientAddress.region,
        postalCode: shipment.recipientAddress.postalCode,
        countryCode: shipment.recipientAddress.countryCode,
      },
      weightGrams: shipment.weightGrams ?? 1000,
      declaredValueCents: shipment.declaredValueCents ?? 0,
      currency: shipment.currency,
      items: shipment.items.map((i) => ({ name: i.name, quantity: i.quantity, sku: i.sku })),
      originBranchCode: shipment.originBranchId,
    }),
  );

  await prisma.shipment.update({
    where: { id: shipment.id },
    data: {
      courierCode: adapter.code,
      courierShipmentId: created.providerShipmentId,
      courierTrackingNumber: created.trackingNumber,
      courierSyncedAt: new Date(),
      lastSyncedAt: new Date(),
      courierSyncAttempts: 0,
      estimatedDeliveryAt: created.estimatedDays
        ? new Date(Date.now() + created.estimatedDays * 24 * 60 * 60 * 1000)
        : shipment.estimatedDeliveryAt,
      version: { increment: 1 },
    },
  });

  if (shipment.status !== 'AWAITING_PICKUP') {
    await applyStateChange(shipment.id, {
      to: 'AWAITING_PICKUP',
      title: 'Envio asignado al transporte',
      description: `El paquete fue registrado con ${adapter.displayName}. Numero de seguimiento: ${created.trackingNumber}`,
      locationName: shipment.originBranch?.name ?? shipment.senderAddress.city,
      source: 'SYSTEM',
      operatorId: actorId ?? null,
      idempotencyKey: `dispatch:${shipment.trackingCode}`,
      metadata: {
        courierCode: adapter.code,
        trackingNumber: created.trackingNumber,
        estimatedDays: created.estimatedDays,
      },
    });
  }

  logger.info(
    {
      trackingCode: shipment.trackingCode,
      courier: adapter.code,
      courierTrackingNumber: created.trackingNumber,
    },
    'Envio despachado al transportista',
  );

  return {
    trackingNumber: created.trackingNumber,
    providerShipmentId: created.providerShipmentId,
    // Los campos opcionales del contrato pueden venir `undefined`; el
    // tipo de retorno exige `null` para "no hay valor".
    labelUrl: created.labelUrl ?? null,
    estimatedDays: created.estimatedDays ?? null,
  };
}

/**
 * Cancela el envio tambien en el transportista. La cancelacion local
 * y la remota son pasos separados: si el proveedor falla, el envio local
 * queda CANCELLED y el job de reintento se encarga de la parte remota.
 */
export async function cancelInCourier(
  shipmentId: string,
): Promise<{ cancelled: boolean; reason?: string }> {
  const shipment = await prisma.shipment.findUnique({
    where: { id: shipmentId },
    select: { courierShipmentId: true, courierCode: true },
  });

  if (!shipment?.courierShipmentId) {
    return { cancelled: true, reason: 'El envio nunca llego al transportista' };
  }

  try {
    const adapter = getCourierAdapter();
    const ok = await adapter.cancelShipment(shipment.courierShipmentId);
    return { cancelled: ok };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Error desconocido';
    logger.warn({ shipmentId, err: message }, 'Cancelacion remota fallida; se reintentara');
    return { cancelled: false, reason: message };
  }
}

/**
 * Reintenta las cancelaciones que fallaron contra el transportista.
 * Lo invoca el worker.
 */
export async function retryPendingCancellations(batchSize = 20): Promise<{
  retried: number;
  cancelled: number;
  failed: number;
}> {
  const pending = await prisma.shipment.findMany({
    where: {
      status: 'CANCELLED',
      courierShipmentId: { not: null },
      courierTrackingNumber: { not: null },
    },
    select: { id: true, trackingCode: true, cancelReason: true },
    take: batchSize,
  });

  let cancelled = 0;
  let failed = 0;

  for (const shipment of pending) {
    const result = await cancelInCourier(shipment.id);
    if (result.cancelled) {
      cancelled += 1;
      // Se limpia el vinculo: ya no hay nada pendiente.
      await prisma.shipment.update({
        where: { id: shipment.id },
        data: { courierTrackingNumber: null, courierShipmentId: null },
      });
    } else {
      failed += 1;
    }
  }

  if (pending.length > 0) {
    logger.info({ retried: pending.length, cancelled, failed }, 'Reintento de cancelaciones');
  }

  return { retried: pending.length, cancelled, failed };
}

