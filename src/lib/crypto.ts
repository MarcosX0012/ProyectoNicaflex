import crypto from 'node:crypto';
import { env } from '../config/env.js';

/**
 * Cifrado de datos personales en reposo (AES-256-GCM).
 *
 * Por que cifrar y no solo hashear: el receptor y el operador necesitan
 * LEER la direccion para entregar el paquete, asi que un hash no sirve.
 * Con AES-256-GCM el texto cifrado es recuperable solo por el proceso,
 * y si alguien obtiene un dump de la base no obtiene datos utilizables.
 *
 * Formato almacenado:  v1:<iv>:<tag>:<ciphertext>   (todo base64url)
 *
 * El prefijo de version permite rotar el algoritmo a futuro sin
 * invalidar los registros existentes.
 */

const ALGORITHM = 'aes-256-gcm';
const VERSION = 'v1';
const IV_LENGTH = 12;

let cachedKey: Buffer | null = null;

function getKey(): Buffer {
  if (cachedKey) return cachedKey;
  const key = Buffer.from(env.piiEncryptionKey, 'base64');
  if (key.length !== 32) {
    throw new Error(
      `PII_ENCRYPTION_KEY debe decodificar a exactamente 32 bytes (ahora: ${key.length}). ` +
        'Genera una con: openssl rand -base64 32',
    );
  }
  cachedKey = key;
  return key;
}

export function encryptPII(plaintext: string): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    VERSION,
    iv.toString('base64url'),
    tag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join(':');
}

export function decryptPII(payload: string): string {
  const parts = payload.split(':');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error('Formato de dato cifrado invalido');
  }
  const [, ivB64, tagB64, dataB64] = parts as [string, string, string, string];
  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    getKey(),
    Buffer.from(ivB64, 'base64url'),
  );
  decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

/**
 * Hash deterministico con sal fija, para poder BUSCAR por un campo
 * cifrado (ej. localizar a un usuario por telefono) sin descifrar
 * toda la tabla. Usa HMAC, no un hash simple, para resists ataques
 * de diccionario sobre numeros de telefono.
 */
export function blindIndex(value: string): string {
  return crypto
    .createHmac('sha256', getKey())
    .update(value.trim().toLowerCase())
    .digest('base64url');
}

/** Compara cadenas en tiempo constante (evita filtracion por temporizacion). */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/** SHA-256 simple. Para tokens de alta entropia (refresh tokens, QR). */
export function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('base64url');
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

/** HMAC-SHA256 para verificar firmas de webhooks entrantes. */
export function hmacSign(payload: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

export function hmacVerify(payload: string, signature: string, secret: string): boolean {
  return safeEqual(hmacSign(payload, secret), signature);
}

/** Codigo numerico de N digitos para OTP, generado con CSPRNG. */
export function numericCode(digits = 6): string {
  const max = 10 ** digits;
  const value = crypto.randomInt(0, max);
  return value.toString().padStart(digits, '0');
}