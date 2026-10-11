import fp from 'fastify-plugin';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { UserRole } from '@prisma/client';
import { verifyAccessToken, type AccessTokenClaims } from '../modules/auth/tokens.js';
import { unauthorized, forbidden } from '../lib/errors.js';

/**
 * Autenticacion por JWT.
 *
 * Se separa `currentUser` de `authenticate` a proposito:
 *  - `authenticate`  -> exige sesion. Corta la peticion si no hay token valido.
 *  - `currentUser`   -> decodifica si hay token, pero NO corta. Permite
 *                       endpoints que responden distinto a usuario logueado
 *                       (por ejemplo el rastreo público, que muestra mas
 *                       detalle si quien consulta es el receptor).
 */

declare module 'fastify' {
  interface FastifyRequest {
    currentUser?: AccessTokenClaims;
  }
  interface FastifyInstance {
    /** Exige un token valido. Usar como preHandler. */
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /** Exige al menos uno de los roles indicados. Usar como preHandler. */
    requireRole: (...roles: UserRole[]) => (req: FastifyRequest) => Promise<void>;
  }
}

export const authPlugin = fp(async (app) => {
  // Decodifica en toda peticion sin exigir nada.
  app.decorateRequest('currentUser', undefined);

  app.addHook('onRequest', async (req) => {
    const header = req.headers.authorization;
    if (!header) return;

    const [scheme, token] = header.split(' ');
    if (!/^Bearer$/i.test(scheme ?? '') || !token) return;

    try {
      req.currentUser = verifyAccessToken(token);
    } catch {
      // Un token invalido no corta la peticion aqui: depende de la ruta.
      // Un endpoint publico con token roto debe seguir funcionando.
      req.currentUser = undefined;
    }
  });

  app.decorate('authenticate', async (req: FastifyRequest) => {
    if (!req.currentUser) throw unauthorized('Se requiere autenticacion');
  });

  app.decorate('requireRole', (...roles: UserRole[]) => {
    return async (req: FastifyRequest) => {
      if (!req.currentUser) throw unauthorized('Se requiere autenticacion');
      const hasAny = req.currentUser.roles.some((role) => roles.includes(role));
      if (!hasAny) {
        throw forbidden(`Se requiere uno de estos roles: ${roles.join(', ')}`);
      }
    };
  });
});

/** Indica si el usuario actual cumple el requisito de rol. */
export function hasRole(req: FastifyRequest, ...roles: UserRole[]): boolean {
  return req.currentUser?.roles.some((role) => roles.includes(role)) ?? false;
}