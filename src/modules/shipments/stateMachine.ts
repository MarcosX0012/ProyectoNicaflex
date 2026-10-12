import { ShipmentStatus } from '@prisma/client';
import { invalidTransition } from '../../lib/errors.js';

/**
 * MAQUINA DE ESTADOS DE UN ENVIO
 * ===============================
 *
 * Este archivo es la fuente de verdad del proceso logistico. Ningun
 * evento puede mover un envio a un estado que no este permitido aqui,
 * sin importar si el evento viene de la API del courier, de un webhook,
 * de un operador o de una regla automatica.
 *
 * Esto resuelve el problema central de los sistemas de rastreo: un
 * proveedor mal implementado (o un webhook duplicado y desordenado)
 * puede "resucitar" un paquete entregado, saltarse etapas o escribir
 * historial incoherente. Aqui eso no puede ocurrir.
 *
 * Properties:
 *  - Transicion invalida  => error 409, el historial NO se toca.
 *  - Entrega confirmada   => el envio queda sellado (ninguna salida
 *                            posterior es valida salvo una solicitud
 *                            explicita de investigacion).
 */

// ── Definicion de cada estado ─────────────────────────────────

export interface StatusDefinition {
  status: ShipmentStatus;
  /** Nombre visible en la linea de tiempo (espanol). */
  label: string;
  /** Descripcion larga para la vista publica. */
  description: string;
  /** Fase del proceso, para agrupar en la interfaz. */
  phase: 'preparacion' | 'recoleccion' | 'transito' | 'cierre' | 'excepcion';
  /** Icono sugerido para el frontend (nombres, no imports). */
  icon: string;
  /** Si es un estado final no reversible sin intervencion humana. */
  isTerminal: boolean;
  /** Si aplica excepcion: puede ocurrir en cualquier momento. */
  isException: boolean;
  /** Color sugerido: ok | info | warn | danger | neutral. */
  tone: 'ok' | 'info' | 'warn' | 'danger' | 'neutral';
}

