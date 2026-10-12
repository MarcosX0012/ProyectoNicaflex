import type { ShipmentStatus } from '@prisma/client';

/**
 * CONTRATO DE INTEGRACION CON TRANSPORTISTAS
 * ==========================================
 *
 * Cada transportista tiene su API, sus estados y sus rarezas. La
 * solucion es un adaptador: el resto del sistema habla siempre este
 * contrato y nunca conoce detalles de un proveedor concreto.
 *
 * La consecuencia practica: cambiar de transportista, o soportar tres
 * a la vez, es escribir una clase nueva. No se toca ni el servicio de
 * envios ni la maquina de estados.
 *
 * Para agregar uno:
 *   1. Copiar la forma de `MockCourierAdapter`.
 *   2. Implementar `mapStatus` con TODOS los estados del proveedor.
 *   3. Registrar el proveedor en `src/modules/couriers/index.ts`.
 */

export interface CourierAddress {
  contactName: string;
  phone: string;
  line1: string;
  line2?: string | null;
  city: string;
  region?: string | null;
  postalCode?: string | null;
  countryCode: string;
}

export interface CreateCourierShipmentInput {
  /** Referencia interna. El proveedor la devuelve en sus webhooks. */
  reference: string;
  sender: CourierAddress;
  recipient: CourierAddress;
  weightGrams: number;
  declaredValueCents: number;
  currency: string;
  items: Array<{ name: string; quantity: number; sku?: string | null }>;
  /** Id de la sede de origen en el transportista, si aplica. */
  originBranchCode?: string | null;
}

export interface CourierShipmentResult {
  providerShipmentId: string;
  trackingNumber: string;
  /** Costo estimado, en centavos de la moneda del proveedor. */
  quotedCostCents?: number | null;
  estimatedDays?: number | null;
  labelUrl?: string | null;
  raw?: unknown;
}

export interface CourierTrackingEvent {
  /** Id del evento EN EL PROVEEDOR. Es la clave de idempotencia. */
  providerEventId: string;
  status: ShipmentStatus;
  description?: string | null;
  locationName?: string | null;
  occurredAt: Date;
  raw?: unknown;
}

export interface CourierTrackingResult {
  trackingNumber: string;
  status: ShipmentStatus;
  events: CourierTrackingEvent[];
  raw?: unknown;
}

export interface CourierAdapter {
  readonly code: string;
  readonly displayName: string;

  /** Crea el envio en el transportista. Lanza si el proveedor falla. */
  createShipment(input: CreateCourierShipmentInput): Promise<CourierShipmentResult>;

  /** Cancela un envio ya creado en el transportista. */
  cancelShipment(providerShipmentId: string): Promise<boolean>;

  /** Consulta el estado actual. Es el respaldo cuando no hay webhooks. */
  getTracking(trackingNumber: string): Promise<CourierTrackingResult>;

  /**
   * Verifica la firma del webhook. Es OBLIGATORIO: un endpoint de
   * webhook sin verificacion es una puerta abierta para que cualquiera
   * marque envios como entregados.
   */
  verifyWebhook(rawBody: Buffer, headers: Record<string, string | undefined>): boolean;

  /**
   * Normaliza los estados del proveedor a los del sistema. Todo estado
   * del proveedor DEBE quedar mapeado; lo que no se mapea se ignora.
   */
  mapStatus(providerStatus: string): ShipmentStatus | null;

  /**
   * Normalizacion opcional del payload de webhook. Solo la implementan
   * los adaptadores cuyo formato de respuesta se aparta de lo comun.
   * Si no existe, se usa el normalizador generico de webhooks/service.ts.
   */
  normalizeWebhook?(
    payload: unknown,
    self: CourierAdapter,
  ): { trackingNumber?: string; reference?: string; events: WebhookEvent[] } | null;
}

export interface WebhookEvent {
  providerEventId: string;
  status: ShipmentStatus;
  description?: string | null;
  locationName?: string | null;
  occurredAt: Date;
  raw?: unknown;
}

/**
 * Estados genericos que comparten la mayoria de transportistas.
 * Sirven de base para los adaptadores reales y documentan el mapa
 * canonico proveedor -> sistema.
 */
export const CANONICAL_STATUS_MAP: Record<string, ShipmentStatus> = {
  // Recoleccion
  created: 'CREATED',
  confirmed: 'CONFIRMED',
  pending: 'CREATED',
  collection_scheduled: 'AWAITING_PICKUP',
  awaiting_pickup: 'AWAITING_PICKUP',
  ready_for_pickup: 'AWAITING_PICKUP',
  // Transporte
  collected: 'PICKED_UP',
  picked_up: 'PICKED_UP',
  in_transit: 'IN_TRANSIT',
  in_transito: 'IN_TRANSIT',
  transit: 'IN_TRANSIT',
  // Sedes
  at_distribution_center: 'AT_DISTRIBUTION_CENTER',
  at_facility: 'AT_DISTRIBUTION_CENTER',
  processing: 'AT_DISTRIBUTION_CENTER',
  sorting: 'AT_DISTRIBUTION_CENTER',
  // Reparto
  out_for_delivery: 'OUT_FOR_DELIVERY',
  dispatched: 'OUT_FOR_DELIVERY',
  with_courier: 'OUT_FOR_DELIVERY',
  // Cierre
  delivered: 'DELIVERED',
  delivered_ok: 'DELIVERED',
  // Excepciones
  delivery_attempted: 'DELIVERY_ATTEMPTED',
  failed_delivery_attempt: 'DELIVERY_ATTEMPTED',
  not_delivered: 'DELIVERY_ATTEMPTED',
  on_hold: 'ON_HOLD',
  held: 'ON_HOLD',
  exception: 'EXCEPTION',
  delay: 'ON_HOLD',
  returning: 'RETURNING',
  return_to_sender: 'RETURNING',
  returned: 'RETURNED',
  lost: 'LOST',
  cancelled: 'CANCELLED',
  canceled: 'CANCELLED',
  rejected: 'RETURNING',
};

export class CourierProviderError extends Error {
  constructor(
    public readonly providerCode: string,
    message: string,
    public readonly statusCode?: number,
    public readonly raw?: unknown,
  ) {
    super(message);
    this.name = 'CourierProviderError';
  }
}