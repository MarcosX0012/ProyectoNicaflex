import { config as loadEnv } from 'dotenv';
import { z } from 'zod';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(dirname, '..', '..');

loadEnv({ path: path.join(projectRoot, '.env') });

/**
 * Secretos con valores por defecto de desarrollo. En produccion son
 * obligatorios: el arranque falla si no se definen (ver .superRefine).
 */
const devFallbacks = {
  JWT_SECRET: 'dev-only-jwt-secret-no-usar-en-produccion-000',
  PII_ENCRYPTION_KEY: 'ZGV2LW9ubHktcGlpLWtleS0zMi1ieXRlcy1sb25nISE=',
  TRACKING_SIGNING_SECRET: 'dev-only-tracking-secret-no-usar-en-produccion-000',
};

const booleanish = z
  .string()
  .transform((v) => ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase()));

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(3000),
    HOST: z.string().default('0.0.0.0'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    CORS_ORIGINS: z.string().default('http://localhost:5173'),

    DATABASE_URL: z.string().min(1, 'DATABASE_URL es obligatorio'),
    TEST_DATABASE_URL: z.string().optional(),

    JWT_SECRET: z.string().min(32, 'JWT_SECRET debe tener al menos 32 caracteres'),
    JWT_ACCESS_TTL: z.string().default('15m'),
    JWT_REFRESH_TTL_DAYS: z.coerce.number().int().positive().default(30),

    PII_ENCRYPTION_KEY: z.string().min(20, 'PII_ENCRYPTION_KEY invalida'),
    TRACKING_SIGNING_SECRET: z.string().min(32),

    PUBLIC_WEB_URL: z.string().default('http://localhost:5173'),

    COURIER_PROVIDER: z.enum(['mock', 'shippingdo', 'guia', 'starken', 'manual']).default('mock'),
    SHIPPINGDO_API_TOKEN: z.string().default(''),
    SHIPPINGDO_BASE_URL: z.string().default('https://api.shippingdo.com'),
    SHIPPINGDO_WEBHOOK_SECRET: z.string().default(''),

    PAYMENTS_ENABLED: booleanish.default('false'),
    STRIPE_SECRET_KEY: z.string().default(''),
    STRIPE_WEBHOOK_SECRET: z.string().default(''),

    WHATSAPP_ENABLED: booleanish.default('false'),
    WHATSAPP_PHONE_NUMBER_ID: z.string().default(''),
    WHATSAPP_ACCESS_TOKEN: z.string().default(''),
    WHATSAPP_VERIFY_TOKEN: z.string().default(''),

    /**
     * Credenciales de servicio, separadas por coma.
     * Formato: "<audience>:<secreto>" o solo "<secreto>".
     * Ejemplo: "webhook:mi-secreto-webhook,internal:mi-secreto-jobs"
     */
    SERVICE_API_KEYS: z.string().default(''),
  })
  .superRefine((cfg, ctx) => {
    if (cfg.NODE_ENV !== 'production') return;
    const missing: string[] = [];
    if (cfg.JWT_SECRET === devFallbacks.JWT_SECRET) missing.push('JWT_SECRET');
    if (cfg.PII_ENCRYPTION_KEY === devFallbacks.PII_ENCRYPTION_KEY) missing.push('PII_ENCRYPTION_KEY');
    if (cfg.TRACKING_SIGNING_SECRET === devFallbacks.TRACKING_SIGNING_SECRET)
      missing.push('TRACKING_SIGNING_SECRET');
    for (const key of missing) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [key as keyof typeof cfg],
        message: `${key} debe definirse con un valor aleatorio en produccion`,
      });
    }
  });

function readOrFallback(key: keyof typeof devFallbacks, provided: string | undefined): string {
  if (provided && provided.length > 0) return provided;
  if (process.env.NODE_ENV === 'production') {
    // El .superRefine de arriba ya reporto el faltante. Aqui evitamos
    // que un valor por defecto llegue a ejecutarse.
    throw new Error(`${key} es obligatorio en produccion`);
  }
  return devFallbacks[key];
}

const raw = schema.safeParse(process.env);

if (!raw.success) {
  const issues = raw.error.issues
    .map((i) => `  - ${i.path.join('.') || '(raiz)'}: ${i.message}`)
    .join('\n');
  throw new Error(`Configuracion de entorno invalida:\n${issues}`);
}

const parsed = raw.data;

export const env = {
  ...parsed,
  isProduction: parsed.NODE_ENV === 'production',
  isTest: parsed.NODE_ENV === 'test',
  isDevelopment: parsed.NODE_ENV === 'development',
  corsOrigins: parsed.CORS_ORIGINS.split(',')
    .map((o) => o.trim())
    .filter(Boolean),
  jwtAccessTtl: parsed.JWT_ACCESS_TTL,
  jwtAccessTtlSeconds: parseDurationToSeconds(parsed.JWT_ACCESS_TTL),
  jwtRefreshTtlMs: parsed.JWT_REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000,
  piiEncryptionKey: readOrFallback('PII_ENCRYPTION_KEY', parsed.PII_ENCRYPTION_KEY),
  trackingSigningSecret: readOrFallback('TRACKING_SIGNING_SECRET', parsed.TRACKING_SIGNING_SECRET),
  jwtSecret: readOrFallback('JWT_SECRET', parsed.JWT_SECRET),
} as const;

function parseDurationToSeconds(value: string): number {
  const match = /^(\d+)([smhd])$/.exec(value.trim());
  if (!match) return 900;
  const amount = Number(match[1]);
  const unit = match[2] as 's' | 'm' | 'h' | 'd';
  const multiplier = { s: 1, m: 60, h: 3600, d: 86400 }[unit];
  return amount * multiplier;
}

export type Env = typeof env;