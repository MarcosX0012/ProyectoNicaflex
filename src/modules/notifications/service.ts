import { Prisma, type NotificationChannel, type NotificationStatus } from '@prisma/client';
import { env } from '../../config/env.js';
import { prisma } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';
import { issueOtp } from '../auth/tokens.js';
import { SHIPMENT_TEMPLATES, sendWhatsAppTemplate } from './whatsapp.js';
import { STATUS_DEFINITIONS } from '../shipments/stateMachine.js';
import type { ShipmentStatus } from '@prisma/client';

/**
 * SERVICIO DE NOTIFICACIONES
 * ===========================
 *
 * Decide QUE notificar y a QUIEN. El COMO (WhatsApp, correo) queda
 * en `dispatchNotification` y se cambia sin tocar la logica de negocio.
 *
 * Dos reglas que evitan el problema clasico de estos sistemas:
 *
 *  1. Solo se notifica lo que el usuario pediria saber. Mandar un
 *     WhatsApp por cada micro hito satura al usuario y lo hace
 *     silenciar el numero. Hay una lista explicita de hitos
 *     notificables; el resto queda en la linea de tiempo sin avisar.
 *
 *  2. Notificar es best-effort, nunca bloqueante. Si WhatsApp falla,
 *     la entrega ya ocurrio y no se revierte. Un fallo de notificacion
 *     no puede impedir que un paquete se marque entregado.
 */

/** Hitos que generan notificacion al receptor. */
const NOTIFIABLE_STATUSES: ShipmentStatus[] = [
  'AWAITING_PICKUP',
  'PICKED_UP',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
  'DELIVERY_ATTEMPTED',
  'EXCEPTION',
  'LOST',
  'RETURNED',
];

/** Hitos que generan notificacion al emisor. */
const SENDER_NOTIFIABLE: ShipmentStatus[] = ['EXCEPTION', 'LOST', 'RETURNING'];

export function shouldNotifyReceiver(status: ShipmentStatus): boolean {
  return NOTIFIABLE_STATUSES.includes(status);
}

export function shouldNotifySender(status: ShipmentStatus): boolean {
  return SENDER_NOTIFIABLE.includes(status);
}

export interface RecordNotificationInput {
  userId: string;
  shipmentId?: string | null;
  channel: NotificationChannel;
  template: string;
  payload: Record<string, unknown>;
  status?: NotificationStatus;
  providerMessageId?: string | null;
  error?: string | null;
  sentAt?: Date | null;
}

/**
 * Registra una notificacion ya enviada. Se usa cuando el envio fue
 * sincrono (por ejemplo desde un job) y ya tenemos el id del proveedor.
 */
export async function recordNotification(input: RecordNotificationInput) {
  return prisma.notification.create({
    data: {
      userId: input.userId,
      shipmentId: input.shipmentId ?? null,
      channel: input.channel,
      template: input.template,
      payload: input.payload as Prisma.InputJsonValue,
      status: input.status ?? 'SENT',
      providerMessageId: input.providerMessageId ?? null,
      error: input.error ?? null,
      sentAt: input.sentAt ?? new Date(),
    },
    select: { id: true, status: true },
  });
}

/**
 * Encola la notificacion de un hito de la linea de tiempo.
 * Se llama DESPUES de confirmar el evento, nunca dentro de la
 * transaccion: la notificacion es consecuencia, no parte del estado.
 */
