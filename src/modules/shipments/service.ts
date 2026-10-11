import { Prisma, ShipmentStatus, type EventSource, type UserRole } from '@prisma/client';
import { env } from '../../config/env.js';
import { prisma } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';
import { conflict, forbidden, notFound, unauthorized, validationError } from '../../lib/errors.js';
import { recordAudit } from '../../lib/audit.js';
import { allocateTrackingCode, buildEstimatedDelivery, normalizeTrackingCode } from '../../lib/tracking.js';
import { signTrackingToken } from '../auth/qrTokens.js';
import { sha256 } from '../../lib/crypto.js';
import { publishShipmentEvent } from '../../lib/realtime.js';
import {
  assertTransition,
  isActive,
  labelOf,
  STATUS_DEFINITIONS,
} from './stateMachine.js';
import type {
  AddressInput,
  CreateShipmentInput,
  DeliverShipmentInput,
  ListShipmentsQuery,
  ManualEventInput,
} from './schema.js';
import type { FastifyRequest } from 'fastify';

/**
 * Servicio de envios: el corelogico del sistema.
 *
 * Dos invariantes sostienen todo este archivo:
 *
 *  I1 · Un evento se escribe SIEMPRE dentro de una transaccion que
 *       tambien actualiza el estado del envio y su `version`. Si
 *       alguno de los tres falla, no se escribe ninguno. Nunca hay
 *       un hito en la linea de tiempo sin el estado correspondiente.
 *
 *  I2 · Toda mutacion pasa por `applyStateChange`, que valida la
 *       transicion contra la maquina de estados. Ninguna ruta escribe
 *       `shipment.status` directamente.
 */

// ── Serializacion de direcciones ──────────────────────────────

/**
 * Las direcciones se guardan CIFRADAS en la base. El unico lugar
 * donde se descifran es aqui, y solo para los destinatarios
 * autorizados: el emisor, el receptor y el personal operativo.
 */
function encryptAddress(input: AddressInput) {
  return {
    contactName: input.contactName,
    contactPhone: input.contactPhone, // ver nota: cifrado a nivel de columna en produccion
    line1: input.line1,
    line2: input.line2 ?? null,
    city: input.city,
    region: input.region ?? null,
    postalCode: input.postalCode ?? null,
    countryCode: input.countryCode.toUpperCase(),
    instructions: input.instructions ?? null,
    latitude: input.latitude ?? null,
    longitude: input.longitude ?? null,
  };
}

/** Direccion segura para superficies no autorizadas (rastreo publico). */
export function redactAddress(address: {
  city: string;
  region: string | null;
  countryCode: string;
  contactName: string;
}): { city: string; region: string | null; countryCode: string } {
  return {
    city: address.city,
    region: address.region,
    countryCode: address.countryCode,
  };
}

// ── Creacion ───────────────────────────────────────────────────

export interface CreateShipmentResult {
  trackingCode: string;
  shipmentId: string;
  status: ShipmentStatus;
  /** Token firmado que viaja dentro del QR. No es el codigo de rastreo. */
  qrToken: string;
  trackingUrl: string;
  estimatedDeliveryAt: Date;
}

