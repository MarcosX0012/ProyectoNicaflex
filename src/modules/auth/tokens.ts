import crypto from 'node:crypto';
import { env } from '../../config/env.js';
import { prisma } from '../../lib/prisma.js';
import { sha256, randomToken, blindIndex, numericCode } from '../../lib/crypto.js';
import type { User, UserRole } from '@prisma/client';

/**
 * Emision y rotacion de tokens.
 *
 * Decisiones de seguridad que conviene no revertir sin entenderlas:
 *
 * 1. JWT de acceso corto (15 min) + refresh token opaco rotativo.
 *    El JWT es autocontenido y no revocable, asi que debe durar poco.
 *    El refresh es opaco (cadena aleatoria), se guarda hasheado en BD
 *    y por eso SI se puede revocar.
 *
 * 2. Deteccion de reutilizacion de refresh token. Cada refresh pertenece
 *    a una "familia". Si llega un token ya rotado (es decir, alguien
 *    robo una copia old), se revoca la familia completa y se cierra la
 *    sesion del atacante y de la victima por separado. Es la unica
 *    forma de detectar un robo de credencial de forma fiable.
 *
 * 3. Contraseñas con Argon2id: resistente a GPU y ataques de memoria.
 *    bcrypt se considera hoy mas débil; scrypt seria aceptable pero
 *    argon2id es la recomendacion actual (OWASP).
 */

// ── Access token ───────────────────────────────────────────────

export interface AccessTokenClaims {
  sub: string;
  email: string;
  roles: UserRole[];
  name: string;
}

export function signAccessToken(user: {
  id: string;
  email: string;
  roles: UserRole[];
  firstName: string;
  lastName: string;
}): { token: string; expiresInSeconds: number } {
  const claims: AccessTokenClaims = {
    sub: user.id,
    email: user.email,
    roles: user.roles,
    name: `${user.firstName} ${user.lastName}`.trim(),
  };

  // jwt.sign sin el flag `expiresIn` para controlar el tiempo aqui y
  // que el valor coincida con env.jwtAccessTtlSeconds.
  const token = signJwt(claims, env.jwtAccessTtlSeconds);
  return { token, expiresInSeconds: env.jwtAccessTtlSeconds };
}

function signJwt(claims: AccessTokenClaims, ttlSeconds: number): string {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const payload = { ...claims, iat: now, exp: now + ttlSeconds, iss: 'hossana' };

  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString('base64url');

  const unsigned = `${encode(header)}.${encode(payload)}`;
  const signature = crypto
    .createHmac('sha256', env.jwtSecret)
    .update(unsigned)
    .digest('base64url');

  return `${unsigned}.${signature}`;
}

export function verifyAccessToken(token: string): AccessTokenClaims {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Token mal formado');

  const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];
  const unsigned = `${headerB64}.${payloadB64}`;
  const expected = crypto
    .createHmac('sha256', env.jwtSecret)
    .update(unsigned)
    .digest('base64url');

  const sigA = Buffer.from(signatureB64);
  const sigB = Buffer.from(expected);
  if (sigA.length !== sigB.length || !crypto.timingSafeEqual(sigA, sigB)) {
    throw new Error('Firma invalida');
  }

  const payload = JSON.parse(
    Buffer.from(payloadB64, 'base64url').toString('utf8'),
  ) as AccessTokenClaims & { exp: number; iss: string };

  if (payload.iss !== 'hossana') throw new Error('Emisor invalido');
  if (typeof payload.exp !== 'number' || payload.exp * 1000 < Date.now()) {
    throw new Error('Token expirado');
  }
  return payload;
}

// ── Refresh tokens ─────────────────────────────────────────────

export interface IssuedRefreshToken {
  token: string;
  familyId: string;
  expiresAt: Date;
}

