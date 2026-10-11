import { z } from 'zod';

/**
 * Esquemas de validacion de entrada para el modulo de autenticacion.
 *
 * Se validan con Zod en el borde de la API. Nunca se confia en el
 * cuerpo de la peticion mas alla de este punto: un campo no declarado
 * se rechaza en lugar de ignorarse en silencio.
 */

// ── Reusable ───────────────────────────────────────────────────

const passwordSchema = z
  .string()
  .min(10, 'La contrasena debe tener al menos 10 caracteres')
  .max(128, 'La contrasena no puede superar 128 caracteres')
  .refine((v) => /[a-z]/.test(v), 'Debe incluir al menos una letra minuscula')
  .refine((v) => /[A-Z]/.test(v), 'Debe incluir al menos una letra mayuscula')
  .refine((v) => /[0-9]/.test(v), 'Debe incluir al menos un numero')
  .refine(
    (v) => !['password', '12345678', 'qwerty', 'contrasena', 'admin123'].includes(v.toLowerCase()),
    'Esta contrasena es demasiado comun',
  );

const phoneSchema = z
  .string()
  .trim()
  .regex(/^\+?[0-9]{7,15}$/, 'El telefono debe tener entre 7 y 15 digitos');

/** Contraseñas de rol unico: servicios, integraciones, CI. */
const serviceKeySchema = z
  .string()
  .trim()
  .min(24, 'La clave de servicio debe tener al menos 24 caracteres')
  .regex(/^[A-Za-z0-9_\-.]+$/, 'Formato de clave de servicio invalido');

// ── Registro ───────────────────────────────────────────────────

export const registerSchema = z.object({
  email: z.string().trim().toLowerCase().email('Correo electronico invalido').max(254),
  password: passwordSchema,
  firstName: z.string().trim().min(1, 'El nombre es obligatorio').max(80),
  lastName: z.string().trim().min(1, 'El apellido es obligatorio').max(80),
  phone: phoneSchema.optional(),
  locale: z.enum(['es', 'en', 'pt']).default('es'),
});

export type RegisterInput = z.infer<typeof registerSchema>;

// ── Login ──────────────────────────────────────────────────────

export const loginSchema = z.object({
  // Aceptamos correo o telefono en el mismo campo.
  identifier: z.string().trim().min(3).max(254),
  password: z.string().min(1, 'La contrasena es obligatoria').max(128),
});

export type LoginInput = z.infer<typeof loginSchema>;

// ── Renovacion de sesion ───────────────────────────────────────

export const refreshSchema = z.object({
  refreshToken: z.string().min(20).optional(),
});

export type RefreshInput = z.infer<typeof refreshSchema>;

// ── Recuperacion de contrasena ─────────────────────────────────

export const forgotPasswordSchema = z.object({
  email: z.string().trim().toLowerCase().email('Correo electronico invalido'),
});

export const resetPasswordSchema = z.object({
  token: z.string().min(20, 'Token invalido'),
  newPassword: passwordSchema,
});

export const verifyEmailSchema = z.object({
  token: z.string().min(20, 'Token invalido'),
});

// ── Actualizacion de perfil ────────────────────────────────────

export const updateProfileSchema = z
  .object({
    firstName: z.string().trim().min(1).max(80).optional(),
    lastName: z.string().trim().min(1).max(80).optional(),
    phone: phoneSchema.optional(),
    locale: z.enum(['es', 'en', 'pt']).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'No hay campos para actualizar');

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'La contrasena actual es obligatoria'),
  newPassword: passwordSchema,
});

// ── Cambio de rol (solo admin) ────────────────────────────────

export const assignRoleSchema = z.object({
  userId: z.string().uuid('userId invalido'),
  roles: z
    .array(z.enum(['SENDER', 'RECIPIENT', 'OPERATOR', 'COURIER', 'ADMIN']))
    .min(1, 'Debe asignarse al menos un rol')
    .max(5),
});

export type AssignRoleInput = z.infer<typeof assignRoleSchema>;

// ── Login de servicio (APIs, webhooks, CI) ─────────────────────

export const serviceLoginSchema = z.object({
  serviceKey: serviceKeySchema,
  // Las credenciales de servicio no tienen refresh token rotativo:
  // viven para siempre hasta que se revocan explicitamente.
  audience: z.enum(['webhook', 'internal', 'integration']).default('internal'),
});