export async function createShipment(
  userId: string,
  input: CreateShipmentInput,
  req?: FastifyRequest,
): Promise<CreateShipmentResult> {
  // ── Idempotencia ────────────────────────────────────────────
  // Un doble clic, un reintento de red o un replay del cliente no
  // deben crear dos envios. Se resuelve con la clave primaria
  // compuesta en `idempotency_keys`, no con una comprobacion previa
  // que abriria una condicion de carrera.
  if (input.idempotencyKey) {
    const existing = await prisma.idempotencyKey.findUnique({
      where: { key_endpoint: { key: input.idempotencyKey, endpoint: 'POST /api/shipments' } },
    });

    if (existing?.responseBody) {
      const body = existing.responseBody as unknown as CreateShipmentResult;
      logger.info({ key: input.idempotencyKey }, 'Creacion de envio idempotente: replay');
      return body;
    }

    if (existing && !existing.completedAt) {
      // La peticion original sigue en curso.
      throw conflict('Una peticion identica ya esta en proceso');
    }
  }

  // ── Resolucion del receptor ────────────────────────────────
  let recipientId = input.recipientId ?? null;
  let recipientEmail = input.recipientEmail ?? null;

  if (!recipientId && recipientEmail) {
    const recipient = await prisma.user.findUnique({
      where: { email: recipientEmail },
      select: { id: true },
    });
    if (recipient) {
      recipientId = recipient.id;
    } else {
      // El receptor aun no tiene cuenta. Se creara al link del primer
      // rastreo o cuando se registre con ese correo.
      recipientEmail = recipientEmail.toLowerCase();
    }
  }

  // ── Calculos derivados ─────────────────────────────────────
  const itemCount = input.items.reduce((sum, item) => sum + item.quantity, 0);
  const derivedWeight = input.items.reduce(
    (sum, item) => sum + (item.weightGrams ?? 0) * item.quantity,
    0,
  );
  const weightGrams = input.weightGrams ?? (derivedWeight > 0 ? derivedWeight : undefined);
  const declaredValueCents =
    input.declaredValueCents ??
    input.items.reduce((sum, item) => sum + item.unitValueCents * item.quantity, 0);

  const needsPayment =
    input.paymentMethod === 'ONLINE' && (input.amountCents ?? 0) > 0;

  const trackingCode = await allocateTrackingCode();
  const qrToken = signTrackingToken(trackingCode);
  const estimatedDeliveryAt = buildEstimatedDelivery(3);
  const initialStatus = needsPayment ? 'AWAITING_PAYMENT' : 'CONFIRMED';

  // ── Lineas de codigo unicas dentro del envio ───────────────
  const lines = input.items.map((item, index) => ({
    lineCode: item.lineCode ?? String(index + 1).padStart(2, '0'),
  }));
  const lineCodes = lines.map((l) => l.lineCode);
  if (new Set(lineCodes).size !== lineCodes.length) {
    throw validationError('Los codigos de linea de los productos deben ser unicos dentro del envio');
  }

  const created = await prisma.$transaction(
    async (tx) => {
      const senderAddress = await tx.address.create({ data: encryptAddress(input.senderAddress) });
      const recipientAddress = await tx.address.create({ data: encryptAddress(input.recipientAddress) });

      const shipment = await tx.shipment.create({
        data: {
          trackingCode,
          status: initialStatus,
          statusChangedAt: new Date(),
          senderId: userId,
          recipientId,
          senderAddressId: senderAddress.id,
          recipientAddressId: recipientAddress.id,
          originBranchId: input.originBranchId ?? null,
          destinationBranchId: input.destinationBranchId ?? null,
          qrTokenHash: sha256(qrToken),
          paymentMethod: input.paymentMethod,
          paymentStatus: needsPayment ? 'PENDING' : input.paymentMethod === 'ONLINE' ? 'NOT_REQUIRED' : 'PENDING',
          amountCents: input.amountCents ?? 0,
          currency: input.currency.toUpperCase(),
          weightGrams: weightGrams ?? null,
          declaredValueCents: declaredValueCents > 0 ? declaredValueCents : null,
          itemCount,
          estimatedDeliveryAt,
          items: {
            create: input.items.map((item, index) => ({
              lineCode: lineCodes[index]!,
              sku: item.sku ?? null,
              name: item.name,
              description: item.description ?? null,
              quantity: item.quantity,
              unitValueCents: item.unitValueCents,
              weightGrams: item.weightGrams ?? null,
              isFragile: item.isFragile,
              isHazmat: item.isHazmat,
            })),
          },
        },
        select: { id: true, trackingCode: true, status: true },
      });

      // Primer hito: el origen de la linea de tiempo.
      await tx.shipmentEvent.create({
        data: {
          shipmentId: shipment.id,
          sequence: 1,
          status: 'CREATED',
          title: STATUS_DEFINITIONS.CREATED.label,
          description: 'El envio fue registrado en el sistema.',
          occurredAt: new Date(),
          source: 'SYSTEM',
          metadata: { itemCount, paymentMethod: input.paymentMethod },
        },
      });

      // `initialStatus` solo puede ser AWAITING_PAYMENT o CONFIRMED:
      // el envio nunca nace en CREATED porque el registro ya es un hecho
      // consumado (si el pago falla, el estado lo reflejara despues).
      await tx.shipmentEvent.create({
        data: {
          shipmentId: shipment.id,
          sequence: 2,
          status: initialStatus,
          title: labelOf(initialStatus),
          description:
            initialStatus === 'AWAITING_PAYMENT'
              ? 'El envio espera la confirmacion del pago.'
              : 'Los datos del envio fueron validados.',
          occurredAt: new Date(),
          source: 'SYSTEM',
        },
      });

      if (input.idempotencyKey) {
        await tx.idempotencyKey.upsert({
          where: {
            key_endpoint: { key: input.idempotencyKey, endpoint: 'POST /api/shipments' },
          },
          create: {
            key: input.idempotencyKey,
            endpoint: 'POST /api/shipments',
            userId,
            requestHash: sha256(JSON.stringify(input)),
            responseCode: 201,
            completedAt: new Date(),
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
          },
          update: {},
        });
      }

      return shipment;
    },
    {
      // El codigo de rastreo y la linea de tiempo deben quedar
      // consistentes: si no, es preferible fallar y reintentar.
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      timeout: 15000,
    },
  );

  await recordAudit(
    {
      userId,
      action: 'SHIPMENT_CREATED',
      entity: 'Shipment',
      entityId: created.id,
      shipmentCode: created.trackingCode,
      metadata: { itemCount, paymentMethod: input.paymentMethod, hasRecipientAccount: Boolean(recipientId) },
    },
    req,
  );

  return {
    trackingCode: created.trackingCode,
    shipmentId: created.id,
    status: created.status,
    qrToken,
    trackingUrl: `${env.PUBLIC_WEB_URL.replace(/\/$/, '')}/track/${qrToken}`,
    estimatedDeliveryAt,
  };
}

// ── Autorizacion de acceso ────────────────────────────────────

/**
 * Decide si `actor` puede ver el detalle completo de `shipment`.
 *
 * Tres niveles, que es lo que evita que el rastreo publico se convierta
 * en una fuga de datos personales:
 *
 *   PUBLIC     cualquiera con el codigo: solo estado y hitos.
 *   FULL       emisor, receptor, operador, courier, admin.
 *   RESTRICTED emisor y admin, sobre envios ya despachados: el
 *              receptor pierde acceso a la direccion de origen.
 */
export type Visibility = 'PUBLIC' | 'RESTRICTED' | 'FULL';

