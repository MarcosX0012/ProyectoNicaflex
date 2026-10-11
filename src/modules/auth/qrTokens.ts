import crypto from 'node:crypto';
import { env } from '../../config/env.js';

/**
 * TOKEN FIRMADO DE RASTREO
 * ========================
 *
 * El QR impreso lleva un token firmado, no el codigo de rastreo pelado.
 * El token tiene tres ventajas frente a un enlace `/track/HOS-2026-000123`:
 *
 *  1. AUTOCONTENIDO. La firma se valida con el secreto, sin consultar la
 *     base. Un escaner puede verificar el enlace sin llamada extra.
 *
 *  2. NO ALTERABLE. Si alguien edita el codigo dentro de la URL, la
 *     firma deja de coincidir y el enlace se rechaza. Un QR manipulado
 *     no lleva a otro envio.
 *
 *  3. REVOCABLE POR ANTIGUEDAD. El token lleva `issuedAt`, asi que si
 *     hay que invalidar una tanda de etiquetas impresas se rechaza lo
 *     emitido antes de una fecha, sin tocar los envios ya registrados.
 *
 * El sistema guarda el HASH del token en `shipments.qrTokenHash`, no el
 * token. Asi, si alguien obtiene un volcado de la base, no puede
 * reconstruir enlaces de rastreo validos a partir de el.
 */

export interface VerifiedTrackingToken {
  trackingCode: string;
  issuedAt: number;
}

export function signTrackingToken(trackingCode: string): string {
  const issuedAt = Math.floor(Date.now() / 1000);
  const payload = `${trackingCode}.${issuedAt}`;
  const signature = crypto
    .createHmac('sha256', env.trackingSigningSecret)
    .update(payload)
    .digest('base64url');

  return Buffer.from(`${payload}.${signature}`).toString('base64url');
}

export function verifyTrackingToken(encoded: string): VerifiedTrackingToken | null {
  try {
    const decoded = Buffer.from(encoded, 'base64url').toString('utf8');
    const parts = decoded.split('.');

    if (parts.length !== 3) return null;

    const [trackingCode, issuedAtStr, signature] = parts as [string, string, string];

    const expected = crypto
      .createHmac('sha256', env.trackingSigningSecret)
      .update(`${trackingCode}.${issuedAtStr}`)
      .digest('base64url');

    const provided = Buffer.from(signature);
    const calculated = Buffer.from(expected);

    // Comparacion en tiempo constante: si se comparan con `===`, el
    // tiempo de respuesta revela cuantos caracteres correctos hay y
    // permite reconstruir la firma byte a byte.
    if (provided.length !== calculated.length || !crypto.timingSafeEqual(provided, calculated)) {
      return null;
    }

    const issuedAt = Number(issuedAtStr);
    if (!Number.isFinite(issuedAt)) return null;

    return { trackingCode, issuedAt };
  } catch {
    return null;
  }
}

/** Antiguedad maxima aceptada de un token de QR. */
const MAX_TOKEN_AGE_SECONDS = 60 * 60 * 24 * 365 * 3;

export function isTrackingTokenExpired(
  token: VerifiedTrackingToken,
  maxAgeSeconds = MAX_TOKEN_AGE_SECONDS,
): boolean {
  const age = Math.floor(Date.now() / 1000) - token.issuedAt;
  return age > maxAgeSeconds || age < -300;
}