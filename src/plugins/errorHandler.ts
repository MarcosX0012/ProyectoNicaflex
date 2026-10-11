import fp from 'fastify-plugin';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { Prisma } from '@prisma/client';
import { AppError, type ErrorCode } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

/**
 * Manejador de errores unificado.
 *
 * Regla que sostiene todo este archivo: la respuesta HTTP nunca
 * contiene un detalle interno. El cliente recibe codigo + mensaje
 * accionable; la causa real vive en el log con su stack.
 */

interface NormalizedError {
  statusCode: number;
  code: ErrorCode;
  message: string;
  details?: unknown;
}

export const errorHandlerPlugin = fp(async (app) => {
  app.setErrorHandler(
    (error: unknown, req: FastifyRequest, reply: FastifyReply): void => {
      const normalized = normalizeError(error);

      const logPayload = {
        err: error,
        code: normalized.code,
        statusCode: normalized.statusCode,
        method: req.method,
        url: req.url,
        userId: req.currentUser?.sub,
      };

      if (normalized.statusCode >= 500) {
        logger.error(logPayload, 'Error no controlado');
      } else if (normalized.statusCode === 401 || normalized.statusCode === 403) {
        logger.warn(logPayload, 'Acceso denegado');
      } else {
        logger.debug(logPayload, 'Error de cliente');
      }

      // Respuesta uniforme en toda la API.
      void reply.status(normalized.statusCode).send({
        error: {
          code: normalized.code,
          message: normalized.message,
          ...(normalized.details !== undefined ? { details: normalized.details } : {}),
        },
      });
    },
  );

  // 404 explicito con el mismo formato de error que el resto.
  app.setNotFoundHandler((req, reply) => {
    void reply.status(404).send({
      error: {
        code: 'NOT_FOUND',
        message: `Ruta no encontrada: ${req.method} ${req.url}`,
      },
    });
  });
});

function normalizeError(error: unknown): NormalizedError {
  if (error instanceof AppError) {
    return {
      statusCode: error.statusCode,
      code: error.code,
      message: error.message,
      details: error.details,
    };
  }

  if (error instanceof ZodError) {
    return {
      statusCode: 422,
      code: 'VALIDATION_ERROR',
      message: 'Los datos enviados no son validos',
      details: error.issues.map((issue) => ({
        field: issue.path.join('.') || '(raiz)',
        message: issue.message,
      })),
    };
  }

  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    return normalizePrismaError(error);
  }

  if (error instanceof Prisma.PrismaClientValidationError) {
    return {
      statusCode: 400,
      code: 'BAD_REQUEST',
      message: 'La consulta a la base de datos es invalida',
    };
  }

  // Errores de Fastify con status (rate limit, payload muy grande, etc).
  const fastifyError = error as { statusCode?: number; code?: string; message?: string };
  if (typeof fastifyError?.statusCode === 'number' && fastifyError.statusCode < 500) {
    return {
      statusCode: fastifyError.statusCode,
      code: mapFastifyCode(fastifyError.code),
      message: fastifyError.message ?? 'Peticion invalida',
    };
  }

  return {
    statusCode: 500,
    code: 'INTERNAL_ERROR',
    message: 'Ocurrio un error interno. Intenta de nuevo mas tarde.',
  };
}

function normalizePrismaError(error: Prisma.PrismaClientKnownRequestError): NormalizedError {
  switch (error.code) {
    case 'P2002': {
      // Violacion de restriccion unica. El nombre del campo viaja en
      // meta.target; se expone porque es util y no es sensible.
      const target = (error.meta?.target as string[] | undefined) ?? [];
      const field = target.join(', ');
      return {
        statusCode: 409,
        code: 'CONFLICT',
        message: field
          ? `Ya existe un registro con el mismo valor en: ${field}`
          : 'Ya existe un registro duplicado',
      };
    }
    case 'P2003':
      return {
        statusCode: 400,
        code: 'BAD_REQUEST',
        message: 'Referencia invalida a un registro que no existe',
      };
    case 'P2025':
      return { statusCode: 404, code: 'NOT_FOUND', message: 'El registro solicitado no existe' };
    case 'P2034':
      return {
        statusCode: 409,
        code: 'CONFLICT',
        message: 'Conflicto de concurrencia. Reintenta la operacion.',
      };
    default:
      return {
        statusCode: 500,
        code: 'INTERNAL_ERROR',
        message: 'Error de base de datos',
      };
  }
}

function mapFastifyCode(code?: string): ErrorCode {
  switch (code) {
    case 'FST_ERR_RATE_LIMIT':
      return 'RATE_LIMITED';
    case 'FST_ERR_CTP_EMPTY_JSON_BODY':
    case 'FST_ERR_CTP_INVALID_MEDIA_TYPE':
    case 'FST_ERR_VALIDATION':
      return 'BAD_REQUEST';
    case 'FST_ERR_CTP_BODY_TOO_LARGE':
      return 'BAD_REQUEST';
    default:
      return 'BAD_REQUEST';
  }
}