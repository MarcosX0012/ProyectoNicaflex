import {
  Prisma,
  ShipmentStatus,
  type WebhookStatus,
} from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';
import { recordAudit } from '../../lib/audit.js';
import { getCourierAdapter } from '../couriers/index.js';
import { applyStateChange } from '../shipments/service.js';
import type { FastifyRequest } from 'fastify';

/**
 * INGESTA DE WEBHOOKS DE TRANSPORTISTA
 * ====================================
 *
 * Un webhook es una peticion HTTP desde fuera, de un tercero que
 * reintenta, que duplica y que a veces manda basura. Las cuatro
 * garantias que este modulo da:
 *
 *  1. VERIFICACION DE FIRMA antes de tocar nada. Un webhook sin firma
 *     valida no crea ningun evento, se registra como rechazado y no
 *     se responde 2xx (para que el proveedor deje de reintentar).
 *
 *  2. IDEMPOTENCIA por `providerEventId`. Los transportistas reenvian
 *     eventos con frecuencia: el mismo "llegó a destino" puede llegar
 *     tres veces. La restriccion UNIQUE en `shipment_events.courierEventId`
 *     hace que solo se aplique una vez, sin logica condicional y sin
 *     condiciones de carrera.
 *
 *  3. AUDITORIA DEL PAYLOAD CRUDO antes de procesarlo. Si el
 *     procesamiento falla, queda registro de que se recibio y por que
 *     no se aplico, y se puede reprocesar sin volver a pedir datos.
 *
 *  4. AISLAMIENTO DE LA MAQUINA DE ESTADOS. Un evento invalido (por
 *     ejemplo "entregado" sobre un envio ya cancelado) NO corrompe el
 *     historial: se marca el webhook como fallido y se escala.
 */

export interface WebhookProcessResult {
  status: 'processed' | 'duplicate' | 'rejected' | 'ignored';
  reason?: string;
  shipmentTrackingCode?: string;
  eventsApplied: number;
  inboxId: string;
}

export async function ingestCourierWebhook(
  providerCode: string,
  rawBody: Buffer,
  headers: Record<string, string | undefined>,
  req?: FastifyRequest,
): Promise<WebhookProcessResult> {
  const adapter = getCourierAdapter();

  // ── 1. Verificacion de firma ───────────────────────────────
  const signatureValid = adapter.verifyWebhook(rawBody, headers);

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch {
    payload = { raw: rawBody.toString('utf8').slice(0, 2000) };
  }

  const externalId = extractExternalId(payload);
  const eventType = extractEventType(payload);

  if (!signatureValid) {
    const inbox = await prisma.webhookInbox.create({
      data: {
        provider: providerCode,
        externalId,
        eventType,
        signatureValid: false,
        payload: payload as Prisma.InputJsonValue,
        status: 'REJECTED',
        error: 'Firma invalida o ausente',
        attempts: 1,
      },
      select: { id: true },
    });

    await recordAudit(
      {
        action: 'WEBHOOK_REJECTED',
        entity: 'WebhookInbox',
        entityId: inbox.id,
        outcome: 'DENIED',
        metadata: { provider: providerCode, reason: 'invalid_signature' },
      },
      req,
    );

    logger.warn(
      { provider: providerCode, inboxId: inbox.id, externalId },
      'Webhook rechazado: firma invalida',
    );

    // Se devuelve 403 para que el proveedor deje de reintentar: si la
    // firma no es valida, reintentar nunca va a funcionar.
    throw new SignatureVerificationError(inbox.id);
  }

  // ── 2. Deteccion de duplicado en la entrada ────────────────
  if (externalId) {
    const existing = await prisma.webhookInbox.findUnique({
      where: { provider_externalId: { provider: providerCode, externalId } },
    });

    if (existing && existing.status === 'PROCESSED') {
      logger.info(
        { provider: providerCode, externalId },
        'Webhook duplicado: ya fue procesado',
      );
      return { status: 'duplicate', reason: 'already_processed', eventsApplied: 0, inboxId: existing.id };
    }
  }

  // ── 3. Registro del payload crudo ──────────────────────────
  const inbox = await prisma.webhookInbox.upsert({
    where: externalId
      ? { provider_externalId: { provider: providerCode, externalId } }
      : { id: `tmp_${providerCode}_${Date.now()}` },
    create: {
      provider: providerCode,
      externalId,
      eventType,
      signatureValid: true,
      payload: payload as Prisma.InputJsonValue,
      status: 'RECEIVED',
    },
    update: { attempts: { increment: 1 }, payload: payload as Prisma.InputJsonValue },
    select: { id: true },
  });

  // ── 4. Normalizacion a eventos del sistema ─────────────────
  // Un adaptador con formato de payload propio puede normalizarlo
  // directamente; si no, se usa el normalizador generico.
  const normalize = adapter.normalizeWebhook ?? normalizeGenericWebhook;
  const normalized = normalize.call(adapter, payload, adapter);

  if (!normalized || normalized.events.length === 0) {
    await prisma.webhookInbox.update({
      where: { id: inbox.id },
      data: { status: 'IGNORED', processedAt: new Date(), error: 'Sin eventos mapeables' },
    });
    return { status: 'ignored', reason: 'no_mappable_events', eventsApplied: 0, inboxId: inbox.id };
  }

  // ── 5. Aplicacion de los eventos ───────────────────────────
  let eventsApplied = 0;
  const errors: string[] = [];

  for (const event of normalized.events) {
    const shipment = await resolveShipment(normalized, event);

    if (!shipment) {
      errors.push(`No se encontro envio para ${normalized.trackingNumber ?? '?'}`);
      continue;
    }

    try {
      const result = await applyStateChange(shipment.id, {
        to: event.status,
        description: event.description ?? undefined,
        locationName: event.locationName ?? undefined,
        occurredAt: event.occurredAt,
        source: 'WEBHOOK',
        // ESTA es la clave de idempotencia. Unica en la BD.
        courierEventId: event.providerEventId,
        metadata: { provider: providerCode, raw: event.raw ?? null },
      });

      if (result.changed) {
        eventsApplied += 1;
        logger.info(
          {
            trackingCode: result.trackingCode,
            status: event.status,
            provider: providerCode,
            providerEventId: event.providerEventId,
          },
          'Webhook: evento aplicado a la linea de tiempo',
        );
      } else {
        logger.info(
          { trackingCode: result.trackingCode, providerEventId: event.providerEventId },
          'Webhook: evento ya existia (idempotente)',
        );
      }
    } catch (error) {
      // Un evento invalido (transicion no permitida) NO detiene el
      // resto: se registra y se sigue. Perder los demas eventos por
      // uno malo seria peor.
      const message = error instanceof Error ? error.message : 'Error desconocido';
      errors.push(`${event.providerEventId}: ${message}`);

      logger.warn(
        {
          trackingCode: shipment.trackingCode,
          to: event.status,
          provider: providerCode,
          err: error,
        },
        'Webhook: evento rechazado por la maquina de estados',
      );
    }
  }

  // ── 6. Cierre del registro ─────────────────────────────────
  const finalStatus: WebhookStatus =
    eventsApplied > 0 ? 'PROCESSED' : errors.length > 0 ? 'FAILED' : 'DUPLICATE';

  await prisma.webhookInbox.update({
    where: { id: inbox.id },
    data: {
      status: finalStatus,
      processedAt: new Date(),
      error: errors.length > 0 ? errors.join(' | ').slice(0, 1000) : null,
    },
  });

  await recordAudit(
    {
      action: 'WEBHOOK_PROCESSED',
      entity: 'WebhookInbox',
      entityId: inbox.id,
      metadata: {
        provider: providerCode,
        status: finalStatus,
        eventsApplied,
        errors: errors.length,
        trackingCode: normalized.trackingNumber ?? null,
      },
    },
    req,
  );

  if (errors.length > 0) {
    throw new WebhookProcessingError(inbox.id, errors);
  }

  return {
    status: 'processed',
    eventsApplied,
    inboxId: inbox.id,
    shipmentTrackingCode: normalized.trackingNumber ?? undefined,
  };
}