export async function notifyShipmentEvent(
  shipment: {
    id: string;
    trackingCode: string;
    status: ShipmentStatus;
    recipientId: string | null;
    senderId: string;
    estimatedDeliveryAt: Date | null;
  },
  event: {
    status: ShipmentStatus;
    title: string;
    description: string | null;
    occurredAt: Date;
  },
): Promise<void> {
  const definition = STATUS_DEFINITIONS[event.status];

  const targets = new Set<string>();
  if (shipment.recipientId && shouldNotifyReceiver(event.status)) {
    targets.add(shipment.recipientId);
  }
  if (shouldNotifySender(event.status)) {
    targets.add(shipment.senderId);
  }

  if (targets.size === 0) return;

  // La plantilla se elige por el estado real del hito, no por el estado
  // del envio: asi "en reparto" y "entregado" tienen mensajes propios.
  const template =
    event.status === 'OUT_FOR_DELIVERY'
      ? 'shipment_out_for_delivery'
      : event.status === 'DELIVERED'
        ? 'shipment_delivered'
        : event.status === 'EXCEPTION' || event.status === 'LOST'
          ? 'shipment_exception'
          : 'shipment_status_update';

  const created: Array<string> = [];

  for (const userId of targets) {
    const notification = await prisma.notification.create({
      data: {
        userId,
        shipmentId: shipment.id,
        channel: 'WHATSAPP',
        template,
        payload: {
          trackingCode: shipment.trackingCode,
          status: event.status,
          statusLabel: definition?.label ?? event.status,
          title: event.title,
          description: event.description,
          occurredAt: event.occurredAt.toISOString(),
          estimatedDeliveryAt: shipment.estimatedDeliveryAt?.toISOString() ?? null,
        },
        status: 'QUEUED',
      },
      select: { id: true },
    });

    created.push(notification.id);

    logger.info(
      {
        notificationId: notification.id,
        trackingCode: shipment.trackingCode,
        status: event.status,
        recipient: userId === shipment.recipientId ? 'receptor' : 'emisor',
      },
      'Notificacion encolada',
    );
  }

  if (created.length > 0) {
    // El envio se hace aqui, no dentro de una transaccion con el
    // evento: si el proceso muere entre ambos, queda la notificacion
    // QUEUED y el worker la recoge. Al reves, un evento sin
    // notificacion dejaria al usuario sin saber que su paquete llego.
    for (const id of created) {
      await dispatchNotification(id);
    }
  }
}

/**
 * Envia la notificacion pendiente. Idempotente: si ya esta SENT o
 * DELIVERED, no vuelve a enviar.
 */
export async function dispatchNotification(
  notificationId: string,
): Promise<{ status: NotificationStatus; error?: string }> {
  const notification = await prisma.notification.findUnique({
    where: { id: notificationId },
    select: {
      id: true,
      status: true,
      template: true,
      payload: true,
      attempts: true,
      userId: true,
    },
  });

  if (!notification) return { status: 'FAILED', error: 'Notificacion no encontrada' };
  if (notification.status === 'SENT' || notification.status === 'DELIVERED') {
    return { status: notification.status };
  }

  await prisma.notification.update({
    where: { id: notificationId },
    data: { status: 'SENDING', attempts: { increment: 1 } },
  });

  const user = await prisma.user.findUnique({
    where: { id: notification.userId },
    select: { phoneHash: true },
  });

  if (!user?.phoneHash) {
    await prisma.notification.update({
      where: { id: notificationId },
      data: { status: 'SKIPPED', error: 'El usuario no tiene telefono registrado' },
    });
    return { status: 'SKIPPED', error: 'El usuario no tiene telefono registrado' };
  }

  if (!env.WHATSAPP_ENABLED) {
    await prisma.notification.update({
      where: { id: notificationId },
      data: { status: 'SKIPPED', error: 'WHATSAPP_ENABLED=false' },
    });
    return { status: 'SKIPPED', error: 'WHATSAPP_ENABLED=false' };
  }

  const payload = (notification.payload ?? {}) as Record<string, unknown>;
  const trackingCode = String(payload.trackingCode ?? '');
  const statusLabel = String(payload.statusLabel ?? '');

  try {
    const template = buildTemplate(notification.template, statusLabel, trackingCode, payload);
    const { messageId } = await sendWhatsAppTemplate(user.phoneHash, template);

    await prisma.notification.update({
      where: { id: notificationId },
      data: { status: 'SENT', providerMessageId: messageId, sentAt: new Date(), error: null },
    });

    return { status: 'SENT' };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Error desconocido';
    const attempts = notification.attempts + 1;

    // Tras varios intentos se marca FAILED para no reintentar en bucle:
    // un numero invalido o un token vencido fallara siempre.
    await prisma.notification.update({
      where: { id: notificationId },
      data: { status: attempts >= 5 ? 'FAILED' : 'QUEUED', error: message.slice(0, 500) },
    });

    logger.warn({ notificationId, attempts, err: message }, 'Notificacion fallida');
    return { status: attempts >= 5 ? 'FAILED' : 'QUEUED', error: message };
  }
}

