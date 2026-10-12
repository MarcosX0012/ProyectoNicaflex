import { prisma } from '../../lib/prisma.js';
import { normalizeTrackingCode } from '../../lib/tracking.js';
import { verifyTrackingToken, isTrackingTokenExpired } from '../auth/qrTokens.js';
import { recordPublicTrackingAccess } from '../../lib/audit.js';
import { notFound, badRequest } from '../../lib/errors.js';
import { STATUS_DEFINITIONS } from './stateMachine.js';
import type { FastifyRequest } from 'fastify';

/**
 * RASTREO PUBLICO
 * ===============
 *
 * Esta es la vista que se abre al escanear el QR pegado en el paquete.
 * Es la superficie MAS expuesta del sistema y la que mas facilmente
 * convierte un producto de logistica en una fuga de datos personales.
 *
 * Lo que se revela aqui, y nada mas:
 *   - estado actual y etiqueta legible
 *   - hitos de la linea de tiempo, sin identidad de quien opero
 *   - ciudad de destino y fecha estimada
 *   - si el paquete fue entregado (y si la entrega quedo verificada)
 *
 * Lo que NUNCA se revela aqui:
 *   - nombre, telefono o direccion completa del emisor o del receptor
 *   - contenido y valor de los productos
 *   - identificadores del receptor
 *   - referencia del courier (expone la cuenta comercial del cliente)
 *
 * Por que el codigo no basta como secreto: por definicion viaja
 * impreso en el paquete, asi que cualquiera que lo tenga puede
 * consultarlo. Por eso los datos personales no estan en esta vista y
 * por eso el acceso queda registrado en la bitacora.
 */

export interface PublicTrackingResult {
  trackingCode: string;
  status: string;
  statusLabel: string;
  statusDescription: string;
  statusIcon: string;
  statusTone: string;
  statusPhase: string;
  isActive: boolean;
  isDelivered: boolean;
  /** El receptor confirmo con OTP: la entrega es de fiar. */
  deliveryVerified: boolean;
  city: string;
  countryCode: string;
  itemCount: number;
  createdAt: Date;
  estimatedDeliveryAt: Date | null;
  deliveredAt: Date | null;
  /** Indica al usuario que puede pedir ayuda con este codigo. */
  supportHint: string;
  timeline: PublicTimelineEntry[];
}

export interface PublicTimelineEntry {
  sequence: number;
  status: string;
  statusLabel: string;
  statusIcon: string;
  statusTone: string;
  title: string;
  description: string | null;
  locationName: string | null;
  occurredAt: Date;
  /** Etiqueta legible de la fuente: "Registrado por Hossana" / "Actualizado por el transporte". */
  sourceLabel: string;
}

/**
 * Resuelve un codigo O un token de QR a un envio.
 *
 * Acepta las dos formas porque el usuario puede teclear el codigo a mano
 * (HOS-2026-000123) o abrir el enlace del QR (que trae el token firmado).
 */
function resolveTrackingCode(input: string): string {
  const value = input.trim();

  // Si parece un token de QR (contiene punto y es largo), se verifica.
  if (value.length > 40 && value.includes('.')) {
    const verified = verifyTrackingToken(value);
    if (!verified) throw badRequest('El enlace de rastreo no es valido');
    if (isTrackingTokenExpired(verified)) throw badRequest('El enlace de rastreo ha caducado');
    return normalizeTrackingCode(verified.trackingCode);
  }

  const code = normalizeTrackingCode(value);
  if (!/^[A-Z]{3}-\d{4}-\d{6,}$/.test(code)) {
    throw badRequest(
      'El codigo de rastreo no tiene el formato esperado (ejemplo: HOS-2026-000123)',
    );
  }
  return code;
}

const SOURCE_LABELS: Record<string, string> = {
  SYSTEM: 'Registrado por Hossana',
  MANUAL: 'Actualizado por Hossana',
  SCAN: 'Registrado en sede',
  COURIER_API: 'Actualizado por el transporte',
  WEBHOOK: 'Actualizado por el transporte',
};

