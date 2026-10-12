import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyRequest } from 'fastify';

/**
 * Conserva el cuerpo crudo de la peticion.
 *
 * Existe por una razon muy concreta: la verificacion de firma de
 * Stripe y de los transportistas se calcula sobre los BYTES EXACTOS
 * que envio el proveedor.
 *
 * Si Fastify parsea el JSON y despues hay que re-serializarlo para
 * calcular el HMAC, el resultado puede diferir del original por el
 * orden de las claves, espacios o caracteres escapados, y la
 * verificacion falla siempre aunque la firma sea correcta.
 *
 * Por eso las rutas de webhook piden `config: { rawBody: true }` y
 * reciben `req.rawBody` como Buffer, sin parsear.
 */

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: Buffer;
  }
}

export const rawBodyPlugin = fp(
  async (app: FastifyInstance, options: { global?: boolean } = {}) => {
    const global = options.global ?? false;

    app.addHook(
      'preParsing',
      async (req: FastifyRequest, _reply, payload: unknown) => {
        const wantsRawBody =
          global || (req.routeOptions?.config as { rawBody?: boolean } | undefined)?.rawBody === true;

        if (!wantsRawBody) return payload;

        const chunks: Buffer[] = [];

        for await (const chunk of payload as AsyncIterable<Buffer>) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
        }

        const raw = Buffer.concat(chunks);
        req.rawBody = raw;

        // Se devuelve un stream nuevo con el mismo contenido para que el
        // parser de JSON siga funcionando con normalidad.
        const { Readable } = await import('node:stream');
        return Readable.from(raw);
      },
    );
  },
  { name: 'raw-body' },
);