interface NormalizedWebhook {
  /** Numero de seguimiento del transportista. */
  trackingNumber?: string;
  /** Referencia interna que enviamos al transportista (trackingCode). */
  reference?: string;
  events: Array<{
    providerEventId: string;
    status: ShipmentStatus;
    description?: string | null;
    locationName?: string | null;
    occurredAt: Date;
    raw?: unknown;
  }>;
}

/**
 * Normalizador generico. Lee las formas mas comunes de payload de
 * transportista. El adaptador especifico puede sobrescribirlo con
 * `normalizeWebhook` cuando su formato se aparte de lo habitual.
 */
function normalizeGenericWebhook(
  payload: unknown,
  adapter: { mapStatus(s: string): ShipmentStatus | null },
): NormalizedWebhook | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const record = payload as Record<string, unknown>;

  const data = (record.data as Record<string, unknown> | undefined) ?? record;
  const trackingNumber =
    (data.tracking_number as string | undefined) ??
    (data.tracking_code as string | undefined) ??
    (data.trackingNumber as string | undefined) ??
    (record.tracking_number as string | undefined) ??
    undefined;

  const reference =
    (data.order_code as string | undefined) ??
    (data.reference as string | undefined) ??
    (data.orderCode as string | undefined) ??
    undefined;

  const rawEvents = Array.isArray(data.events)
    ? (data.events as Array<Record<string, unknown>>)
    : [];

  const events: NormalizedWebhook['events'] = [];

  for (const raw of rawEvents) {
    const providerStatus = String(raw.status ?? raw.state ?? '');
    const mapped = adapter.mapStatus(providerStatus);
    if (!mapped) continue;

    const dateValue = raw.date ?? raw.created_at ?? raw.timestamp ?? raw.occurred_at;
    const occurredAt = dateValue ? new Date(String(dateValue)) : new Date();
    if (Number.isNaN(occurredAt.getTime())) continue;

    const id = raw.id ?? raw.event_id ?? raw.uuid;
    events.push({
      providerEventId: id
        ? String(id)
        : `gen_${Date.parse(occurredAt.toISOString())}_${providerStatus}`,
      status: mapped,
      description: (raw.description as string | undefined) ?? (raw.message as string | undefined) ?? null,
      locationName: (raw.location as string | undefined) ?? (raw.city as string | undefined) ?? null,
      occurredAt,
      raw,
    });
  }

  if (events.length === 0 && typeof data.status === 'string') {
    const mapped = adapter.mapStatus(data.status);
    if (mapped) {
      events.push({
        providerEventId: `gen_single_${trackingNumber ?? 'unknown'}_${data.status}`,
        status: mapped,
        occurredAt: new Date(),
        description: (data.description as string | undefined) ?? null,
        locationName: (data.location as string | undefined) ?? null,
        raw: payload,
      });
    }
  }

  return { trackingNumber, reference, events };
}