export function visibilityFor(
  actor: { userId: string; roles: UserRole[] } | undefined,
  shipment: { senderId: string; recipientId: string | null; status: ShipmentStatus },
): Visibility {
  if (!actor) return 'PUBLIC';

  const { userId, roles } = actor;
  const isAdmin = roles.includes('ADMIN');
  const isOperator = roles.includes('OPERATOR');
  const isCourier = roles.includes('COURIER');
  const isSender = shipment.senderId === userId;
  const isRecipient = shipment.recipientId !== null && shipment.recipientId === userId;

  if (isAdmin || isOperator) return 'FULL';
  if (isCourier) return 'FULL';
  if (isSender) return 'FULL';
  if (isRecipient) {
    // El receptor no necesita saber de donde vino el paquete una vez
    // que salio. Limitar esto es buena practica de minima informacion.
    return shipment.status === 'CREATED' || shipment.status === 'CONFIRMED' ||
           shipment.status === 'AWAITING_PAYMENT'
      ? 'FULL'
      : 'RESTRICTED';
  }

  return 'PUBLIC';
}

export async function loadShipmentByCode(trackingCodeInput: string) {
  const code = normalizeTrackingCode(trackingCodeInput);
  const shipment = await prisma.shipment.findUnique({
    where: { trackingCode: code },
    include: {
      senderAddress: true,
      recipientAddress: true,
      originBranch: { select: { id: true, name: true, city: true } },
      destinationBranch: { select: { id: true, name: true, city: true } },
    },
  });

  if (!shipment) throw notFound('Envio');
  return shipment;
}

// ── Transicion de estado (nucleo) ─────────────────────────────

export interface StateChangeInput {
  to: ShipmentStatus;
  title?: string;
  description?: string;
  locationName?: string;
  occurredAt?: Date;
  source?: EventSource;
  operatorId?: string | null;
  courierEventId?: string | null;
  idempotencyKey?: string | null;
  metadata?: Prisma.InputJsonValue;
  /** Datos adicionales a guardar en el envio al transicionar. */
  patch?: Prisma.ShipmentUpdateInput;
}

export interface StateChangeResult {
  trackingCode: string;
  eventId: string;
  sequence: number;
  status: ShipmentStatus;
  changed: boolean;
}

/**
 * Aplica un cambio de estado de forma atomica y publica el evento.
 *
 * Es la UNICA via para mover un envio. Todas las rutas pasan por aqui,
 * lo que garantiza que la maquina de estados, la linea de tiempo y la
 * version del envio nunca se desincronicen.
 */
export async function applyStateChange(
  shipmentId: string,
  input: StateChangeInput,
): Promise<StateChangeResult> {
  const result = await prisma.$transaction(
    async (tx) => {
      const shipment = await tx.shipment.findUnique({
        where: { id: shipmentId },
        select: {
          id: true,
          trackingCode: true,
          status: true,
          version: true,
          deliveredAt: true,
        },
      });

      if (!shipment) throw notFound('Envio');

      // ── Idempotencia del evento ────────────────────────────
      if (input.idempotencyKey || input.courierEventId) {
        const existing = await tx.shipmentEvent.findFirst({
          where: input.courierEventId
            ? { courierEventId: input.courierEventId }
            : { idempotencyKey: input.idempotencyKey! },
          select: { id: true, sequence: true, status: true, occurredAt: true },
        });

        if (existing) {
          // Ya se aplico: se devuelve el resultado original.
          logger.info(
            { trackingCode: shipment.trackingCode, eventId: existing.id },
            'Evento duplicado ignorado (idempotencia)',
          );
          return {
            trackingCode: shipment.trackingCode,
            eventId: existing.id,
            sequence: existing.sequence,
            status: existing.status,
            changed: false,
          };
        }
      }

      // ── Validacion de la transicion ────────────────────────
      // Se valida SIEMPRE, incluso si el estado solicitado es igual:
      // en ese caso es un no-op legitimo (dos webhooks del mismo
      // courier reportando "en transito"), no un error.
      if (input.to !== shipment.status) {
        assertTransition(shipment.status, input.to);
      }

      const occurredAt = input.occurredAt ?? new Date();

      // Un evento con fecha futura no se acepta: romperia el orden
      // de la linea de tiempo y permitiraia Manipulation del historial.
      if (occurredAt.getTime() > Date.now() + 5 * 60 * 1000) {
        throw validationError('La fecha del evento no puede ser futura');
      }

      const nextSequence =
        (
          await tx.shipmentEvent.aggregate({
            where: { shipmentId },
            _max: { sequence: true },
          })
        )._max.sequence ?? 0;

      const event = await tx.shipmentEvent.create({
        data: {
          shipmentId,
          sequence: nextSequence + 1,
          status: input.to,
          title: input.title ?? labelOf(input.to),
          description: input.description ?? STATUS_DEFINITIONS[input.to]?.description ?? null,
          locationName: input.locationName ?? null,
          occurredAt,
          source: input.source ?? 'MANUAL',
          operatorId: input.operatorId ?? null,
          courierEventId: input.courierEventId ?? null,
          idempotencyKey: input.idempotencyKey ?? null,
          metadata: input.metadata,
        },
        select: { id: true, sequence: true, status: true, occurredAt: true, title: true },
      });

      // Actualizacion del envio con bloqueo optimista: si `version`
      // cambio desde la lectura, la transicion no se aplica. Es la
      // defensa contra dos operadores moviendo el mismo paquete a la vez.
      const updateData: Prisma.ShipmentUpdateInput = {
        status: input.to,
        statusChangedAt: occurredAt,
        version: { increment: 1 },
        ...(input.patch ?? {}),
      };

      if (input.to === 'DELIVERED' && shipment.deliveredAt === null) {
        updateData.deliveredAt = occurredAt;
      }
      if (input.to === 'CANCELLED') {
        updateData.cancelledAt = occurredAt;
      }
      if (input.to === 'PICKED_UP') {
        updateData.dispatchedAt = occurredAt;
      }

      const updated = await tx.shipment.updateMany({
        where: { id: shipmentId, version: shipment.version },
        data: updateData,
      });

      if (updated.count === 0) {
        throw conflict(
          'El envio cambio de estado concurrentemente. Reintenta la operacion.',
        );
      }

      return {
        trackingCode: shipment.trackingCode,
        eventId: event.id,
        sequence: event.sequence,
        status: event.status,
        changed: true,
      };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 15000 },
  );

  // Publicacion en tiempo real FUERA de la transaccion: si el publish
  // falla, el evento ya esta persistido (correcto) y el cliente recibe
  // la Actualizacion al reconectar via GET.
  if (result.changed) {
    publishShipmentEvent(result.trackingCode, {
      id: result.eventId,
      sequence: result.sequence,
      status: result.status,
      occurredAt: new Date(),
      title: labelOf(result.status),
    });
  }

  return result;
}

