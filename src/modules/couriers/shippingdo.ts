import { createHmac, timingSafeEqual } from 'node:crypto';
import type { ShipmentStatus } from '@prisma/client';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import {
  CANONICAL_STATUS_MAP,
  CourierProviderError,
  type CourierAdapter,
  type CourierShipmentResult,
  type CourierTrackingEvent,
  type CourierTrackingResult,
  type CreateCourierShipmentInput,
} from './types.js';

/**
 * ADAPTADOR SHIPPING-DO
 * =====================
 *
 * Shipping-do es el transportista elegido para el primer despliegue
 * (Bolivia, Peru y Ecuador): tiene API REST para crear envios, webhooks
 * de estado y consulta por HTTP.
 *
 * IMPORTANTE SOBRE LOS CAMPOS: la API real devuelve nombres de campo
 * que varian segun la version del endpoint. Los tipos de abajo estan
 * definidos de forma que la capa de mapeo sea explicita y un cambio en
 * la respuesta del proveedor se note en un solo lugar en vez de
 * dispersarse por el sistema. Antes de producción hay que validar
 * estos tipos contra la respuesta real de la cuenta; por eso el
 * constructor valida que exista el token y falla rapido si no.
 *
 * Activacion: definir SHIPPINGDO_API_TOKEN y poner COURIER_PROVIDER=shippingdo.
 */

interface ShippingDoOrderResponse {
  data?: {
    order_id?: string;
    tracking_number?: string;
    tracking_code?: string;
    label_url?: string;
    price?: number | string;
    delivery_time?: number | string;
  };
  message?: string;
  errors?: Array<{ field?: string; message?: string }>;
}

interface ShippingDoTrackingResponse {
  data?: {
    tracking_code?: string;
    status?: string;
    events?: Array<ShippingDoEvent>;
    last_event?: ShippingDoEvent;
  };
  message?: string;
}

interface ShippingDoEvent {
  id?: string | number;
  status?: string;
  description?: string;
  location?: string;
  date?: string;
  created_at?: string;
}

export class ShippingDoAdapter implements CourierAdapter {
  readonly code = 'shippingdo';
  readonly displayName = 'Shipping-do';

  private readonly baseUrl: string;
  private readonly apiToken: string;
  private readonly webhookSecret: string;

  constructor() {
    if (!env.SHIPPINGDO_API_TOKEN) {
      throw new Error(
        'SHIPPINGDO_API_TOKEN es obligatorio para usar el adaptador de Shipping-do',
      );
    }
    this.baseUrl = env.SHIPPINGDO_BASE_URL.replace(/\/$/, '');
    this.apiToken = env.SHIPPINGDO_API_TOKEN;
    this.webhookSecret = env.SHIPPINGDO_WEBHOOK_SECRET;
  }

