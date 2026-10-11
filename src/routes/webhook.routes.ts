import type { FastifyInstance, FastifyRequest } from 'fastify';
import { rawBodyPlugin } from '../plugins/rawBody.js';
import { SignatureVerificationError, WebhookProcessingError, ingestCourierWebhook, reprocessWebhook } from '../modules/webhooks/service.js';
import { getCourierAdapter } from '../modules/couriers/index.js';
import { prisma } from '../lib/prisma.js';
import { z } from 'zod';
import { requireRole } from './helpers.js';

/**
 * WEBHOOKS ENTRANTES
 *
 * Tres proveedores, un mismo contrato:
 *   /webhooks/courier/:provider   Transportistas (Shipping-do, Guia, ...)
 *   /webhooks/stripe              Pagos
 *   /webhooks/whatsapp            Confirmaciones de entrega de WhatsApp
 *
 * Sobre el cuerpo crudo: la verificacion de firma se hace sobre los
 * BYTES EXACTOS que envio el proveedor. Si Fastify parsea el JSON y
 * despues se re-serializa para firmarlo, cualquier diferencia de orden
 * de claves o espacios rompe la validacion. Por eso `rawBodyPlugin`
 * conserva el buffer original.
 *
 * Codigos de respuesta hacia el proveedor:
 *   200  procesado, o duplicado que ya estaba procesado. El proveedor deja de reintentar.
 *   400  payload ilegible. No tiene sentido reintentar.
 *   401  firma invalida. No tiene sentido reintentar.
 *   202  recibido pero con eventos que la maquina de estados rechazo.
 *        El proveedor NO debe reintentar (el webhook quedo registrado
 *        y un admin puede reprocesarlo); pero tampoco se confirma
 *        exito para que quede visible en su painel.
 */

