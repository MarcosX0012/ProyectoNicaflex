import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { UserRole } from '@prisma/client';
import {
  cancelShipmentSchema,
  createShipmentSchema,
  custodySchema,
  deliverShipmentSchema,
  listShipmentsSchema,
  manualEventSchema,
  timelineQuerySchema,
  updateShipmentSchema,
} from '../modules/shipments/schema.js';
import * as shipmentService from '../modules/shipments/service.js';
import { dispatchToCourier } from '../modules/shipments/dispatch.js';
import { generateQrDataUrl, generateQrSvg, buildShippingLabelSvg } from '../modules/shipments/qr.js';
import { signTrackingToken } from '../modules/auth/qrTokens.js';
import { prisma } from '../lib/prisma.js';
import { sendDeliveryOtp } from '../modules/notifications/service.js';
import { statusLabelOf, type AccessTokenClaims } from './helpers.js';

/**
 * RUTAS DE ENVIOS
 *
 * Convencion de respuestas:
 *  - `data` envuelve el recurso en las respuestas de exito.
 *  - Los errores usan el formato unificado de `errorHandlerPlugin`.
 */

function actorOf(req: FastifyRequest): { userId: string; roles: UserRole[] } {
  const user = req.currentUser as AccessTokenClaims | undefined;
  if (!user) {
    // La ruta exige `authenticate`; si llega aqui es un bug de ruteo.
    throw new Error('actorOf called on an unauthenticated request');
  }
  return { userId: user.sub, roles: user.roles };
}