export const STATUS_DEFINITIONS: Record<ShipmentStatus, StatusDefinition> = {
  CREATED: {
    status: 'CREATED',
    label: 'Envio creado',
    description: 'El envio fue registrado y esta pendiente de confirmacion.',
    phase: 'preparacion',
    icon: 'file-plus',
    isTerminal: false,
    isException: false,
    tone: 'neutral',
  },
  CONFIRMED: {
    status: 'CONFIRMED',
    label: 'Envio confirmado',
    description: 'Los datos del envio fueron validados por el sistema.',
    phase: 'preparacion',
    icon: 'check-circle',
    isTerminal: false,
    isException: false,
    tone: 'info',
  },
  AWAITING_PAYMENT: {
    status: 'AWAITING_PAYMENT',
    label: 'Esperando pago',
    description: 'Falta confirmar el pago para continuar con el envio.',
    phase: 'preparacion',
    icon: 'credit-card',
    isTerminal: false,
    isException: false,
    tone: 'warn',
  },
  AWAITING_PICKUP: {
    status: 'AWAITING_PICKUP',
    label: 'En espera de recoleccion',
    description: 'El paquete esta listo y espera ser recogido por el courier.',
    phase: 'recoleccion',
    icon: 'package',
    isTerminal: false,
    isException: false,
    tone: 'info',
  },
  PICKED_UP: {
    status: 'PICKED_UP',
    label: 'Recolectado',
    description: 'El courier recogio el paquete.',
    phase: 'recoleccion',
    icon: 'truck',
    isTerminal: false,
    isException: false,
    tone: 'info',
  },
  IN_TRANSIT: {
    status: 'IN_TRANSIT',
    label: 'En transito',
    description: 'El paquete viaja hacia su destino.',
    phase: 'transito',
    icon: 'route',
    isTerminal: false,
    isException: false,
    tone: 'info',
  },
  AT_DISTRIBUTION_CENTER: {
    status: 'AT_DISTRIBUTION_CENTER',
    label: 'En centro de distribucion',
    description: 'El paquete se encuentra en una sede de distribucion.',
    phase: 'transito',
    icon: 'warehouse',
    isTerminal: false,
    isException: false,
    tone: 'info',
  },
  OUT_FOR_DELIVERY: {
    status: 'OUT_FOR_DELIVERY',
    label: 'En reparto',
    description: 'El repartidor esta delivering en la direccion de destino.',
    phase: 'cierre',
    icon: 'bike',
    isTerminal: false,
    isException: false,
    tone: 'info',
  },
  DELIVERY_ATTEMPTED: {
    status: 'DELIVERY_ATTEMPTED',
    label: 'Intento de entrega no exitoso',
    description: 'No se pudo entregar. El courier intento contactarse con el receptor.',
    phase: 'excepcion',
    icon: 'alert-triangle',
    isTerminal: false,
    isException: true,
    tone: 'warn',
  },
  DELIVERED: {
    status: 'DELIVERED',
    label: 'Entregado',
    description: 'El paquete fue entregado y recibido por el receptor.',
    phase: 'cierre',
    icon: 'check-check',
    isTerminal: true,
    isException: false,
    tone: 'ok',
  },
  ON_HOLD: {
    status: 'ON_HOLD',
    label: 'En espera',
    description: 'El envio esta detenido temporalmente por un motivo definido.',
    phase: 'excepcion',
    icon: 'pause-circle',
    isTerminal: false,
    isException: true,
    tone: 'warn',
  },
  EXCEPTION: {
    status: 'EXCEPTION',
    label: 'Incidencia',
    description: 'Ocurrio un problema que requiere atencion del equipo.',
    phase: 'excepcion',
    icon: 'alert-octagon',
    isTerminal: false,
    isException: true,
    tone: 'danger',
  },
  RETURNING: {
    status: 'RETURNING',
    label: 'En devolucion',
    description: 'El paquete regresa al remitente.',
    phase: 'excepcion',
    icon: 'undo',
    isTerminal: false,
    isException: true,
    tone: 'warn',
  },
  RETURNED: {
    status: 'RETURNED',
    label: 'Devuelto',
    description: 'El paquete fue devuelto al remitente.',
    phase: 'cierre',
    icon: 'corner-up-left',
    isTerminal: true,
    isException: false,
    tone: 'neutral',
  },
  LOST: {
    status: 'LOST',
    label: 'Extraviado',
    description: 'El paquete fue marcado como extraviado y esta en investigacion.',
    phase: 'excepcion',
    icon: 'help-circle',
    isTerminal: true,
    isException: true,
    tone: 'danger',
  },
  CANCELLED: {
    status: 'CANCELLED',
    label: 'Cancelado',
    description: 'El envio fue cancelado antes de ser despachado.',
    phase: 'cierre',
    icon: 'x-circle',
    isTerminal: true,
    isException: false,
    tone: 'neutral',
  },
};

// ── Transiciones permitidas ──────────────────────────────────

const HAPPY_PATH: ShipmentStatus[] = [
  'CREATED',
  'CONFIRMED',
  'AWAITING_PAYMENT',
  'AWAITING_PICKUP',
  'PICKED_UP',
  'IN_TRANSIT',
  'AT_DISTRIBUTION_CENTER',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
];

type TransitionMap = Record<ShipmentStatus, ShipmentStatus[]>;