export async function issueRefreshToken(
  userId: string,
  familyId: string,
  context: { userAgent?: string | null; ip?: string | null } = {},
): Promise<IssuedRefreshToken> {
  const token = randomToken(48);
  const expiresAt = new Date(Date.now() + env.jwtRefreshTtlMs);

  await prisma.refreshToken.create({
    data: {
      userId,
      familyId,
      tokenHash: sha256(token),
      expiresAt,
      userAgent: context.userAgent?.slice(0, 400) ?? null,
      ip: context.ip ?? null,
    },
  });

  return { token, familyId, expiresAt };
}

/**
 * Valida un refresh token. Si ya estaba rotado, esto es un robo:
 * se revoca la familia completa.
 */
export async function consumeRefreshToken(
  rawToken: string,
): Promise<{ userId: string; familyId: string }> {
  const record = await prisma.refreshToken.findUnique({
    where: { tokenHash: sha256(rawToken) },
  });

  if (!record) {
    throw new Error('Refresh token desconocido');
  }

  if (record.revokedAt !== null) {
    // Reutilizacion de un token ya rotado: cerró la familia entera.
    await prisma.refreshToken.updateMany({
      where: { familyId: record.familyId, revokedAt: null },
      data: { revokedAt: new Date(), reason: 'REUSE_DETECTED' },
    });
    throw new Error('Reutilizacion de refresh token detectada; sesion revocada');
  }

  if (record.expiresAt < new Date()) {
    throw new Error('Refresh token expirado');
  }

  return { userId: record.userId, familyId: record.familyId };
}

export async function revokeRefreshToken(rawToken: string, reason = 'LOGOUT'): Promise<void> {
  const record = await prisma.refreshToken.findUnique({
    where: { tokenHash: sha256(rawToken) },
    select: { familyId: true },
  });
  if (!record) return;

  // En el logout se revoca toda la familia: cierra la sesion en todos
  // los dispositivos, que es lo que espera quien cierra sesion.
  await prisma.refreshToken.updateMany({
    where: { familyId: record.familyId, revokedAt: null },
    data: { revokedAt: new Date(), reason },
  });
}

export async function revokeAllSessions(userId: string, reason: string): Promise<number> {
  const result = await prisma.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date(), reason },
  });
  return result.count;
}

export async function listSessions(userId: string) {
  return prisma.refreshToken.findMany({
    where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
    select: {
      id: true,
      familyId: true,
      userAgent: true,
      ip: true,
      createdAt: true,
      expiresAt: true,
    },
    orderBy: { createdAt: 'desc' },
  });
}

// ── Tokens de un solo uso (verificacion, recuperacion) ────────

const VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;
const RESET_TTL_MS = 60 * 60 * 1000;

export async function issueVerificationToken(
  userId: string,
  purpose: 'EMAIL_VERIFICATION' | 'PASSWORD_RESET',
): Promise<string> {
  // Un token activo por proposito: emitir uno nuevo invalida el anterior.
  await prisma.verificationToken.updateMany({
    where: { userId, purpose, consumedAt: null },
    data: { consumedAt: new Date() },
  });

  const token = randomToken(32);
  const ttl = purpose === 'EMAIL_VERIFICATION' ? VERIFICATION_TTL_MS : RESET_TTL_MS;

  await prisma.verificationToken.create({
    data: {
      userId,
      purpose,
      codeHash: sha256(token),
      expiresAt: new Date(Date.now() + ttl),
    },
  });

  return token;
}

export async function consumeVerificationToken(
  token: string,
  purpose: 'EMAIL_VERIFICATION' | 'PASSWORD_RESET',
): Promise<string> {
  const record = await prisma.verificationToken.findUnique({
    where: { codeHash: sha256(token) },
  });

  if (!record || record.purpose !== purpose) throw new Error('Token invalido');
  if (record.consumedAt !== null) throw new Error('Token ya utilizado');
  if (record.expiresAt < new Date()) throw new Error('Token expirado');

  await prisma.verificationToken.update({
    where: { id: record.id },
    data: { consumedAt: new Date() },
  });

  return record.userId;
}