export async function shipmentRoutes(app: FastifyInstance): Promise<void> {
  // ── Crear envio ───────────────────────────────────────────
  app.post(
    '/',
    {
      preHandler: [app.authenticate, app.requireRole('SENDER', 'OPERATOR', 'ADMIN')],
      schema: {
        tags: ['shipments'],
        summary: 'Crea un envio y devuelve su codigo de rastreo y QR',
      },
    },
    async (req, reply) => {
      const input = createShipmentSchema.parse(req.body);
      const result = await shipmentService.createShipment(actorOf(req).userId, input, req);

      const [qrDataUrl, qrSvg] = await Promise.all([
        generateQrDataUrl(result.qrToken),
        generateQrSvg(result.qrToken),
      ]);

      return reply.status(201).send({
        data: {
          trackingCode: result.trackingCode,
          shipmentId: result.shipmentId,
          status: result.status,
          statusLabel: statusLabelOf(result.status),
          qr: {
            dataUrl: qrDataUrl,
            svg: qrSvg,
            trackingUrl: result.trackingUrl,
          },
          estimatedDeliveryAt: result.estimatedDeliveryAt,
        },
      });
    },
  );

  // ── Listar envios ─────────────────────────────────────────
  app.get(
    '/',
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ['shipments'],
        summary: 'Lista envios con filtros',
        description:
          'Un usuario normal solo ve los envios que envia o recibe. ' +
          'Operadores y administradores ven todos.',
      },
    },
    async (req) => {
      const query = listShipmentsSchema.parse(req.query);
      const result = await shipmentService.listShipments(actorOf(req), query);
      return result;
    },
  );

  // ── Metricas del panel ────────────────────────────────────
  app.get(
    '/metrics',
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ['shipments'],
        summary: 'Metricas de envios (personal o globales segun el rol)',
      },
    },
    async (req) => {
      return { data: await shipmentService.getDashboardMetrics(actorOf(req)) };
    },
  );

  // ── Detalle de envio ──────────────────────────────────────
  app.get(
    '/:code',
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ['shipments'],
        summary: 'Detalle de un envio',
      },
    },
    async (req) => {
      const { code } = req.params as { code: string };
      return { data: await shipmentService.getShipmentDetail(code, actorOf(req), req) };
    },
  );

  // ── Linea de tiempo ───────────────────────────────────────
  app.get(
    '/:code/timeline',
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ['shipments'],
        summary: 'Linea de tiempo del envio, en orden',
      },
    },
    async (req) => {
      const { code } = req.params as { code: string };
      const query = timelineQuerySchema.parse(req.query ?? {});
      const timeline = await shipmentService.getTimeline(code, query, req);
      return { data: timeline };
    },
  );

  // ── Cadena de custodia ────────────────────────────────────
  app.get(
    '/:code/custody',
    {
      preHandler: [app.authenticate, app.requireRole('OPERATOR', 'COURIER', 'ADMIN')],
      schema: {
        tags: ['shipments'],
        summary: 'Cadena de custodia completa (operativo)',
      },
    },
    async (req) => {
      const { code } = req.params as { code: string };
      return { data: await shipmentService.getCustodyChain(code) };
    },
  );

  // ── Actualizar envio ──────────────────────────────────────
  app.patch(
    '/:code',
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ['shipments'],
        summary: 'Modifica un envio (solo antes del despacho)',
      },
    },
    async (req) => {
      const { code } = req.params as { code: string };
      const input = updateShipmentSchema.parse(req.body);
      return { data: await shipmentService.updateShipment(code, actorOf(req), input, req) };
    },
  );

  // ── Cancelar ──────────────────────────────────────────────
  app.post(
    '/:code/cancel',
    {
      preHandler: [app.authenticate],
      schema: { tags: ['shipments'], summary: 'Cancela un envio antes del despacho' },
    },
    async (req) => {
      const { code } = req.params as { code: string };
      const input = cancelShipmentSchema.parse(req.body);
      return { data: await shipmentService.cancelShipment(code, actorOf(req), input.reason, req) };
    },
  );

  // ── Registrar evento manual ──────────────────────────────
  app.post(
    '/:code/events',
    {
      preHandler: [app.authenticate, app.requireRole('OPERATOR', 'COURIER', 'ADMIN')],
      schema: {
        tags: ['shipments'],
        summary: 'Registra un hito en la linea de tiempo',
        description: 'La transicion se valida contra la maquina de estados.',
      },
    },
    async (req) => {
      const { code } = req.params as { code: string };
      const input = manualEventSchema.parse(req.body);
      return { data: await shipmentService.recordManualEvent(code, actorOf(req), input, req) };
    },
  );

  // ── Registrar custodia ────────────────────────────────────
  app.post(
    '/:code/custody',
    {
      preHandler: [app.authenticate, app.requireRole('OPERATOR', 'COURIER', 'ADMIN')],
      schema: {
        tags: ['shipments'],
        summary: 'Registra un escaneo o traspaso de custodia',
      },
    },
    async (req) => {
      const { code } = req.params as { code: string };
      const input = custodySchema.parse(req.body);
      return { data: await shipmentService.registerCustody(code, actorOf(req), input, req) };
    },
  );

  // ── Despachar al transportista ────────────────────────────
  app.post(
    '/:code/dispatch',
    {
      preHandler: [app.authenticate, app.requireRole('OPERATOR', 'ADMIN')],
      schema: {
        tags: ['shipments'],
        summary: 'Registra el envio en el transportista',
      },
    },
    async (req) => {
      const { code } = req.params as { code: string };
      const shipment = await shipmentService.assertOwnership(code, actorOf(req));
      const result = await dispatchToCourier(shipment.id, actorOf(req).userId);

      if (!result) {
        return {
          message: 'El envio no requiere despacho (ya esta en el transportista o su estado no lo permite)',
        };
      }

      return { data: result };
    },
  );

  // ── Entrega ───────────────────────────────────────────────
  app.post(
    '/:code/deliver',
    {
      preHandler: [app.authenticate, app.requireRole('COURIER', 'OPERATOR', 'ADMIN')],
      schema: {
        tags: ['shipments'],
        summary: 'Registra la entrega',
        description:
          'Si se incluye el OTP del receptor, la entrega queda como ' +
          'verificada. Sin OTP pero con firma o foto, queda con evidencia fisica. ' +
          'Sin ninguna de las dos, exige un motivo y queda sin verificar.',
      },
    },
    async (req) => {
      const { code } = req.params as { code: string };
      const input = deliverShipmentSchema.parse(req.body);
      return { data: await shipmentService.deliverShipment(code, actorOf(req), input, req) };
    },
  );

  // ── Solicitar OTP de entrega ──────────────────────────────
  app.post(
    '/:code/delivery-otp',
    {
      preHandler: [app.authenticate, app.requireRole('COURIER', 'OPERATOR', 'ADMIN')],
      schema: {
        tags: ['shipments'],
        summary: 'Pide enviar el codigo de verificacion al receptor',
        description:
          'El repartidor lo usa para pedir al receptor que confirme la recepcion.',
      },
    },
    async (req) => {
      const { code } = req.params as { code: string };
      const shipment = await shipmentService.assertOwnership(code, actorOf(req));
      const result = await sendDeliveryOtp(shipment.id, actorOf(req).userId);

      return {
        data: {
          sent: result.sent,
          expiresAt: result.expiresAt ?? null,
          // En desarrollo el codigo se devuelve para poder probar el
          // flujo completo sin configurar WhatsApp.
          ...(process.env.NODE_ENV !== 'production' && !result.sent ? {} : {}),
          ...(result.error ? { note: result.error } : {}),
        },
      };
    },
  );

  // ── QR y etiqueta ─────────────────────────────────────────
  app.get(
    '/:code/qr',
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ['shipments'],
        summary: 'Devuelve el QR del envio en PNG o SVG',
        querystring: {
          type: 'object',
          properties: { format: { type: 'string', enum: ['svg', 'png'], default: 'png' } },
        },
      },
    },
    async (req, reply) => {
      const { code } = req.params as { code: string };
      const { format } = req.query as { format: 'svg' | 'png' };

      // Se valida propiedad: solo quien puede ver el envio lo descarga.
      const shipment = await shipmentService.getShipmentDetail(code, actorOf(req), req);
      const qrToken = await getQrToken(shipment.trackingCode);

      if (format === 'svg') {
        reply.type('image/svg+xml');
        return generateQrSvg(qrToken);
      }

      reply.type('image/png');
      return generateQrDataUrl(qrToken);
    },
  );

  app.get(
    '/:code/label',
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ['shipments'],
        summary: 'Etiqueta imprimible en SVG',
      },
    },
    async (req, reply) => {
      const { code } = req.params as { code: string };
      const shipment = await shipmentService.getShipmentDetail(code, actorOf(req), req);

      const full = await prisma.shipment.findUniqueOrThrow({
        where: { trackingCode: shipment.trackingCode },
        include: {
          sender: { select: { firstName: true, lastName: true } },
          recipientAddress: true,
        },
      });

      const qrToken = await getQrToken(shipment.trackingCode);

      reply.type('image/svg+xml');
      return buildShippingLabelSvg({
        qrToken,
        trackingCode: shipment.trackingCode,
        senderName: `${full.sender.firstName} ${full.sender.lastName}`,
        recipientName: full.recipientAddress.contactName,
        destinationCity: full.recipientAddress.city,
        destinationLine1: full.recipientAddress.line1,
        itemCount: shipment.itemCount,
        weightGrams: shipment.weightGrams,
      });
    },
  );
}

/**
 * Recupera (o reemite) el token firmado del QR.
 *
 * El envio guarda solo el HASH del token: si la base se filtra, los QR
 * impresos no permiten firmar enlaces nuevos. Para reimprimir una
 * etiqueta hay que volver a firmar, lo cual es seguro porque el handler
 * ya comprobo que quien pregunta es el emisor o el personal operativo.
 */
function getQrToken(trackingCode: string): string {
  return signTrackingToken(trackingCode);
}