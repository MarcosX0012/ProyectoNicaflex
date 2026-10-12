import type { FastifyRequest } from 'fastify';
import { prisma } from './prisma.js';
import { logger } from './logger.js';

/**
 * Bitacora de seguridad y trazabilidad de acceso.
 *
 * Se registra toda lectura o escritura de datos de envio. Si un dia hay
 * una disputa ("yo nunca pedi ese paquete") o una filtracion, el
 * registro responde quien consulto que y cuando.
 *
 * Nunca bloquea la operacion principal: un fallo de auditoria se
 * registra en el log pero no invalida la peticion. Perder una linea
 * de bitacora es malo; caerse el sistema por escribir la bitacora es
 * peor. En produccion, los errores de auditoria deben alimentar una
 * alerta de observabilidad.
 */

export interface AuditEntry {
  userId?: string | null;
  action: string;
  entity: string;
  entityId?: string | null;
  shipmentCode?: string | null;
  outcome?: 'SUCCESS' | 'DENIED' | 'FAILED';
  metadata?: Record<string, unknown>;
  /** El rol que se uso, util cuando el usuario tiene varios. */
  role?: string | null;
}

export async function recordAudit(
  entry: AuditEntry,
  req?: FastifyRequest,
): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        userId: entry.userId ?? null,
        action: entry.action,
        entity: entry.entity,
        entityId: entry.entityId ?? null,
        shipmentCode: entry.shipmentCode ?? null,
        outcome: entry.outcome ?? 'SUCCESS',
        ip: req?.ip ?? null,
        userAgent: req?.headers['user-agent']?.slice(0, 400) ?? null,
        metadata: entry.metadata
          ? {
              ...entry.metadata,
              ...(entry.role ? { role: entry.role } : {}),
            }
          : entry.role
            ? { role: entry.role }
            : undefined,
      },
    });
  } catch (error) {
    logger.error({ err: error, action: entry.action }, 'Fallo al escribir la bitacora');
  }
}

/**
 * Variante para endpoints publicos (sin usuario): deja rastro de los
 * intentos de consulta al rastreo publico, que es la superficie mas
 * expuesta a enumeracion de codigos.
 */
export async function recordPublicTrackingAccess(
  trackingCode: string,
  outcome: 'SUCCESS' | 'DENIED' | 'FAILED',
  req?: FastifyRequest,
  note?: string,
): Promise<void> {
  await recordAudit(
    {
      action: 'TRACKING_PUBLIC_VIEW',
      entity: 'Shipment',
      shipmentCode: trackingCode,
      outcome,
      metadata: note ? { note } : undefined,
    },
    req,
  );
}