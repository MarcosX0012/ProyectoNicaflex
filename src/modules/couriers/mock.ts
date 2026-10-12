import { randomUUID } from 'node:crypto';
import type { ShipmentStatus } from '@prisma/client';
import { logger } from '../../lib/logger.js';
import { sha256 } from '../../lib/crypto.js';
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
 * ADAPTADOR SIMULADO
 * ==================
 *
 * Implementa el contrato completo sin llamar a nadie. Sirve para tres
 * cosas, todas necesarias antes de tener un contrato real:
 *
 *   1. Developing y pruebas de la API sin depender del transportista.
 *   2. Definir el comportamiento esperado de las integraciones: si la
 *      maquina de estados se rompe con este adaptador, se rompe igual
 *      con uno real.
 *   3. Generar una linea de tiempo completa para demostrar el sistema.
 *
 * En staging, `COURIER_PROVIDER=mock` con `MOCK_COURIER_AUTOADVANCE`
 * permite ver el envio recorrer todo el flujo.
 */

const AUTO_ADVANCE_MS = Number(process.env.MOCK_COURIER_AUTOADVANCE_MS ?? 0);

/** Secuencia de estados que recorre un envio simulado. */
const SIMULATION_PATH: ShipmentStatus[] = [
  'PICKED_UP',
  'IN_TRANSIT',
  'AT_DISTRIBUTION_CENTER',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
];

interface MockShipmentState {
  reference: string;
  providerShipmentId: string;
  trackingNumber: string;
  currentIndex: number;
  status: ShipmentStatus;
  createdAt: Date;
  recipientCity: string;
  events: CourierTrackingEvent[];
}

// Estado en memoria. Aclaracion importante: esto NO sobrevive a un
// reinicio y NO se comparte entre instancias. Es aceptable porque el
// adaptador es de desarrollo; un adaptador real consulta al proveedor.
const mockStore = new Map<string, MockShipmentState>();

export class MockCourierAdapter implements CourierAdapter {
  readonly code = 'mock';
  readonly displayName = 'Transportista Simulado';

  async createShipment(input: CreateCourierShipmentInput): Promise<CourierShipmentResult> {
    const providerShipmentId = `mock_ship_${randomUUID().slice(0, 12)}`;
    // Determinista a partir de la referencia: el mismo envio de prueba
    // siempre produce el mismo numero, util en datos de ejemplo.
    const trackingNumber = `MOCK${sha256(input.reference).slice(0, 10).toUpperCase()}`;

    const now = new Date();
    const state: MockShipmentState = {
      reference: input.reference,
      providerShipmentId,
      trackingNumber,
      currentIndex: -1,
      status: 'AWAITING_PICKUP',
      createdAt: now,
      recipientCity: input.recipient.city,
      events: [],
    };
    mockStore.set(trackingNumber, state);
    mockStore.set(input.reference, state);

    logger.info(
      { providerShipmentId, trackingNumber, city: input.recipient.city },
      'Mock: envio creado',
    );

    if (AUTO_ADVANCE_MS > 0) this.scheduleAutoAdvance(state);

    return {
      providerShipmentId,
      trackingNumber,
      quotedCostCents: 1500 + Math.floor(input.weightGrams / 100) * 2,
      estimatedDays: 3,
      labelUrl: `http://localhost:3000/api/dev/labels/${providerShipmentId}.pdf`,
      raw: { simulated: true },
    };
  }

  async cancelShipment(providerShipmentId: string): Promise<boolean> {
    for (const state of mockStore.values()) {
      if (state.providerShipmentId === providerShipmentId) {
        state.status = 'CANCELLED';
        return true;
      }
    }
    return false;
  }

  async getTracking(trackingNumber: string): Promise<CourierTrackingResult> {
    const state = mockStore.get(trackingNumber);
    if (!state) {
      throw new CourierProviderError(
        this.code,
        `No se encontro el envio ${trackingNumber} en el transportista simulado`,
        404,
      );
    }

    return {
      trackingNumber,
      status: state.status,
      events: [...state.events],
      raw: { simulated: true, reference: state.reference },
    };
  }

  /**
   * "Firma" simulada: HMAC del cuerpo con el secreto del proveedor.
   * Hace que las pruebas del flujo de webhook sean realistas.
   */
  verifyWebhook(rawBody: Buffer, headers: Record<string, string | undefined>): boolean {
    const signature = headers['x-mock-signature'];
    if (!signature) return false;

    const secret = process.env.SHIPPINGDO_WEBHOOK_SECRET || 'mock-secret';
    const { createHmac, timingSafeEqual } = require('node:crypto') as typeof import('node:crypto');
    const expected = createHmac('sha256', secret).update(rawBody).digest('hex');

    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  mapStatus(providerStatus: string): ShipmentStatus | null {
    return CANONICAL_STATUS_MAP[providerStatus.trim().toLowerCase()] ?? null;
  }

  // ── Utilidades de prueba ────────────────────────────────────

  /** Avanza el envio simulado un paso. Lo usa el endpoint de desarrollo. */
  advance(trackingNumber: string): CourierTrackingEvent | null {
    const state = mockStore.get(trackingNumber);
    if (!state) return null;

    const nextIndex = state.currentIndex + 1;
    if (nextIndex >= SIMULATION_PATH.length) return null;

    const status = SIMULATION_PATH[nextIndex]!;
    const occurredAt = new Date(Date.now() + nextIndex * 1000);
    const event = this.buildEvent(state, status, occurredAt);

    state.currentIndex = nextIndex;
    state.status = status;
    state.events.push(event);

    return event;
  }

  private buildEvent(
    state: MockShipmentState,
    status: ShipmentStatus,
    occurredAt: Date,
  ): CourierTrackingEvent {
    const descriptions: Partial<Record<ShipmentStatus, string>> = {
      PICKED_UP: 'El paquete fue recogido por el transportista.',
      IN_TRANSIT: `El paquete viaja hacia ${state.recipientCity}.`,
      AT_DISTRIBUTION_CENTER: 'El paquete ingreso al centro de distribucion.',
      OUT_FOR_DELIVERY: 'El repartidor salio con el paquete.',
      DELIVERED: 'El paquete fue entregado en destino.',
    };

    return {
      providerEventId: `mock_evt_${randomUUID().slice(0, 12)}`,
      status,
      description: descriptions[status] ?? null,
      locationName: status === 'IN_TRANSIT' ? 'En ruta' : state.recipientCity,
      occurredAt,
      raw: { simulated: true },
    };
  }

  private scheduleAutoAdvance(state: MockShipmentState): void {
    // Se programa con setTimeout en lugar de un cron: es un simulador,
    // no un proceso de negocio. Los tiempos son acumulativos.
    let delay = AUTO_ADVANCE_MS;
    for (let index = 0; index < SIMULATION_PATH.length; index += 1) {
      const timer = setTimeout(() => {
        const nextIndex = state.currentIndex + 1;
        if (nextIndex >= SIMULATION_PATH.length) return;
        const status = SIMULATION_PATH[nextIndex]!;
        const event = this.buildEvent(state, status, new Date());
        state.currentIndex = nextIndex;
        state.status = status;
        state.events.push(event);
        logger.info({ trackingNumber: state.trackingNumber, status }, 'Mock: envio avanzado');
      }, delay);
      timer.unref?.();
      delay += AUTO_ADVANCE_MS;
    }
  }
}

/** Reinicia el estado simulado. Solo para pruebas. */
export function resetMockStore(): void {
  mockStore.clear();
}

export { SIMULATION_PATH };