import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { notFound, forbidden, validationError } from '../lib/errors.js';
import { createPaymentSession, paymentsEnabled, recordCashOnDelivery } from '../modules/payments/stripe.js';
import type { AccessTokenClaims } from '../modules/auth/tokens.js';
import { env as appEnv } from '../config/env.js';

/**
 * RUTAS DE PAGOS
 *
 * El flujo de pago online:
 *   1. El emisor crea el envio con paymentMethod=ONLINE.
 *      Queda en AWAITING_PAYMENT.
 *   2. El frontend pide la sesion de pago (POST /shipments/:code/pay).
 *   3. El usuario paga en la pagina de Stripe.
 *   4. Stripe notifica por webhook y el envio pasa a AWAITING_PICKUP.
 *
 * El paso 4 es el unico que marca el envio como pagado. El paso 3
 * devuelve al navegador, pero no se usa para confirmar nada: el
 * usuario puede cerrar la pestana antes de que Stripe confirme.
 */

export async function paymentRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/shipments/:code/pay',
    {
      preHandler: [app.authenticate, app.requireRole('SENDER', 'ADMIN')],
      schema: {
        tags: ['payments'],
        summary: 'Crea la sesion de pago de un envio',
      },
    },
    async (req) => {
      const { code } = req.params as { code: string };
      const user = req.currentUser as AccessTokenClaims;

      if (!paymentsEnabled()) {
        throw validationError('Los pagos en linea no estan habilitados en este entorno');
      }

      const shipment = await prisma.shipment.findUnique({
        where: { trackingCode: code.toUpperCase() },
        select: {
          id: true,
          trackingCode: true,
          senderId: true,
          amountCents: true,
          currency: true,
          paymentStatus: true,
          paymentMethod: true,
          itemCount: true,
        },
      });

      if (!shipment) throw notFound('Envio');
      if (shipment.senderId !== user.sub && !user.roles.includes('ADMIN')) {
        throw forbidden('Solo el emisor puede iniciar el pago');
      }
      if (shipment.paymentMethod !== 'ONLINE') {
        throw validationError('Este envio no usa pago online');
      }
      if (shipment.amountCents <= 0) {
        throw validationError('El envio no tiene importe definido');
      }

      const session = await createPaymentSession(
        {
          trackingCode: shipment.trackingCode,
          amountCents: shipment.amountCents,
          currency: shipment.currency,
          customerEmail: user.email,
          description: `Envio ${shipment.trackingCode} · ${shipment.itemCount} articulo(s)`,
        },
        req,
      );

      return { data: session };
    },
  );

  // ── Estado del pago ───────────────────────────────────────
  app.get(
    '/shipments/:code/payment',
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ['payments'],
        summary: 'Estado del pago de un envio',
      },
    },
    async (req) => {
      const { code } = req.params as { code: string };
      const user = req.currentUser as AccessTokenClaims;

      const shipment = await prisma.shipment.findUnique({
        where: { trackingCode: code.toUpperCase() },
        select: {
          trackingCode: true,
          senderId: true,
          recipientId: true,
          paymentMethod: true,
          paymentStatus: true,
          amountCents: true,
          currency: true,
          paidAt: true,
          stripePaymentIntentId: true,
        },
      });

      if (!shipment) throw notFound('Envio');

      const isParty =
        shipment.senderId === user.sub || shipment.recipientId === user.sub;
      if (!isParty && !user.roles.includes('ADMIN') && !user.roles.includes('OPERATOR')) {
        throw forbidden('No tienes acceso a los datos de pago de este envio');
      }

      return {
        data: {
          trackingCode: shipment.trackingCode,
          paymentMethod: shipment.paymentMethod,
          paymentStatus: shipment.paymentStatus,
          amountCents: shipment.amountCents,
          amountFormatted: `${shipment.currency} ${(shipment.amountCents / 100).toFixed(2)}`,
          paidAt: shipment.paidAt,
          // El PaymentIntent se expone al emisor para que el frontend
          // monte el componente de pago de Stripe con el id correcto.
          paymentIntentId: shipment.stripePaymentIntentId,
        },
      };
    },
  );

  // ── Cobro contra entrega ───────────────────────────────────
  app.post(
    '/shipments/:code/cod-collected',
    {
      preHandler: [app.authenticate, app.requireRole('COURIER', 'OPERATOR', 'ADMIN')],
      schema: {
        tags: ['payments'],
        summary: 'Registra si el repartidor cobro contra entrega',
      },
    },
    async (req) => {
      const { code } = req.params as { code: string };
      const user = req.currentUser as AccessTokenClaims;
      const { collected } = z
        .object({ collected: z.boolean() })
        .parse(req.body ?? { collected: true });

      await recordCashOnDelivery(code.toUpperCase(), user.sub, collected, req);

      return {
        data: {
          trackingCode: code.toUpperCase(),
          paymentStatus: collected ? 'PAID' : 'PENDING',
        },
      };
    },
  );

  // ── Estado del subsistema ──────────────────────────────────
  app.get(
    '/status',
    {
      schema: {
        tags: ['payments'],
        summary: 'Estado del subsistema de pagos',
      },
    },
    async () => {
      return {
        data: {
          enabled: paymentsEnabled(),
          provider: 'stripe',
          modes: ['ONLINE', 'ON_DELIVERY'],
          // Nunca se expone si hay clave; solo si el servicio esta activo.
          webhookConfigured: Boolean(appEnv.STRIPE_WEBHOOK_SECRET),
        },
      };
    },
  );
}