  private async request<T>(
    path: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;

    const response = await fetch(url, {
      method: init.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      logger.error(
        { provider: this.code, path, status: response.status, body: text.slice(0, 500) },
        'Courier: error en la peticion',
      );
      throw new CourierProviderError(
        this.code,
        `Shipping-do respondio ${response.status}`,
        response.status,
        text.slice(0, 1000),
      );
    }

    return (await response.json()) as T;
  }

  async createShipment(input: CreateCourierShipmentInput): Promise<CourierShipmentResult> {
    const payload = {
      order_code: input.reference,
      destination: {
        name: input.recipient.contactName,
        phone: input.recipient.phone,
        address: input.recipient.line1,
        address_2: input.recipient.line2 ?? undefined,
        city: input.recipient.city,
        state: input.recipient.region ?? undefined,
        zip: input.recipient.postalCode ?? undefined,
        country_code: input.recipient.countryCode,
      },
      origin: {
        name: input.sender.contactName,
        phone: input.sender.phone,
        address: input.sender.line1,
        address_2: input.sender.line2 ?? undefined,
        city: input.sender.city,
        state: input.sender.region ?? undefined,
        zip: input.sender.postalCode ?? undefined,
        country_code: input.sender.countryCode,
      },
      parcel: {
        weight: Number((input.weightGrams / 1000).toFixed(3)),
        declared_value: Number((input.declaredValueCents / 100).toFixed(2)),
        currency: input.currency,
        description: input.items.map((i) => `${i.quantity}x ${i.name}`).join(', ').slice(0, 500),
      },
      service_type: 'standard',
      generate_label: true,
    };

    const response = await this.request<ShippingDoOrderResponse>('/orders', {
      method: 'POST',
      body: payload,
    });

    const order = response.data;
    if (!order?.tracking_number) {
      throw new CourierProviderError(
        this.code,
        response.message ?? 'Shipping-do no devolvio un numero de seguimiento',
        undefined,
        response,
      );
    }

    return {
      providerShipmentId: order.order_id ?? order.tracking_number,
      trackingNumber: order.tracking_number,
      quotedCostCents: order.price ? Math.round(Number(order.price) * 100) : null,
      estimatedDays: order.delivery_time ? Number(order.delivery_time) : null,
      labelUrl: order.label_url ?? null,
      raw: response,
    };
  }

  async cancelShipment(providerShipmentId: string): Promise<boolean> {
    try {
      await this.request(`/orders/${encodeURIComponent(providerShipmentId)}/cancel`, {
        method: 'POST',
      });
      return true;
    } catch (error) {
      // Un 404 aqui significa que ya estaba cancelado o nunca existio:
      // se trata como exito para que la operacion sea idempotente.
      if (error instanceof CourierProviderError && error.statusCode === 404) return true;
      throw error;
    }
  }

  async getTracking(trackingNumber: string): Promise<CourierTrackingResult> {
    const response = await this.request<ShippingDoTrackingResponse>(
      `/tracking/${encodeURIComponent(trackingNumber)}`,
    );

    const data = response.data;
    if (!data) {
      throw new CourierProviderError(this.code, 'Respuesta de rastreo vacia', undefined, response);
    }

    const rawEvents = data.events ?? (data.last_event ? [data.last_event] : []);
    const events: CourierTrackingEvent[] = [];

    for (const raw of rawEvents) {
      const mapped = this.mapStatus(raw.status ?? '');
      if (!mapped) {
        logger.debug(
          { provider: this.code, providerStatus: raw.status },
          'Courier: estado sin mapear, se omite',
        );
        continue;
      }

      const dateValue = raw.date ?? raw.created_at;
      const occurredAt = dateValue ? new Date(dateValue) : new Date();
      if (Number.isNaN(occurredAt.getTime())) continue;

      events.push({
        // Si el proveedor no manda id, se sintetiza uno estable a partir
        // del contenido: evita que un evento sin id se duplique en cada
        // consulta y dispare el mismo cambio de estado N veces.
        providerEventId: raw.id ? String(raw.id) : this.synthesizeEventId(raw, occurredAt),
        status: mapped,
        description: raw.description ?? null,
        locationName: raw.location ?? null,
        occurredAt,
        raw,
      });
    }

    const currentStatus = this.mapStatus(data.status ?? '') ?? events.at(-1)?.status ?? 'IN_TRANSIT';

    return { trackingNumber, status: currentStatus, events, raw: response };
  }

  /**
   * Firma HMAC-SHA256 en hexadecimal, comparada en tiempo constante.
   *
   * Si el secreto no esta configurado, la verificacion SIEMPRE falla.
   * Es deliberado: un webhook sin secreto configurado no debe pasar
   * nunca, porque activarlo "para probar" dejaria abierta la puerta a
   * que cualquiera marque envios como entregados.
   */
  verifyWebhook(rawBody: Buffer, headers: Record<string, string | undefined>): boolean {
    if (!this.webhookSecret) {
      logger.error(
        { provider: this.code },
        'Webhook recibido pero SHIPPINGDO_WEBHOOK_SECRET no esta configurado: se rechaza',
      );
      return false;
    }

    const signature =
      headers['x-signature'] ??
      headers['x-hub-signature-256'] ??
      headers['x-shippingdo-signature'];

    if (!signature) return false;

    const expected = createHmac('sha256', this.webhookSecret).update(rawBody).digest('hex');
    const provided = signature.replace(/^sha256=/, '');

    const a = Buffer.from(provided, 'hex');
    const b = Buffer.from(expected, 'hex');
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      logger.warn({ provider: this.code }, 'Courier: firma de webhook invalida');
      return false;
    }
    return true;
  }

  mapStatus(providerStatus: string): ShipmentStatus | null {
    const normalized = providerStatus.trim().toLowerCase().replace(/[\s-]+/g, '_');
    return CANONICAL_STATUS_MAP[normalized] ?? null;
  }

  private synthesizeEventId(raw: { status?: string; description?: string; location?: string }, occurredAt: Date): string {
    const key = [raw.status, raw.description, raw.location, occurredAt.toISOString()].join('|');
    return `sd_${createHmac('sha256', this.webhookSecret || 'x').update(key).digest('hex').slice(0, 24)}`;
  }
}