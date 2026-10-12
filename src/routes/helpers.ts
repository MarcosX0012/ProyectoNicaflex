import type { ShipmentStatus, UserRole } from '@prisma/client';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AccessTokenClaims } from '../modules/auth/tokens.js';
import { STATUS_DEFINITIONS } from '../modules/shipments/stateMachine.js';

export { STATUS_DEFINITIONS };

/** Etiqueta legible de un estado, para las respuestas de la API. */
export function statusLabelOf(status: ShipmentStatus): string {
  return STATUS_DEFINITIONS[status]?.label ?? status;
}

/** Definicion completa del estado (etiqueta, icono, tono, fase). */
export function statusMetaOf(status: ShipmentStatus) {
  const definition = STATUS_DEFINITIONS[status];
  return {
    status,
    label: definition?.label ?? status,
    description: definition?.description ?? '',
    icon: definition?.icon ?? 'package',
    tone: definition?.tone ?? 'neutral',
    phase: definition?.phase ?? 'excepcion',
    isTerminal: definition?.isTerminal ?? false,
  };
}

export type { AccessTokenClaims };

/**
 * Atajo para exigir roles sin repetir `app.requireRole(...)`.
 * Devuelve el preHandler ya enlazado a esta instancia.
 */
export function requireRole(
  app: FastifyInstance,
  ...roles: UserRole[]
): (req: FastifyRequest) => Promise<void> {
  return app.requireRole(...roles);
}