export async function getPublicTracking(
  input: string,
  req?: FastifyRequest,
): Promise<PublicTrackingResult> {
  let trackingCode: string;

  try {
    trackingCode = resolveTrackingCode(input);
  } catch {
    await recordPublicTrackingAccess('INVALID', 'FAILED', req, 'formato_invalido');
    throw badRequest('El codigo de rastreo no tiene el formato esperado');
  }

  const shipment = await prisma.shipment.findUnique({
    where: { trackingCode },
    select: {
      id: true,
      trackingCode: true,
      status: true,
      createdAt: true,
      estimatedDeliveryAt: true,
      deliveredAt: true,
      itemCount: true,
      version: true,
      recipientAddress: { select: { city: true, countryCode: true } },
      events: {
        select: {
          sequence: true,
          status: true,
          title: true,
          description: true,
          locationName: true,
          occurredAt: true,
          source: true,
        },
        orderBy: { sequence: 'asc' },
      },
      },
  });

  if (!shipment) {
    // Respuesta uniforme para codigo inexistente: no se distingue de
    // un envio ajeno, y no se revela que codigos existen.
    await recordPublicTrackingAccess(trackingCode, 'FAILED', req, 'no_encontrado');
    throw notFound('Envio');
  }

  await recordPublicTrackingAccess(trackingCode, 'SUCCESS', req, `eventos:${shipment.events.length}`);

  const definition = STATUS_DEFINITIONS[shipment.status];

  return {
    trackingCode: shipment.trackingCode,
    status: shipment.status,
    statusLabel: definition?.label ?? shipment.status,
    statusDescription: definition?.description ?? '',
    statusIcon: definition?.icon ?? 'package',
    statusTone: definition?.tone ?? 'neutral',
    statusPhase: definition?.phase ?? 'excepcion',
    isActive: definition ? !definition.isTerminal : true,
    isDelivered: shipment.status === 'DELIVERED',
    // Solo es true si hay deliveredAt Y el evento de entrega fue
    // verificado por OTP.
    deliveryVerified:
      shipment.status === 'DELIVERED' &&
      shipment.deliveredAt !== null &&
      shipment.events.some((e) => e.status === 'DELIVERED' && /verificad/i.test(e.title + (e.description ?? ''))),
    city: shipment.recipientAddress.city,
    countryCode: shipment.recipientAddress.countryCode,
    itemCount: shipment.itemCount,
    createdAt: shipment.createdAt,
    estimatedDeliveryAt: shipment.estimatedDeliveryAt,
    deliveredAt: shipment.deliveredAt,
    supportHint:
      shipment.status === 'EXCEPTION' || shipment.status === 'LOST'
        ? 'Tu envio registro una incidencia. Contacta a soporte con este codigo.'
        : 'Para cualquier consulta, menciona este codigo de rastreo.',
    timeline: shipment.events.map((event) => {
      const eventDefinition = STATUS_DEFINITIONS[event.status];
      return {
        sequence: event.sequence,
        status: event.status,
        statusLabel: eventDefinition?.label ?? event.status,
        statusIcon: eventDefinition?.icon ?? 'package',
        statusTone: eventDefinition?.tone ?? 'neutral',
        title: event.title,
        description: event.description,
        locationName: event.locationName,
        occurredAt: event.occurredAt,
        sourceLabel: SOURCE_LABELS[event.source] ?? 'Actualizado por Hossana',
      };
    }),
  };
}

/**
 * Version compacta para pantalla de consulta previa: no expone la
 * linea de tiempo, solo el estado. Se usa cuando el usuario escribe
 * el codigo a mano y todavia no ha confirmado la consulta.
 */
export async function getPublicTrackingSummary(input: string): Promise<{
  trackingCode: string;
  status: string;
  statusLabel: string;
  statusIcon: string;
  statusTone: string;
  itemCount: number;
  isDelivered: boolean;
  lastEventAt: Date | null;
}> {
  const trackingCode = resolveTrackingCode(input);

  const shipment = await prisma.shipment.findUnique({
    where: { trackingCode },
    select: {
      trackingCode: true,
      status: true,
      itemCount: true,
      deliveredAt: true,
      events: { select: { occurredAt: true }, orderBy: { occurredAt: 'desc' }, take: 1 },
    },
  });

  if (!shipment) throw notFound('Envio');

  const definition = STATUS_DEFINITIONS[shipment.status];
  return {
    trackingCode: shipment.trackingCode,
    status: shipment.status,
    statusLabel: definition?.label ?? shipment.status,
    statusIcon: definition?.icon ?? 'package',
    statusTone: definition?.tone ?? 'neutral',
    itemCount: shipment.itemCount,
    isDelivered: shipment.status === 'DELIVERED',
    lastEventAt: shipment.events[0]?.occurredAt ?? null,
  };
}