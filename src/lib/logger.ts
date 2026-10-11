import pino from 'pino';
import { env } from '../config/env.js';

export const logger = pino({
  level: env.LOG_LEVEL,
  redact: {
    // Nunca escribe secretos ni datos personales en los logs.
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.headers["x-api-key"]',
      'password',
      'passwordHash',
      'token',
      'accessToken',
      'refreshToken',
      '*.phone',
      '*.phoneCipher',
      '*.line1',
      '*.address',
    ],
    censor: '[REDACTADO]',
  },
  transport: env.isProduction
    ? undefined
    : {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'HH:MM:ss',
          ignore: 'pid,hostname',
        },
      },
});

export type Logger = typeof logger;