export async function webhookRoutes(app: FastifyInstance): Promise<void> {
  // ── Transportistas ────────────────────────────────────────
  app.post(
    '/courier/:provider',
    {
      config: { rateLimit: false, rawBody: true },
      schema: {
        tags: ['webhooks'],
        summary: 'Ingesta eventos de un transportista',
      },
    },
    async (req, reply) => {
      const { provider } = req.params as { provider: string };

      try {
        const result = await ingestCourierWebhook(
          provider,
          req.rawBody as Buffer,
          req.headers as Record<string, string | undefined>,
          req,
        );

        return reply.status(200).send({ received: true, ...result });
      } catch (error) {
        if (error instanceof SignatureVerificationError) {
          return reply.status(401).send({
            received: false,
            error: 'Firma de webhook invalida',
            inboxId: error.inboxId,
          });
        }

        if (error instanceof WebhookProcessingError) {
          return reply.status(202).send({
            received: true,
            applied: false,
            inboxId: error.inboxId,
            rejectedEvents: error.errors,
            message: 'El webhook quedo registrado pero algunos eventos fueron rechazados',
          });
        }

        throw error;
      }
    },
  );

  // ── Stripe ────────────────────────────────────────────────
  app.post(
    '/stripe',
    {
      config: { rateLimit: false, rawBody: true },
      schema: { tags: ['webhooks'], summary: 'Eventos de pago de Stripe' },
    },
    async (req, reply) => {
      const { extractPaymentEvent, processPaymentWebhook, verifyStripeSignature } = await import(
        '../modules/payments/stripe.js'
      );

      const signature = req.headers['stripe-signature'];
      if (typeof signature !== 'string') {
        return reply.status(400).send({ error: 'Falta la firma de Stripe' });
      }

      let stripeEvent;
      try {
        stripeEvent = verifyStripeSignature(req.rawBody as Buffer, signature);
      } catch (error) {
        // 400 y no 401: Stripe considera que es un payload invalido y
        // deja de reintentar tras el primer fallo.
        app.log.warn({ err: error }, 'Webhook de Stripe con firma invalida');
        return reply.status(400).send({ error: 'Firma de Stripe invalida' });
      }

      const paymentEvent = extractPaymentEvent(stripeEvent);
      if (!paymentEvent) {
        return reply.status(200).send({ received: true, handled: false, reason: 'evento no relevante' });
      }

      const result = await processPaymentWebhook(paymentEvent, req);
      return reply.status(200).send({ received: true, ...result });
    },
  );

  // ── WhatsApp ──────────────────────────────────────────────
  app.get(
    '/whatsapp',
    {
      schema: {
        tags: ['webhooks'],
        summary: 'Verificacion del webhook de WhatsApp (GET de Meta)',
      },
    },
    async (req, reply) => {
      const { handleWhatsAppVerification } = await import('../modules/notifications/whatsapp.js');
      const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } =
        req.query as Record<string, string | undefined>;

      const result = handleWhatsAppVerification(mode, token, challenge);

      if (!result.valid || !result.challenge) {
        return reply.status(403).send({ error: 'Verificacion fallida' });
      }
      return reply.type('text/plain').send(result.challenge);
    },
  );

  app.post(
    '/whatsapp',
    {
      config: { rateLimit: false },
      schema: {
        tags: ['webhooks'],
        summary: 'Confirmaciones de entrega de WhatsApp',
      },
    },
    async (req, reply) => {
      const { parseDeliveryStatus } = await import('../modules/notifications/whatsapp.js');

      const body = req.body as {
        entry?: Array<{
          changes?: Array<{
            value?: {
              statuses?: Array<{ id: string; status: string; timestamp?: string }>;
            };
          }>;
        }>;
      };

      const updates: Array<{ notificationId: string; status: string }> = [];

      for (const entry of body.entry ?? []) {
        for (const change of entry.changes ?? []) {
          for (const status of change.value?.statuses ?? []) {
            // Meta manda el id del MENSAJE saliente, que aqui es el
            // `providerMessageId` de la notificacion.
            const notification = await prisma.notification.findFirst({
              where: { providerMessageId: status.id },
              select: { id: true },
            });

            if (!notification) continue;

            const parsed = parseDeliveryStatus(status.status);
            if (!parsed) continue;

            updates.push({ notificationId: notification.id, status: parsed });
          }
        }
      }

      for (const update of updates) {
        await prisma.notification.update({
          where: { id: update.notificationId },
          data: {
            status: update.status === 'failed' ? 'FAILED' : update.status === 'sent' ? 'SENT' : 'DELIVERED',
            deliveredAt: update.status === 'delivered' || update.status === 'read' ? new Date() : null,
            ...(update.status === 'failed' ? { error: 'WhatsApp reporto fallo de entrega' } : {}),
          },
        });
      }

      return reply.status(200).send({ received: true, updated: updates.length });
    },
  );

  // ── Panel de webhooks (operativo) ─────────────────────────
  app.get(
    '/courier/inbox',
    {
      preHandler: [app.authenticate, requireRole(app, 'OPERATOR', 'ADMIN')],
      schema: {
        tags: ['webhooks'],
        summary: 'Lista los webhooks recibidos (operativo)',
      },
    },
    async (req) => {
      const query = z
        .object({
          provider: z.string().optional(),
          status: z.enum(['RECEIVED', 'PROCESSED', 'REJECTED', 'DUPLICATE', 'FAILED', 'IGNORED']).optional(),
          page: z.coerce.number().int().min(1).default(1),
          pageSize: z.coerce.number().int().min(1).max(100).default(25),
        })
        .parse(req.query);

      const where = {
        ...(query.provider ? { provider: query.provider } : {}),
        ...(query.status ? { status: query.status } : {}),
      };

      const [total, items] = await Promise.all([
        prisma.webhookInbox.count({ where }),
        prisma.webhookInbox.findMany({
          where,
          select: {
            id: true,
            provider: true,
            externalId: true,
            eventType: true,
            status: true,
            signatureValid: true,
            error: true,
            attempts: true,
            receivedAt: true,
            processedAt: true,
          },
          orderBy: { receivedAt: 'desc' },
          skip: (query.page - 1) * query.pageSize,
          take: query.pageSize,
        }),
      ]);

      return {
        data: items,
        pagination: { page: query.page, pageSize: query.pageSize, total },
      };
    },
  );

  app.post(
    '/courier/inbox/:id/reprocess',
    {
      preHandler: [app.authenticate, requireRole(app, 'ADMIN')],
      schema: {
        tags: ['webhooks'],
        summary: 'Reprocesa un webhook fallido (admin)',
        description:
          'Util cuando un evento fue rechazado por una transicion no ' +
          'permitida y un admin corrige el estado del envio a mano.',
      },
    },
    async (req) => {
      const { id } = req.params as { id: string };
      const user = req.currentUser;
      const result = await reprocessWebhook(id, user?.sub ?? 'sistema');
      return { data: result };
    },
  );

  // ── Estado de la integracion ──────────────────────────────
  app.get(
    '/courier/providers',
    {
      preHandler: [app.authenticate, requireRole(app, 'OPERATOR', 'ADMIN')],
      schema: {
        tags: ['webhooks'],
        summary: 'Transportistas disponibles y activo',
      },
    },
    async () => {
      const { availableProviders } = await import('../modules/couriers/index.js');
      const adapter = getCourierAdapter();
      return {
        data: {
          active: { code: adapter.code, displayName: adapter.displayName },
          providers: availableProviders(),
        },
      };
    },
  );
}