function buildTransitionMap(): TransitionMap {
  const map = {} as TransitionMap;

  // Camino feliz: avanzar al siguiente estado de la secuencia.
  HAPPY_PATH.forEach((status, index) => {
    const next = HAPPY_PATH[index + 1];
    const forward = next ? [next] : [];
    // Ademas, a los estados que quedan sin excepcion cerrada se puede
    // saltar de forma explicita (por ejemplo, un envio pequeno que va
    // directo de recoleccion a reparto).
    map[status] = [...forward];
  });

  // Saltos logicos permitidos en la operacion real.
  map.CREATED = ['CONFIRMED', 'AWAITING_PAYMENT', 'CANCELLED'];
  map.CONFIRMED = [
    'AWAITING_PAYMENT',
    'AWAITING_PICKUP',
    'PICKED_UP',
    'EXCEPTION',
    'ON_HOLD',
    'CANCELLED',
  ];
  map.AWAITING_PAYMENT = [
    'AWAITING_PICKUP',
    'PICKED_UP',
    'EXCEPTION',
    'ON_HOLD',
    'CANCELLED',
    // Volver a CONFIRMED ocurre cuando el pago se cancela y el envio
    // debe reevaluarse. Es la unica forma de "deshacer" la espera.
    'CONFIRMED',
  ];
  map.AWAITING_PICKUP = ['PICKED_UP', 'ON_HOLD', 'EXCEPTION', 'CANCELLED'];
  map.PICKED_UP = ['IN_TRANSIT', 'AT_DISTRIBUTION_CENTER', 'EXCEPTION', 'ON_HOLD'];
  map.IN_TRANSIT = ['AT_DISTRIBUTION_CENTER', 'OUT_FOR_DELIVERY', 'RETURNING', 'EXCEPTION', 'ON_HOLD'];
  map.AT_DISTRIBUTION_CENTER = [
    'IN_TRANSIT',
    'OUT_FOR_DELIVERY',
    'RETURNING',
    'EXCEPTION',
    'ON_HOLD',
  ];
  map.OUT_FOR_DELIVERY = ['DELIVERED', 'DELIVERY_ATTEMPTED', 'RETURNING', 'EXCEPTION'];
  // Un intento fallido puede reintentarse o devolverse.
  map.DELIVERY_ATTEMPTED = [
    'OUT_FOR_DELIVERY',
    'DELIVERED',
    'RETURNING',
    'EXCEPTION',
    'ON_HOLD',
  ];
  map.ON_HOLD = ['IN_TRANSIT', 'AT_DISTRIBUTION_CENTER', 'OUT_FOR_DELIVERY', 'PICKED_UP', 'EXCEPTION', 'CANCELLED', 'RETURNING'];
  map.EXCEPTION = ['IN_TRANSIT', 'AT_DISTRIBUTION_CENTER', 'OUT_FOR_DELIVERY', 'RETURNING', 'LOST', 'DELIVERED', 'ON_HOLD'];
  map.RETURNING = ['RETURNED', 'IN_TRANSIT', 'EXCEPTION'];

  // Estados terminales: bloqueados. Un envio entregado no vuelve a "en transito".
  map.DELIVERED = [];
  map.RETURNED = [];
  map.LOST = [];
  map.CANCELLED = [];

  return map;
}

export const ALLOWED_TRANSITIONS: TransitionMap = buildTransitionMap();

export function canTransition(from: ShipmentStatus, to: ShipmentStatus): boolean {
  if (from === to) return false;
  return (ALLOWED_TRANSITIONS[from] ?? []).includes(to);
}

export function allowedNextStates(from: ShipmentStatus): ShipmentStatus[] {
  return ALLOWED_TRANSITIONS[from] ?? [];
}

export function assertTransition(from: ShipmentStatus, to: ShipmentStatus): void {
  if (from === to) return; // Reemision del mismo estado: no-op silencioso.
  if (!canTransition(from, to)) {
    throw invalidTransition(from, to, allowedNextStates(from));
  }
}

export function isTerminal(status: ShipmentStatus): boolean {
  return STATUS_DEFINITIONS[status]?.isTerminal ?? false;
}

export function isException(status: ShipmentStatus): boolean {
  return STATUS_DEFINITIONS[status]?.isException ?? false;
}

/** Un envio sigue "vivo" si no llego a un estado terminal. */
export function isActive(status: ShipmentStatus): boolean {
  return !isTerminal(status);
}

/**
 * Un envio se considera entregado de forma confiable solo cuando
 * estado Y prueba coinciden. `DELIVERED` sin `deliveredAt` indica
 * que el evento llego por una via no verificada (webhook del courier).
 */
export function isConfirmedDelivery(status: ShipmentStatus, deliveredAt: Date | null): boolean {
  return status === 'DELIVERED' && deliveredAt !== null;
}

// ── Helper de orden para la linea de tiempo ──────────────────

const PHASE_ORDER: Record<StatusDefinition['phase'], number> = {
  preparacion: 0,
  recoleccion: 1,
  transito: 2,
  cierre: 3,
  excepcion: 4,
};

export function phaseRank(status: ShipmentStatus): number {
  return PHASE_ORDER[STATUS_DEFINITIONS[status]?.phase ?? 'excepcion'] ?? 4;
}

/** Etiquetas legibles de los estados permitidos, para mensajes de error. */
export function labelOf(status: ShipmentStatus): string {
  return STATUS_DEFINITIONS[status]?.label ?? status;
}