async function resolveShipment(
  normalized: NormalizedWebhook,
  event: { providerEventId: string },
) {
  void event;

  if (normalized.trackingNumber) {
    const byCourier = await prisma.shipment.findFirst({
      where: { courierTrackingNumber: normalized.trackingNumber },
      select: { id: true, trackingCode: true },
    });
    if (byCourier) return byCourier;
  }

  if (normalized.reference) {
    // La referencia que mandamos es el trackingCode interno.
    const byCode = await prisma.shipment.findUnique({
      where: { trackingCode: normalized.reference },
      select: { id: true, trackingCode: true },
    });
    if (byCode) return byCode;
  }

  return null;
}

function extractExternalId(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const record = payload as Record<string, unknown>;
  const data = (record.data as Record<string, unknown> | undefined) ?? record;
  const id = data.id ?? data.event_id ?? data.uuid ?? record.id;
  return id ? String(id) : null;
}

function extractEventType(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const record = payload as Record<string, unknown>;
  const type = record.type ?? record.event ?? record.event_type;
  return type ? String(type) : null;
}

// ── Errores de webhook ───────────────────────────────────────

export class SignatureVerificationError extends Error {
  constructor(public readonly inboxId: string) {
    super('Firma de webhook invalida');
    this.name = 'SignatureVerificationError';
  }
}

export class WebhookProcessingError extends Error {
  constructor(
    public readonly inboxId: string,
    public readonly errors: string[],
  ) {
    super(`El webhook se recibio pero contiene ${errors.length} evento(s) invalido(s)`);
    this.name = 'WebhookProcessingError';
  }
}

// ── Reprocesamiento ──────────────────────────────────────────

/**
 * Reintenta procesar un webhook ya registrado. Necesario cuando un
 * evento fue rechazado por una transicion no permitida y un admin
 * corrige el estado del envio a mano: sin esto, el evento se pierde.
 */
export async function reprocessWebhook(inboxId: string, actorId: string): Promise<{
  reprocessed: boolean;
  reason?: string;
}> {
  const record = await prisma.webhookInbox.findUnique({ where: { id: inboxId } });

  if (!record) return { reprocessed: false, reason: 'Webhook no encontrado' };
  if (!record.signatureValid) {
    return { reprocessed: false, reason: 'No se reprocesa un webhook con firma invalida' };
  }
  if (record.status === 'PROCESSED') {
    return { reprocessed: false, reason: 'El webhook ya fue procesado' };
  }

  const adapter = getCourierAdapter();
  const normalized = normalizeGenericWebhook(record.payload, adapter);

  if (!normalized) return { reprocessed: false, reason: 'Payload no interpretable' };

  let applied = 0;
  const remaining: string[] = [];

  for (const event of normalized.events) {
    const shipment = await resolveShipment(normalized, event);
    if (!shipment) {
      remaining.push(`${event.providerEventId}: envio no encontrado`);
      continue;
    }
    try {
      const result = await applyStateChange(shipment.id, {
        to: event.status,
        description: event.description ?? undefined,
        locationName: event.locationName ?? undefined,
        occurredAt: event.occurredAt,
        source: 'WEBHOOK',
        courierEventId: event.providerEventId,
        metadata: { provider: record.provider, reprocessed: true },
      });
      if (result.changed) applied += 1;
    } catch (error) {
      remaining.push(`${event.providerEventId}: ${error instanceof Error ? error.message : 'error'}`);
    }
  }

  await prisma.webhookInbox.update({
    where: { id: inboxId },
    data: {
      status: remaining.length === 0 ? 'PROCESSED' : 'FAILED',
      error: remaining.length > 0 ? remaining.join(' | ').slice(0, 1000) : null,
      attempts: { increment: 1 },
      processedAt: new Date(),
    },
  });

  await recordAudit({
    userId: actorId,
    action: 'WEBHOOK_REPROCESSED',
    entity: 'WebhookInbox',
    entityId: inboxId,
    metadata: { applied, remaining: remaining.length },
  });

  logger.info(
    { inboxId, applied, actorId },
    'Webhook reprocesado por intervencion manual',
  );

  return { reprocessed: remaining.length === 0, reason: remaining.length > 0 ? remaining.join(' | ') : undefined };
}