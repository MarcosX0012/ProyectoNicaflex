import { prisma } from './prisma.js';

/**
 * Generacion del codigo de rastreo.
 *
 * REGLA INMUTABLE: un `trackingCode` nunca se reutiliza, nunca cambia
 * y nunca se reinicia por ano. Se apoya en la secuencia de Postgres
 * `shipment_code_seq`, que es monotona e infinita.
 *
 * Formato: HOS-<anio>-<secuencia con 6 digitos>   ej. HOS-2026-000042
 *
 * El ano es solo cosmetico (facilita la lectura en el QR impreso);
 * la unicidad la garantiza la secuencia, no el ano. Si el ano cambia a
 * mitad de ano, la secuencia continua sin repetirse.
 */

const CODE_PREFIX = 'HOS';
const MIN_SEQUENCE = 1;

function formatCode(year: number, sequence: number): string {
  return `${CODE_PREFIX}-${year}-${String(sequence).padStart(6, '0')}`;
}

export function parseTrackingCode(code: string): { prefix: string; year: number; sequence: number } | null {
  const match = /^([A-Z]{3})-(\d{4})-(\d{6,})$/.exec(code.toUpperCase());
  if (!match) return null;
  const [, prefix, year, seq] = match as unknown as [string, string, string, string];
  return { prefix, year: Number(year), sequence: Number(seq) };
}

export function isValidTrackingCode(code: string): boolean {
  return parseTrackingCode(code) !== null;
}

/** Normaliza la entrada del usuario: mayusculas, sin espacios. */
export function normalizeTrackingCode(input: string): string {
  return input.trim().toUpperCase().replace(/\s+/g, '');
}

const SEQUENCE_FETCH = `SELECT nextval('shipment_code_seq') AS seq`;

let yearStartSequence: number | null = null;

/**
 * Reserva el siguiente codigo. La secuencia es global y no se reinicia,
 * asi que este metodo nunca produce un codigo ya usado.
 *
 * Se usa `nextval` directamente en lugar de un autoincrement de Prisma
 * porque necesitamos el numero para formatearlo con el anio antes de
 * insertar la fila.
 */
export async function allocateTrackingCode(): Promise<string> {
  const rows = await prisma.$queryRawUnsafe<Array<{ seq: bigint }>>(SEQUENCE_FETCH);
  const sequence = Number(rows[0]?.seq ?? 0);
  if (!Number.isSafeInteger(sequence) || sequence < MIN_SEQUENCE) {
    throw new Error('No se pudo obtener el siguiente numero de secuencia de rastreo');
  }

  // Marca de agua del cambio de anio, para detectar reutilización en
  // pruebas. Solo informativo: no altera la garantia de unicidad.
  const currentYear = new Date().getUTCFullYear();
  if (yearStartSequence === null) {
    yearStartSequence = sequence;
  }

  return formatCode(currentYear, sequence);
}

/**
 * Verifica que un codigo no exista ya. Complementa a la restriccion
 * UNIQUE de la base de datos: esta es la comprobacion "amable"
 * (mensaje claro) y la BD es la garantia real.
 */
export async function assertCodeAvailable(code: string): Promise<void> {
  const existing = await prisma.shipment.findUnique({
    where: { trackingCode: code },
    select: { id: true },
  });
  if (existing) {
    throw new Error(`Colision de codigo de rastreo: ${code}`);
  }
}

/** Formatea un numero de dias/horas en una fecha estimada legible. */
export function buildEstimatedDelivery(businessDays = 3, from = new Date()): Date {
  const result = new Date(from);
  let added = 0;
  while (added < businessDays) {
    result.setUTCDate(result.getUTCDate() + 1);
    const day = result.getUTCDay();
    // Salta sabado y domingo.
    if (day !== 0 && day !== 6) added += 1;
  }
  return result;
}