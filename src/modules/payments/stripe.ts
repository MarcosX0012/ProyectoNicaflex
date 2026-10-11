import Stripe from 'stripe';
import { env } from '../../config/env.js';
import { prisma } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';
import { paymentRequired, validationError } from '../../lib/errors.js';
import { applyStateChange } from '../shipments/service.js';
import { recordAudit } from '../../lib/audit.js';
import type { FastifyRequest } from 'fastify';

/**
 * PAGOS
 * =====
 *
 * El sistema maneja dos modalidades, elegidas por el emisor al crear
 * el envio:
 *
 *   ONLINE        Stripe devuelve una URL de pago; el envio espera en
 *                 AWAITING_PAYMENT hasta que el webhook confirme el
 *                 pago. El webhook de Stripe es la UNICA fuente de
 *                 verdad: el return del navegador no se usa para dar
 *                 por pagado, porque el usuario puede cerrar la
 *                 pestana sin pagar.
 *
 *   ON_DELIVERY   No hay prepago. El estado de pago se resuelve en la
 *                 entrega; se registra como collected por el repartidor.
 *
 * Idempotencia: el `payment_intent.id` tiene UNIQUE en la base. Un
 * webhook repetido no actualiza dos veces ni genera dos hitos.
 */

let stripeClient: Stripe | null = null;

export function getStripe(): Stripe {
  if (stripeClient) return stripeClient;

  if (!env.STRIPE_SECRET_KEY) {
    throw new Error('STRIPE_SECRET_KEY es obligatorio para procesar pagos');
  }

  // La version de la API la fija la version de la libreria instalada.
  // Fijarla aqui tambien evita que una actualizacion de `stripe`
  // cambie el comportamiento sin que se note en el codigo.
  stripeClient = new Stripe(env.STRIPE_SECRET_KEY, {
    apiVersion: '2025-02-24.acacia',
    typescript: true,
    maxNetworkRetries: 2,
    timeout: 20000,
  });

  return stripeClient;
}

export function paymentsEnabled(): boolean {
  return env.PAYMENTS_ENABLED && Boolean(env.STRIPE_SECRET_KEY);
}

export interface CreatePaymentSessionInput {
  trackingCode: string;
  amountCents: number;
  currency: string;
  customerEmail: string;
  description: string;
}

/**
 * Crea la sesion de pago y devuelve la URL. No marca el envio como
 * pagado: eso ocurre unicamente cuando llega el webhook.
 */
export async function createPaymentSession(
  input: CreatePaymentSessionInput,
  req?: FastifyRequest,
): Promise<{ paymentUrl: string; paymentIntentId: string; sessionId: string }> {
  if (!paymentsEnabled()) {
    throw paymentRequired('Los pagos en linea no estan habilitados en este entorno');
  }

  const stripe = getStripe();

  const shipment = await prisma.shipment.findUnique({
    where: { trackingCode: input.trackingCode },
    select: { id: true, status: true, paymentStatus: true },
  });

  if (!shipment) throw validationError('El envio no existe');
  if (shipment.paymentStatus === 'PAID') {
    throw validationError('Este envio ya fue pagado');
  }

  // Si ya hay un PaymentIntent asociado, se reutiliza en vez de crear
  // otro: evita cobros dobles si el usuario recarga la pagina de pago.
  const existing = await prisma.shipment.findUnique({
    where: { trackingCode: input.trackingCode },
    select: { stripePaymentIntentId: true },
  });

  if (existing?.stripePaymentIntentId) {
    const intent = await stripe.paymentIntents.retrieve(existing.stripePaymentIntentId);
    return {
      paymentUrl: `${env.PUBLIC_WEB_URL}/pagar/${existing.stripePaymentIntentId}`,
      paymentIntentId: intent.id,
      sessionId: intent.id,
    };
  }

  const intent = await stripe.paymentIntents.create({
    amount: input.amountCents,
    currency: input.currency.toLowerCase(),
    description: input.description,
    receipt_email: input.customerEmail,
    automatic_payment_methods: { enabled: true },
    metadata: {
      trackingCode: input.trackingCode,
      shipmentId: shipment.id,
    },
  });

  await prisma.shipment.update({
    where: { id: shipment.id },
    data: { stripePaymentIntentId: intent.id },
  });

  await recordAudit(
    {
      action: 'PAYMENT_SESSION_CREATED',
      entity: 'Shipment',
      entityId: shipment.id,
      shipmentCode: input.trackingCode,
      metadata: { paymentIntentId: intent.id, amountCents: input.amountCents },
    },
    req,
  );

  logger.info(
    { trackingCode: input.trackingCode, paymentIntentId: intent.id },
    'Pago: sesion creada',
  );

  return {
    paymentUrl: `${env.PUBLIC_WEB_URL}/pagar/${intent.id}`,
    paymentIntentId: intent.id,
    sessionId: intent.id,
  };
}

export interface WebhookPaymentEvent {
  type: string;
  paymentIntentId: string;
  amountCents?: number;
  currency?: string;
  failureMessage?: string;
}

/**
 * Procesa un evento de Stripe ya verificado.
 *
 * El unico evento que marca un envio como pagado es
 * `payment_intent.succeeded`. Los demas actualizan el estado de pago
 * sin tocar la maquina de estados del envio, porque un cobro fallido
 * no es un hito logistico (deja el envio esperando pago, que ya es su
 * estado).
 */