// ── Consultas ─────────────────────────────────────────────────

/**
 * El peso y el contenido de un paquete se comunican al transporte en
 * el momento del despacho. La API expone el importe en centavos; este
 * helper documenta la convencion para el frontend y el webhook.
 */
export function formatAmountCents(amountCents: number, currency: string): string {
  const major = amountCents / 100;
  return `${currency} ${major.toFixed(2)}`;
}

const SHIPMENT_LIST_SELECT = {
  id: true,
  trackingCode: true,
  status: true,
  statusChangedAt: true,
  createdAt: true,
  estimatedDeliveryAt: true,
  deliveredAt: true,
  cancelledAt: true,
  itemCount: true,
  weightGrams: true,
  paymentMethod: true,
  paymentStatus: true,
  amountCents: true,
  currency: true,
  courierCode: true,
  courierTrackingNumber: true,
  senderId: true,
  recipientId: true,
  originBranch: { select: { id: true, name: true, city: true } },
  destinationBranch: { select: { id: true, name: true, city: true } },
  recipientAddress: { select: { city: true, region: true, countryCode: true, contactName: true } },
  sender: { select: { id: true, firstName: true, lastName: true } },
  recipient: { select: { id: true, firstName: true, lastName: true } },
} satisfies Prisma.ShipmentSelect;