// ── OTP de confirmacion de entrega ─────────────────────────────

const OTP_TTL_MS = 10 * 60 * 1000;
export const OTP_MAX_ATTEMPTS = 5;

export interface IssuedOtp {
  code: string;
  expiresAt: Date;
}

export async function issueOtp(
  userId: string,
  shipmentId: string | null,
  purpose: 'DELIVERY_CONFIRMATION' | 'EMAIL_VERIFICATION' | 'PHONE_VERIFICATION',
): Promise<IssuedOtp> {
  // Anula OTPs previos vivos del mismo proposito y envio.
  await prisma.otpCode.updateMany({
    where: { userId, shipmentId, purpose, consumedAt: null },
    data: { consumedAt: new Date() },
  });

  const code = numericCode(6);
  const expiresAt = new Date(Date.now() + OTP_TTL_MS);

  await prisma.otpCode.create({
    data: {
      userId,
      shipmentId,
      purpose,
      codeHash: sha256(code),
      expiresAt,
    },
  });

  return { code, expiresAt };
}

/**
 * Verifica un OTP. Cuenta intentos para frenar el ataque por
 * fuerza bruta sobre un codigo de 6 digitos (un milion de intentos).
 */
export async function verifyOtp(
  userId: string,
  shipmentId: string | null,
  purpose: 'DELIVERY_CONFIRMATION' | 'EMAIL_VERIFICATION' | 'PHONE_VERIFICATION',
  submittedCode: string,
): Promise<{ valid: boolean; reason?: 'EXPIRED' | 'EXHAUSTED' | 'MISMATCH' }> {
  const record = await prisma.otpCode.findFirst({
    where: { userId, shipmentId, purpose, consumedAt: null },
    orderBy: { createdAt: 'desc' },
  });

  if (!record) return { valid: false, reason: 'MISMATCH' };
  if (record.consumedAt !== null) return { valid: false, reason: 'MISMATCH' };

  if (record.attempts >= record.maxAttempts) {
    await prisma.otpCode.update({
      where: { id: record.id },
      data: { consumedAt: new Date() },
    });
    return { valid: false, reason: 'EXHAUSTED' };
  }

  if (record.expiresAt < new Date()) {
    return { valid: false, reason: 'EXPIRED' };
  }

  if (sha256(submittedCode) !== record.codeHash) {
    await prisma.otpCode.update({
      where: { id: record.id },
      data: { attempts: { increment: 1 } },
    });
    return { valid: false, reason: 'MISMATCH' };
  }

  await prisma.otpCode.update({
    where: { id: record.id },
    data: { consumedAt: new Date() },
  });

  return { valid: true };
}

// ── Blind index de telefono ────────────────────────────────────

export function phoneIndex(phone: string): string {
  return blindIndex(phone.replace(/[\s()-]/g, ''));
}

// ── Reexportaciones ────────────────────────────────────────────
// Los tokens firmados se usan desde varios modulos (rastreo publico,
// generacion de QR). Se reexportan para que exista una sola fuente.
export { signTrackingToken, verifyTrackingToken, type VerifiedTrackingToken } from './qrTokens.js';
export { sha256 } from '../../lib/crypto.js';

// ── Limpieza periodica ─────────────────────────────────────────

export async function purgeExpiredTokens(): Promise<{ refresh: number; tokens: number; otp: number }> {
  const now = new Date();
  const [refresh, tokens, otp] = await Promise.all([
    prisma.refreshToken.deleteMany({ where: { expiresAt: { lt: now } } }),
    prisma.verificationToken.deleteMany({ where: { expiresAt: { lt: now } } }),
    prisma.otpCode.deleteMany({ where: { expiresAt: { lt: now } } }),
  ]);
  return { refresh: refresh.count, tokens: tokens.count, otp: otp.count };
}