export async function processPaymentWebhook(
  event: WebhookPaymentEvent,
  req?: FastifyRequest,
): Promise<{ handled: boolean; reason?: string }> {
  const shipment = await prisma.shipment.findFirst({
    where: { stripePaymentIntentId: event.paymentIntentId },
    select: {
      id: true,
      trackingCode: true,
      status: true,
      paymentStatus: true,
      paymentMethod: true,
    },
  });

  if (!shipment) {
    logger.warn(
      { paymentIntentId: event.paymentIntentId },
      'Pago: evento sin envio asociado',
    );
    return { handled: false, reason: 'sin envio asociado' };
  }

  switch (event.type) {
    case 'payment_intent.succeeded': {
      if (shipment.paymentStatus === 'PAID') {
        // Webhook duplicado: no se crea un segundo hito.
        logger.info(
          { trackingCode: shipment.trackingCode },
          'Pago: webhook duplicado, ya estaba pagado',
        );
        return { handled: true, reason: 'ya pagado' };
      }

      await prisma.shipment.update({
        where: { id: shipment.id },
        data: { paymentStatus: 'PAID', paidAt: new Date() },
      });

      // El hito logistico solo si el envio esperaba pago. Un envio con
      // pago contra entrega que recibio un pago online no genera
      // transicion: no es un cambio de etapa.
      if (shipment.status === 'AWAITING_PAYMENT') {
        await applyStateChange(shipment.id, {
          to: 'AWAITING_PICKUP',
          title: 'Pago confirmado',
          description: 'Se confirmo el pago y el envio esta listo para ser recogido.',
          source: 'SYSTEM',
          idempotencyKey: `payment:${event.paymentIntentId}`,
          metadata: { paymentIntentId: event.paymentIntentId },
        });
      }

      await recordAudit(
        {
          action: 'PAYMENT_SUCCEEDED',
          entity: 'Shipment',
          entityId: shipment.id,
          shipmentCode: shipment.trackingCode,
          metadata: { paymentIntentId: event.paymentIntentId, amountCents: event.amountCents },
        },
        req,
      );

      logger.info({ trackingCode: shipment.trackingCode }, 'Pago: confirmado');
      return { handled: true };
    }

    case 'payment_intent.payment_failed': {
      await prisma.shipment.update({
        where: { id: shipment.id },
        data: { paymentStatus: 'FAILED' },
      });

      await recordAudit(
        {
          action: 'PAYMENT_FAILED',
          entity: 'Shipment',
          entityId: shipment.id,
          shipmentCode: shipment.trackingCode,
          outcome: 'FAILED',
          metadata: { paymentIntentId: event.paymentIntentId, message: event.failureMessage },
        },
        req,
      );

      return { handled: true };
    }

    case 'charge.refunded': {
      await prisma.shipment.update({
        where: { id: shipment.id },
        data: { paymentStatus: 'REFUNDED' },
      });

      await recordAudit(
        {
          action: 'PAYMENT_REFUNDED',
          entity: 'Shipment',
          entityId: shipment.id,
          shipmentCode: shipment.trackingCode,
          metadata: { paymentIntentId: event.paymentIntentId },
        },
        req,
      );

      return { handled: true };
    }

    default:
      // Eventos irrelevantes para este sistema (invoice.created, etc.).
      // Se responde 2xx para que Stripe deje de reenviarlos.
      return { handled: false, reason: `evento ignorado: ${event.type}` };
  }
}

/** Verifica la firma del webhook de Stripe. */
export function verifyStripeSignature(
  rawBody: Buffer,
  signature: string,
): Stripe.Event {
  if (!env.STRIPE_WEBHOOK_SECRET) {
    throw new Error('STRIPE_WEBHOOK_SECRET es obligatorio para procesar webhooks de Stripe');
  }

  return getStripe().webhooks.constructEvent(rawBody, signature, env.STRIPE_WEBHOOK_SECRET);
}

export function extractPaymentEvent(
  stripeEvent: Stripe.Event,
): WebhookPaymentEvent | null {
  switch (stripeEvent.type) {
    case 'payment_intent.succeeded':
    case 'payment_intent.payment_failed': {
      const intent = stripeEvent.data.object as Stripe.PaymentIntent;
      return {
        type: stripeEvent.type,
        paymentIntentId: intent.id,
        amountCents: intent.amount,
        currency: intent.currency.toUpperCase(),
        failureMessage:
          'last_payment_error' in intent
            ? ((intent as { last_payment_error?: { message?: string } }).last_payment_error?.message ?? undefined)
            : undefined,
      };
    }

    case 'charge.refunded': {
      const charge = stripeEvent.data.object as Stripe.Charge;
      const intentId =
        typeof charge.payment_intent === 'string' ? charge.payment_intent : charge.payment_intent?.id;
      if (!intentId) return null;
      return { type: stripeEvent.type, paymentIntentId: intentId };
    }

    default:
      return null;
  }
}

/**
 * Registra el cobro contra entrega al momento de la entrega.
 * Para el modo ON_DELIVERY no hay PaymentIntent: el repartidor
 * confirma que cobró.
 */
export async function recordCashOnDelivery(
  trackingCode: string,
  actorId: string,
  collected: boolean,
  req?: FastifyRequest,
): Promise<void> {
  const shipment = await prisma.shipment.findUnique({
    where: { trackingCode },
    select: { id: true, trackingCode: true, paymentMethod: true, paymentStatus: true },
  });

  if (!shipment) return;
  if (shipment.paymentMethod !== 'ON_DELIVERY') return;

  await prisma.shipment.update({
    where: { id: shipment.id },
    data: { paymentStatus: collected ? 'PAID' : 'PENDING', paidAt: collected ? new Date() : null },
  });

  await recordAudit(
    {
      userId: actorId,
      action: collected ? 'PAYMENT_COD_COLLECTED' : 'PAYMENT_COD_NOT_COLLECTED',
      entity: 'Shipment',
      entityId: shipment.id,
      shipmentCode: shipment.trackingCode,
      metadata: { collected },
    },
    req,
  );
}