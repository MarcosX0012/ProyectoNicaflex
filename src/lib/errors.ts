/**
 * Jerarquia de errores de la aplicacion.
 *
 * Cada error de dominio lleva un codigo estable que el cliente puede
 * usar para reaccionar, y un mensaje que es seguro exponer. Los detalles
 * internos se registran en el log, nunca en la respuesta HTTP.
 */

export type ErrorCode =
  | 'BAD_REQUEST'
  | 'VALIDATION_ERROR'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'IDEMPOTENCY_REPLAY'
  | 'INVALID_STATE_TRANSITION'
  | 'PAYMENT_REQUIRED'
  | 'RATE_LIMITED'
  | 'OTP_INVALID'
  | 'OTP_EXPIRED'
  | 'COURIER_ERROR'
  | 'INTERNAL_ERROR';

export class AppError extends Error {
  readonly statusCode: number;
  readonly code: ErrorCode;
  readonly details?: unknown;
  readonly expose: boolean;

  constructor(
    code: ErrorCode,
    message: string,
    statusCode: number,
    options: { details?: unknown; expose?: boolean; cause?: unknown } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = options.details;
    this.expose = options.expose ?? true;
    Error.captureStackTrace?.(this, AppError);
  }

  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details !== undefined ? { details: this.details } : {}),
      },
    };
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new AppError('BAD_REQUEST', message, 400, { details });

export const validationError = (message: string, details?: unknown) =>
  new AppError('VALIDATION_ERROR', message, 422, { details });

/** 402: la peticion es valida pero falta el pago para continuar. */
export const paymentRequired = (message: string, details?: unknown) =>
  new AppError('PAYMENT_REQUIRED', message, 402, { details });

export const unauthorized = (message = 'No autenticado') =>
  new AppError('UNAUTHORIZED', message, 401);

export const forbidden = (message = 'No tienes permiso para esta accion') =>
  new AppError('FORBIDDEN', message, 403);

export const notFound = (entity = 'Recurso') =>
  new AppError('NOT_FOUND', `${entity} no encontrado`, 404);

export const conflict = (message: string, details?: unknown) =>
  new AppError('CONFLICT', message, 409, { details });

export const invalidTransition = (from: string, to: string, allowed: string[]) =>
  new AppError(
    'INVALID_STATE_TRANSITION',
    `No se puede pasar de ${from} a ${to}`,
    409,
    { details: { from, to, allowed } },
  );

export const otpInvalid = () =>
  new AppError('OTP_INVALID', 'El codigo de verificacion no coincide', 400);

export const otpExpired = () =>
  new AppError('OTP_EXPIRED', 'El codigo de verificacion expiro, solicita uno nuevo', 410);

export const courierError = (message: string, cause?: unknown) =>
  new AppError('COURIER_ERROR', message, 502, { cause, expose: true });

export const internalError = (message = 'Error interno', cause?: unknown) =>
  new AppError('INTERNAL_ERROR', message, 500, { cause, expose: false });