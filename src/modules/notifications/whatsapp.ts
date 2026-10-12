import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';

/**
 * NOTIFICACIONES POR WHATSAPP (Meta Cloud API)
 * ===========================================
 *
 * Por que WhatsApp y no correo: en Bolivia, Peru y Ecuador la gente
 * abre WhatsApp casi a diario y el correo se ignora. Para un sistema
 * donde el usuario quiere saber si su paquete llego, el canal importa
 * tanto como la funcionalidad.
 *
 * REQUISITOS DE META (no son opcionales):
 *  - Cuenta de empresa verificada en Meta Business.
 *  - Numero de telefono NUEVO, no uno personal (migrar un numero
 *    personal a la API requiere un proceso aparte).
 *  - Plantillas de mensaje APROBADAS para todo mensaje iniciado por la
 *    empresa. Meta no permite texto libre desde el primer mensaje.
 *
 * Cada plantilla tiene variables en el formato {{1}}, {{2}}...
 * Las que se usan estan declaradas abajo con su contenido esperado.
 */

const GRAPH_VERSION = 'v21.0';
const GRAPH_BASE_URL = `https://graph.facebook.com/${GRAPH_VERSION}`;

export interface WhatsAppTemplate {
  /** Nombre exacto de la plantilla aprobada en Meta. */
  name: string;
  /** idioma: codigo de 2 letras. */
  language: string;
  /** Valores para los marcadores {{1}}, {{2}}... en orden. */
  parameters: string[];
}

export async function sendWhatsAppTemplate(
  toPhone: string,
  template: WhatsAppTemplate,
): Promise<{ messageId: string }> {
  if (!env.WHATSAPP_ENABLED) {
    throw new Error('WHATSAPP_ENABLED=false: las notificaciones estan desactivadas');
  }
  if (!env.WHATSAPP_PHONE_NUMBER_ID || !env.WHATSAPP_ACCESS_TOKEN) {
    throw new Error('Faltan WHATSAPP_PHONE_NUMBER_ID o WHATSAPP_ACCESS_TOKEN');
  }

  const url = `${GRAPH_BASE_URL}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`;

  const body = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: normalizePhoneForWhatsApp(toPhone),
    type: 'template',
    template: {
      name: template.name,
      language: { code: template.language },
      components: [
        {
          type: 'body',
          parameters: template.parameters.map((text) => ({ type: 'text', text })),
        },
      ],
    },
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    logger.error(
      { status: response.status, body: text.slice(0, 800) },
      'WhatsApp: envio fallido',
    );
    throw new Error(`WhatsApp respondio ${response.status}: ${text.slice(0, 300)}`);
  }

  const result = (await response.json()) as {
    messages?: Array<{ id?: string }>;
  };

  const messageId = result.messages?.[0]?.id ?? 'desconocido';
  logger.info({ to: toPhone, template: template.name, messageId }, 'WhatsApp: mensaje enviado');
  return { messageId };
}

/**
 * Meta exige codigo de pais en formato E.164 sin signos.
 * Si el numero ya lo trae, se respeta; si no, se antepone +.
 */
export function normalizePhoneForWhatsApp(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.startsWith('00')) return `+${digits.slice(2)}`;
  if (!phone.trim().startsWith('+') && digits.length <= 10) return `+${digits}`;
  return `+${digits}`;
}

// ── Plantillas del sistema ────────────────────────────────────

/**
 * Cada plantilla corresponde a un hito de la linea de tiempo.
 * El contenido debe coincidir EXACTAMENTE con lo aprobado en Meta,
 * incluida la cantidad y posicion de variables.
 */
export const SHIPMENT_TEMPLATES = {
  /** {{1}} codigo · {{2}} estado */
  shipmentStatusUpdate: (trackingCode: string, statusLabel: string): WhatsAppTemplate => ({
    name: 'envio_actualizacion_estado',
    language: 'es',
    parameters: [trackingCode, statusLabel],
  }),

  /** {{1}} codigo · {{2}} fecha estimada */
  shipmentOutForDelivery: (trackingCode: string, eta: string): WhatsAppTemplate => ({
    name: 'envio_en_ruta',
    language: 'es',
    parameters: [trackingCode, eta],
  }),

  /** {{1}} codigo · {{2}} fecha estimada */
  shipmentDelivered: (trackingCode: string, deliveredAt: string): WhatsAppTemplate => ({
    name: 'envio_entregado',
    language: 'es',
    parameters: [trackingCode, deliveredAt],
  }),

  /** {{1}} codigo · {{2}} motivo */
  shipmentException: (trackingCode: string, reason: string): WhatsAppTemplate => ({
    name: 'envio_incidencia',
    language: 'es',
    parameters: [trackingCode, reason],
  }),

  /** {{1}} codigo · {{2}} codigo de 6 digitos */
  deliveryOtp: (trackingCode: string, otp: string): WhatsAppTemplate => ({
    name: 'envio_codigo_verificacion',
    language: 'es',
    parameters: [trackingCode, otp],
  }),
} as const;

/**
 * Verificacion del webhook de WhatsApp (GET inicial de Meta).
 * Meta llama una vez al configurar el webhook y espera este challenge.
 */
export function handleWhatsAppVerification(
  mode: string | undefined,
  token: string | undefined,
  challenge: string | undefined,
): { valid: boolean; challenge?: string } {
  if (mode === 'subscribe' && token === env.WHATSAPP_VERIFY_TOKEN && challenge) {
    return { valid: true, challenge };
  }
  return { valid: false };
}

/**
 * Estado de entrega de un mensaje saliente. Meta notifica por webhook
 * cuando el mensaje cambia de `sent` a `delivered` o `read`.
 */
export type DeliveryStatus = 'sent' | 'delivered' | 'read' | 'failed';

export function parseDeliveryStatus(value: string): DeliveryStatus | null {
  const normalized = value.trim().toLowerCase();
  return ['sent', 'delivered', 'read', 'failed'].includes(normalized)
    ? (normalized as DeliveryStatus)
    : null;
}