function buildTemplate(
  template: string,
  statusLabel: string,
  trackingCode: string,
  payload: Record<string, unknown>,
) {
  if (template === 'shipment_out_for_delivery') {
    const eta = payload.estimatedDeliveryAt
      ? new Date(String(payload.estimatedDeliveryAt)).toLocaleDateString('es')
      : 'hoy';
    return SHIPMENT_TEMPLATES.shipmentOutForDelivery(trackingCode, eta);
  }

  if (template === 'shipment_delivered') {
    const at = payload.occurredAt ? new Date(String(payload.occurredAt)).toLocaleString('es') : '';
    return SHIPMENT_TEMPLATES.shipmentDelivered(trackingCode, at);
  }

  if (template === 'shipment_exception') {
    return SHIPMENT_TEMPLATES.shipmentException(trackingCode, statusLabel);
  }

  return SHIPMENT_TEMPLATES.shipmentStatusUpdate(trackingCode, statusLabel);
}

// ── OTP de confirmacion de entrega ────────────────────────────

/**
 * Envia el OTP al receptor para que confirme la entrega.
 * Es la proteccion anti-fraude: sin este codigo, el repartidor no
 * puede marcar la entrega como verificada.
 */
export async function sendDeliveryOtp(
  shipmentId: string,
  actorId: string,
): Promise<{ sent: boolean; expiresAt?: Date; error?: string }> {
  const shipment = await prisma.shipment.findUnique({
    where: { id: shipmentId },
    select: { id: true, trackingCode: true, recipientId: true },
  });

  if (!shipment) return { sent: false, error: 'Envio no encontrado' };
  if (!shipment.recipientId) {
    return { sent: false, error: 'El envio no tiene receptor registrado' };
  }

  // Un OTP nuevo en cada solicitud, no se reutiliza uno viejo: si el
  // repartidor recibio un codigo antes, uno nuevo invalida el anterior.
  const { code, expiresAt } = await issueOtp(
    shipment.recipientId,
    shipment.id,
    'DELIVERY_CONFIRMATION',
  );

  if (!env.WHATSAPP_ENABLED) {
    logger.info(
      { trackingCode: shipment.trackingCode, requestedBy: actorId },
      'OTP de entrega generado (WhatsApp desactivado: no se envio)',
    );
    return { sent: false, expiresAt, error: 'WHATSAPP_ENABLED=false' };
  }

  const user = await prisma.user.findUnique({
    where: { id: shipment.recipientId },
    select: { phoneHash: true },
  });

  if (!user?.phoneHash) {
    return { sent: false, expiresAt, error: 'El receptor no tiene telefono registrado' };
  }

  try {
    const { messageId } = await sendWhatsAppTemplate(
      user.phoneHash,
      SHIPMENT_TEMPLATES.deliveryOtp(shipment.trackingCode, code),
    );

    await recordNotification({
      userId: shipment.recipientId,
      shipmentId: shipment.id,
      channel: 'WHATSAPP',
      template: 'delivery_otp',
      payload: { trackingCode: shipment.trackingCode },
      providerMessageId: messageId,
    });

    return { sent: true, expiresAt };
  } catch (error) {
    return {
      sent: false,
      expiresAt,
      error: error instanceof Error ? error.message : 'Error enviando el OTP',
    };
  }
}

// ── Consulta de notificaciones ────────────────────────────────

export async function listUserNotifications(
  userId: string,
  options: { limit?: number; unreadOnly?: boolean } = {},
) {
  return prisma.notification.findMany({
    where: { userId },
    select: {
      id: true,
      channel: true,
      template: true,
      payload: true,
      status: true,
      sentAt: true,
      deliveredAt: true,
      shipmentId: true,
    },
    orderBy: { queuedAt: 'desc' },
    take: options.limit ?? 30,
  });
}