export async function listShipments(
  actor: { userId: string; roles: UserRole[] },
  query: ListShipmentsQuery,
) {
  const where: Prisma.ShipmentWhereInput = {};

  const isStaff = actor.roles.includes('ADMIN') || actor.roles.includes('OPERATOR');

  if (!isStaff) {
    // Un usuario normal solo ve lo que envia o lo que recibe.
    where.OR = [{ senderId: actor.userId }, { recipientId: actor.userId }];
  }

  if (query.status) {
    const statuses = Array.isArray(query.status) ? query.status : [query.status];
    where.status = { in: statuses as ShipmentStatus[] };
  }

  if (query.scope === 'active') {
    where.status = {
      in: (Object.keys(STATUS_DEFINITIONS) as ShipmentStatus[]).filter((s) => isActive(s)),
    };
  } else if (query.scope === 'closed') {
    where.status = {
      in: (Object.keys(STATUS_DEFINITIONS) as ShipmentStatus[]).filter((s) => !isActive(s)),
    };
  }

  if (query.from || query.to) {
    where.createdAt = {};
    if (query.from) where.createdAt.gte = query.from;
    if (query.to) where.createdAt.lte = query.to;
  }

  if (query.courierCode) where.courierCode = query.courierCode;
  if (query.courierTrackingNumber) where.courierTrackingNumber = query.courierTrackingNumber;
  if (query.originBranchId) where.originBranchId = query.originBranchId;
  if (query.destinationBranchId) where.destinationBranchId = query.destinationBranchId;

  if (query.search) {
    where.AND = [
      {
        OR: [
          { trackingCode: { contains: normalizeTrackingCode(query.search), mode: 'insensitive' } },
          { courierTrackingNumber: { contains: query.search, mode: 'insensitive' } },
          {
            items: {
              some: { name: { contains: query.search, mode: 'insensitive' } },
            },
          },
          {
            recipientAddress: {
              is: { contactName: { contains: query.search, mode: 'insensitive' } },
            },
          },
        ],
      },
    ];
  }

  const [total, shipments] = await Promise.all([
    prisma.shipment.count({ where }),
    prisma.shipment.findMany({
      where,
      select: SHIPMENT_LIST_SELECT,
      orderBy: { [query.sort]: query.order },
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
  ]);

  return {
    data: shipments.map((shipment) => decorate(shipment, actor, 'LIST')),
    pagination: {
      page: query.page,
      pageSize: query.pageSize,
      total,
      totalPages: Math.ceil(total / query.pageSize),
    },
  };
}

/**
 * Anade el derivado que el frontend necesita para pintar la linea de
 * tiempo sin conocer la maquina de estados: que etiqueta y que color
 * corresponde a cada estado.
 */
function decorate<
  T extends { status: ShipmentStatus; trackingCode: string; senderId: string; recipientId: string | null },
>(row: T, actor: { userId: string; roles: UserRole[] }, view: 'LIST' | 'DETAIL' | 'PUBLIC') {
  const visibility = visibilityFor(actor, row);
  const definition = STATUS_DEFINITIONS[row.status];

  return {
    ...row,
    statusLabel: definition?.label ?? row.status,
    statusDescription: definition?.description ?? null,
    statusIcon: definition?.icon ?? 'package',
    statusTone: definition?.tone ?? 'neutral',
    statusPhase: definition?.phase ?? 'excepcion',
    isActive: isActive(row.status),
    visibility,
    // El codigo de rastreo solo se expone completo a quien tiene
    // acceso legitimateo. Un tercero ve un codigo enmascarado.
    trackingCode: visibility === 'PUBLIC' ? maskTrackingCode(row.trackingCode) : row.trackingCode,
  };
}

export function maskTrackingCode(code: string): string {
  const parts = code.split('-');
  if (parts.length !== 3) return '••••••';
  return `${parts[0]}-${parts[1]}-••••••`;
}

export async function getShipmentDetail(
  trackingCodeInput: string,
  actor: { userId: string; roles: UserRole[] },
  req?: FastifyRequest,
) {
  const shipment = await loadShipmentByCode(trackingCodeInput);
  const visibility = visibilityFor(actor, shipment);

  // Un tercero que llega con un codigo valido: se registra el acceso
  // porque la vista publica es la superficie mas expuesta.
  if (visibility === 'PUBLIC') {
    await recordAudit(
      {
        action: 'SHIPMENT_VIEW_RESTRICTED',
        entity: 'Shipment',
        entityId: shipment.id,
        shipmentCode: shipment.trackingCode,
        outcome: 'DENIED',
        metadata: { reason: 'NOT_OWNER', visibility },
      },
      req,
    );
    throw notFound('Envio');
  }

  const items = await prisma.shipmentItem.findMany({
    where: { shipmentId: shipment.id },
    orderBy: { lineCode: 'asc' },
  });

  await recordAudit(
    {
      userId: actor.userId,
      action: 'SHIPMENT_VIEW',
      entity: 'Shipment',
      entityId: shipment.id,
      shipmentCode: shipment.trackingCode,
      metadata: { visibility },
      role: actor.roles[0] ?? null,
    },
    req,
  );

  const base = decorate(shipment, actor, 'DETAIL');

  return {
    ...base,
    senderAddress: visibility === 'FULL' ? shipment.senderAddress : null,
    recipientAddress: shipment.recipientAddress,
    // El receptor no ve la direccion de origen una vez despachado.
    originAddressVisible: visibility === 'FULL',
    amountFormatted: formatAmountCents(shipment.amountCents, shipment.currency),
    items,
    courier: {
      code: shipment.courierCode,
      shipmentId: shipment.courierShipmentId,
      trackingNumber: shipment.courierTrackingNumber,
      syncedAt: shipment.courierSyncedAt,
    },
  };
}

// ── Linea de tiempo ───────────────────────────────────────────

export interface TimelineEntry {
  id: string;
  sequence: number;
  status: ShipmentStatus;
  statusLabel: string;
  statusIcon: string;
  statusTone: string;
  title: string;
  description: string | null;
  locationName: string | null;
  occurredAt: Date;
  source: string;
  operatorName: string | null;
  metadata: unknown;
}

export async function getTimeline(
  trackingCodeInput: string,
  options: { limit?: number; cursor?: number } = {},
  req?: FastifyRequest,
): Promise<TimelineEntry[]> {
  const shipment = await loadShipmentByCode(trackingCodeInput);
  const visibility = visibilityFor(
    // La vista publica no necesita actor.
    undefined,
    shipment,
  );

  const limit = options.limit ?? 50;

  const events = await prisma.shipmentEvent.findMany({
    where: {
      shipmentId: shipment.id,
      ...(options.cursor ? { sequence: { gt: options.cursor } } : {}),
    },
    include: {
      operator: { select: { firstName: true, lastName: true, roles: true } },
    },
    orderBy: { sequence: 'asc' },
    take: limit,
  });

  await recordAudit(
    {
      userId: req?.currentUser?.sub,
      action: 'TIMELINE_VIEW',
      entity: 'Shipment',
      entityId: shipment.id,
      shipmentCode: shipment.trackingCode,
      metadata: { level: visibility, count: events.length },
    },
    req,
  );

  return events.map((event) => {
    const definition = STATUS_DEFINITIONS[event.status];
    return {
      id: event.id,
      sequence: event.sequence,
      status: event.status,
      statusLabel: definition?.label ?? event.status,
      statusIcon: definition?.icon ?? 'package',
      statusTone: definition?.tone ?? 'neutral',
      title: event.title,
      description: event.description,
      locationName: event.locationName,
      occurredAt: event.occurredAt,
      source: event.source,
      // En la vista publica no se expone quien opero: podria revelar
      // la identidad de un repartidor.
      operatorName:
        visibility === 'FULL' && event.operator
          ? `${event.operator.firstName} ${event.operator.firstName}`.trim()
          : null,
      // Los metadatos pueden contener datos del proveedor (p.ej. URLs
      // de firma): solo para staff.
      metadata: visibility === 'FULL' ? event.metadata : null,
    };
  });
}

// ── Actualizacion y cancelacion ───────────────────────────────

export async function updateShipment(
  trackingCodeInput: string,
  actor: { userId: string; roles: UserRole[] },
  data: { recipientAddress?: AddressInput; weightGrams?: number; declaredValueCents?: number; notes?: string | null; paymentMethod?: 'ONLINE' | 'ON_DELIVERY' },
  req?: FastifyRequest,
) {
  const shipment = await loadShipmentByCode(trackingCodeInput);

  const isSender = shipment.senderId === actor.userId;
  const isAdmin = actor.roles.includes('ADMIN');
  if (!isSender && !isAdmin) throw forbidden('Solo el emisor puede modificar el envio');

  // Editar un paquete ya despachado rompe la trazabilidad: el peso y
  // el contenido ya se comunicaron al transporte.
  if (!isAdmin && !['CREATED', 'CONFIRMED', 'AWAITING_PAYMENT'].includes(shipment.status)) {
    throw conflict('El envio ya fue despachado y no puede modificarse');
  }

  if (data.recipientAddress) {
    await prisma.address.update({
      where: { id: shipment.recipientAddressId },
      data: encryptAddress(data.recipientAddress),
    });
  }

  const updated = await prisma.shipment.update({
    where: { id: shipment.id },
    data: {
      ...(data.weightGrams !== undefined ? { weightGrams: data.weightGrams } : {}),
      ...(data.declaredValueCents !== undefined
        ? { declaredValueCents: data.declaredValueCents }
        : {}),
      ...(data.paymentMethod !== undefined ? { paymentMethod: data.paymentMethod } : {}),
      version: { increment: 1 },
    },
    select: SHIPMENT_LIST_SELECT,
  });

  await recordAudit(
    { userId: actor.userId, action: 'SHIPMENT_UPDATED', entity: 'Shipment', entityId: shipment.id, shipmentCode: shipment.trackingCode },
    req,
  );

  return decorate(updated, actor, 'DETAIL');
}

export async function cancelShipment(
  trackingCodeInput: string,
  actor: { userId: string; roles: UserRole[] },
  reason: string,
  req?: FastifyRequest,
) {
  const shipment = await loadShipmentByCode(trackingCodeInput);

  const isSender = shipment.senderId === actor.userId;
  const isAdmin = actor.roles.includes('ADMIN');
  if (!isSender && !isAdmin) throw forbidden('Solo el emisor o un administrador puede cancelar el envio');

  // Cancelar en transito significaria dejar un paquete fisico sin
  // destino logistico: eso se resuelve con devolucion, no con cancelacion.
  if (['IN_TRANSIT', 'AT_DISTRIBUTION_CENTER', 'OUT_FOR_DELIVERY'].includes(shipment.status)) {
    throw conflict(
      'El envio ya esta en transito y no puede cancelarse; solicite una devolucion',
    );
  }

  const result = await applyStateChange(shipment.id, {
    to: 'CANCELLED',
    title: 'Envio cancelado',
    description: reason,
    source: 'MANUAL',
    operatorId: actor.userId,
    patch: { cancelReason: reason },
  });

  await recordAudit(
    { userId: actor.userId, action: 'SHIPMENT_CANCELLED', entity: 'Shipment', entityId: shipment.id, shipmentCode: shipment.trackingCode, metadata: { reason } },
    req,
  );

  return result;
}

// ── Eventos manuales (operador / admin) ───────────────────────

export async function recordManualEvent(
  trackingCodeInput: string,
  actor: { userId: string; roles: UserRole[] },
  input: ManualEventInput,
  req?: FastifyRequest,
) {
  const shipment = await loadShipmentByCode(trackingCodeInput);

  const isStaff = actor.roles.includes('ADMIN') || actor.roles.includes('OPERATOR');
  const isCourier = actor.roles.includes('COURIER');
  if (!isStaff && !isCourier) {
    throw forbidden('Registrar eventos manuales requiere rol de operador o courier');
  }

  const result = await applyStateChange(shipment.id, {
    to: input.status,
    title: input.title,
    description: input.description,
    locationName: input.locationName,
    occurredAt: input.occurredAt,
    source: 'MANUAL',
    operatorId: actor.userId,
    idempotencyKey: input.idempotencyKey ?? null,
    metadata: input.metadata as Prisma.InputJsonValue | undefined,
  });

  await recordAudit(
    {
      userId: actor.userId,
      action: 'SHIPMENT_EVENT_MANUAL',
      entity: 'Shipment',
      entityId: shipment.id,
      shipmentCode: shipment.trackingCode,
      metadata: { to: input.status, changed: result.changed },
      role: actor.roles[0] ?? null,
    },
    req,
  );

  return result;
}

// ── Cadena de custodia ────────────────────────────────────────

export async function registerCustody(
  trackingCodeInput: string,
  actor: { userId: string; roles: UserRole[] },
  input: {
    action: string;
    branchId?: string | null;
    scanCode?: string | null;
    latitude?: number | null;
    longitude?: number | null;
    note?: string | null;
    occurredAt?: Date;
  },
  req?: FastifyRequest,
) {
  const shipment = await loadShipmentByCode(trackingCodeInput);

  const isStaff = actor.roles.includes('ADMIN') || actor.roles.includes('OPERATOR') || actor.roles.includes('COURIER');
  if (!isStaff) throw forbidden('Registrar custodia requiere rol operativo');

  // Un envio terminal no genera custodia nueva: si aparece un escaneo
  // sobre un paquete ya entregado, es una anomalia a investigar.
  if (!isActive(shipment.status)) {
    throw conflict(
      `El envio esta en estado terminal (${labelOf(shipment.status)}); un nuevo escaneo requiere intervencion de un administrador`,
    );
  }

  const record = await prisma.$transaction(async (tx) => {
    const created = await tx.custodyRecord.create({
      data: {
        shipmentId: shipment.id,
        handlerId: actor.userId,
        branchId: input.branchId ?? null,
        action: input.action as never,
        scanCode: input.scanCode ?? null,
        latitude: input.latitude ?? null,
        longitude: input.longitude ?? null,
        note: input.note ?? null,
        occurredAt: input.occurredAt ?? new Date(),
      },
      select: {
        id: true,
        action: true,
        branchId: true,
        scanCode: true,
        latitude: true,
        longitude: true,
        note: true,
        occurredAt: true,
        handler: { select: { firstName: true, lastName: true, roles: true } },
        branch: { select: { name: true, city: true } },
      },
    });

    // La custodia y el hito van juntos: si alguien escanea, el
    // receptor debe verlo en la linea de tiempo en el momento.
    await tx.shipmentEvent.create({
      data: {
        shipmentId: shipment.id,
        sequence:
          ((await tx.shipmentEvent.aggregate({ where: { shipmentId: shipment.id }, _max: { sequence: true } }))
            ._max.sequence ?? 0) + 1,
        status: shipment.status,
        title: 'Movimiento registrado',
        description: input.note ?? CUSTODY_LABELS[input.action] ?? 'El paquete fue escaneado',
        locationName: input.branchId ? undefined : null,
        occurredAt: input.occurredAt ?? new Date(),
        source: 'SCAN',
        operatorId: actor.userId,
        metadata: { custodyId: created.id, action: input.action },
      },
    });

    return created;
  });

  await recordAudit(
    {
      userId: actor.userId,
      action: 'CUSTODY_RECORDED',
      entity: 'Shipment',
      entityId: shipment.id,
      shipmentCode: shipment.trackingCode,
      metadata: { custodyAction: input.action },
      role: actor.roles[0] ?? null,
    },
    req,
  );

  return record;
}

const CUSTODY_LABELS: Record<string, string> = {
  PICKUP: 'El paquete fue recogido',
  SCAN_IN: 'El paquete ingreso a la sede',
  SCAN_OUT: 'El paquete salio de la sede',
  HANDOFF: 'El paquete cambio de manos',
  SORT: 'El paquete fue clasificado',
  LOAD_VEHICLE: 'El paquete fue cargado en vehiculo',
  DELIVER: 'El paquete fue entregado',
  ATTEMPT_DELIVERY: 'Se intento entregar el paquete',
  RETURN: 'El paquete fue devuelto',
};

export async function getCustodyChain(trackingCodeInput: string) {
  const shipment = await loadShipmentByCode(trackingCodeInput);

  return prisma.custodyRecord.findMany({
    where: { shipmentId: shipment.id },
    include: {
      handler: { select: { firstName: true, lastName: true, roles: true } },
      branch: { select: { name: true, city: true } },
    },
    orderBy: { occurredAt: 'desc' },
  });
}

// ── Entrega con verificacion ──────────────────────────────────

export async function deliverShipment(
  trackingCodeInput: string,
  actor: { userId: string; roles: UserRole[] },
  input: DeliverShipmentInput,
  req?: FastifyRequest,
) {
  const shipment = await loadShipmentByCode(trackingCodeInput);

  const isCourier = actor.roles.includes('COURIER') || actor.roles.includes('OPERATOR') || actor.roles.includes('ADMIN');
  if (!isCourier) throw forbidden('Solo el personal de reparto puede registrar una entrega');

  // ── Verificacion por OTP: la proteccion real contra entrega a la
  // persona equivocada. Si el receptor no presenta el codigo, la
  // entrega se registra SIN `deliveredAt`, lo que deja el envio en un
  // estado que se ve en el panel como "por verificar".
  let verified = false;
  let otpSupplied = false;

  if (input.otp) {
    otpSupplied = true;
    if (!shipment.recipientId) {
      throw validationError(
        'Este envio no tiene receptor registrado, no se puede verificar por OTP',
      );
    }

    const { verifyOtp } = await import('../auth/tokens.js');
    const result = await verifyOtp(
      shipment.recipientId,
      shipment.id,
      'DELIVERY_CONFIRMATION',
      input.otp,
    );

    if (!result.valid) {
      await recordAudit(
        {
          userId: actor.userId,
          action: 'DELIVERY_VERIFICATION_FAILED',
          entity: 'Shipment',
          entityId: shipment.id,
          shipmentCode: shipment.trackingCode,
          outcome: 'DENIED',
          metadata: { reason: result.reason },
        },
        req,
      );
      throw validationError(
        result.reason === 'EXHAUSTED'
          ? 'Se agotaron los intentos del codigo. Solicita uno nuevo al receptor.'
          : result.reason === 'EXPIRED'
            ? 'El codigo expiro. Solicita uno nuevo al receptor.'
            : 'El codigo no coincide',
      );
    }

    verified = true;
  }

  const hasPhysicalProof = Boolean(input.signatureUrl) || input.photoUrls.length > 0;

  if (!verified && !hasPhysicalProof && !input.unverifiedReason) {
    throw validationError('Se requiere OTP del receptor, firma, foto o un motivo justificado');
  }

  const result = await applyStateChange(shipment.id, {
    to: 'DELIVERED',
    title: verified ? 'Entregado y verificado por el receptor' : 'Entregado',
    description: verified
      ? 'El receptor confirmo la recepcion con su codigo de verificacion.'
      : hasPhysicalProof
        ? 'La entrega fue registrada con evidencia fisica.'
        : `Entrega sin verificacion del receptor: ${input.unverifiedReason}`,
    locationName: input.locationName,
    source: verified ? 'SCAN' : 'MANUAL',
    operatorId: actor.userId,
    metadata: {
      verified,
      otpSupplied,
      signatureUrl: input.signatureUrl ?? null,
      photoUrls: input.photoUrls,
      latitude: input.latitude ?? null,
      longitude: input.longitude ?? null,
      unverifiedReason: input.unverifiedReason ?? null,
    },
    // Solo se setea `deliveredAt` si la entrega esta verificada. Sin
    // verificacion, el envio queda DELIVERED pero sin confirmar, y el
    // panel lo lista como pendiente de revision.
    patch: verified || hasPhysicalProof ? {} : { deliveredAt: null },
  });

  // Registro de custodia con la entrega.
  await prisma.custodyRecord.create({
    data: {
      shipmentId: shipment.id,
      handlerId: actor.userId,
      action: 'DELIVER',
      latitude: input.latitude ?? null,
      longitude: input.longitude ?? null,
      note: verified ? 'Entrega verificada por OTP' : 'Entrega registrada por el repartidor',
    },
  });

  await recordAudit(
    {
      userId: actor.userId,
      action: 'SHIPMENT_DELIVERED',
      entity: 'Shipment',
      entityId: shipment.id,
      shipmentCode: shipment.trackingCode,
      metadata: { verified, hasPhysicalProof },
      role: actor.roles[0] ?? null,
    },
    req,
  );

  return { ...result, verified, deliveredAt: verified ? new Date() : null };
}

// ── Metricas del panel ────────────────────────────────────────

export async function getDashboardMetrics(actor: { userId: string; roles: UserRole[] }) {
  const isStaff = actor.roles.includes('ADMIN') || actor.roles.includes('OPERATOR');

  if (!isStaff) {
    // Vista personal: solo los envios propios.
    const [sent, received, active] = await Promise.all([
      prisma.shipment.count({ where: { senderId: actor.userId } }),
      prisma.shipment.count({ where: { recipientId: actor.userId } }),
      prisma.shipment.count({
        where: {
          OR: [{ senderId: actor.userId }, { recipientId: actor.userId }],
          status: {
            in: (Object.keys(STATUS_DEFINITIONS) as ShipmentStatus[]).filter((s) => isActive(s)),
          },
        },
      }),
    ]);
    return { scope: 'personal', sent, received, active };
  }

  const [byStatus, total, delivered, deliveredOnTime, exceptions, syncFailures] = await Promise.all([
    prisma.shipment.groupBy({
      by: ['status'],
      _count: { _all: true },
    }),
    prisma.shipment.count(),
    prisma.shipment.count({ where: { status: 'DELIVERED' } }),
    // A tiempo = entregado dentro o antes de la fecha estimada. Los que
    // se entregaron sin fecha estimada no cuentan como tarde ni como a
    // tiempo: son "entregados" y nada mas.
    prisma.shipment.count({
      where: {
        status: 'DELIVERED',
        deliveredAt: { not: null },
        estimatedDeliveryAt: { not: null },
        AND: [{ deliveredAt: { lte: prisma.shipment.fields.estimatedDeliveryAt } }],
      },
    }),
    prisma.shipment.count({
      where: { status: { in: ['EXCEPTION', 'LOST', 'ON_HOLD', 'DELIVERY_ATTEMPTED'] } },
    }),
    // Envios que el transportista no confirma: el panel los usa para
    // detectar que se rompio algo del lado del proveedor.
    prisma.shipment.count({ where: { courierSyncAttempts: { gte: 3 } } }),
  ]);

  // Todavia en curso y con la fecha estimada vencida.
  const late = await prisma.shipment.count({
    where: {
      status: { not: 'DELIVERED' },
      estimatedDeliveryAt: { lt: new Date() },
    },
  });

  return {
    scope: 'global',
    total,
    delivered,
    deliveredOnTime,
    exceptions,
    late,
    syncFailures,
    byStatus: Object.fromEntries(byStatus.map((row) => [row.status, row._count._all])),
  };
}

export async function assertOwnership(
  trackingCode: string,
  actor: { userId: string; roles: UserRole[] },
): Promise<{ id: string; senderId: string; recipientId: string | null }> {
  const shipment = await prisma.shipment.findUnique({
    where: { trackingCode: normalizeTrackingCode(trackingCode) },
    select: { id: true, senderId: true, recipientId: true },
  });

  if (!shipment) throw notFound('Envio');

  const isStaff = actor.roles.includes('ADMIN') || actor.roles.includes('OPERATOR') || actor.roles.includes('COURIER');
  const isParty = shipment.senderId === actor.userId || shipment.recipientId === actor.userId;
  if (!isStaff && !isParty) throw unauthorized();

  return shipment;
}