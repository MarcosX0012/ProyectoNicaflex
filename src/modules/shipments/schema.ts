import { z } from 'zod';

/**
 * Validacion de entrada del modulo de envios.
 *
 * Nota sobre limites: los limites de peso, valor y cantidad de items
 * son reglas de negocio, no limites de seguridad. Si el negocio crece
 * (viaja desde el extranjero, se aceptan cargas industriales) se
 * ajustan aqui y en la validacion equivalente del servicio.
 */

export const MAX_ITEMS_PER_SHIPMENT = 50;
export const MAX_WEIGHT_KG = 70;
export const MAX_DECLARED_VALUE = 5_000_000; // en centavos de la moneda base

// ── Direcciones ───────────────────────────────────────────────

export const addressSchema = z.object({
  contactName: z.string().trim().min(2, 'Nombre del contacto obligatorio').max(120),
  contactPhone: z
    .string()
    .trim()
    .regex(/^\+?[0-9]{7,15}$/, 'Telefono invalido (7 a 15 digitos)'),
  line1: z.string().trim().min(4, 'Direccion demasiado corta').max(200),
  line2: z.string().trim().max(200).nullish(),
  city: z.string().trim().min(2, 'Ciudad obligatoria').max(80),
  region: z.string().trim().max(80).nullish(),
  postalCode: z.string().trim().max(20).nullish(),
  countryCode: z.string().trim().length(2, 'Codigo de pais de 2 letras').default('BO'),
  instructions: z.string().trim().max(500).nullish(),
  latitude: z.number().min(-90).max(90).nullish(),
  longitude: z.number().min(-180).max(180).nullish(),
});

export type AddressInput = z.infer<typeof addressSchema>;

// ── Items (productos dentro del paquete) ───────────────────────

export const shipmentItemSchema = z.object({
  lineCode: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9._-]{1,24}$/, 'Codigo de linea: letras, numeros, punto, guion')
    .optional(),
  sku: z.string().trim().max(60).nullish(),
  name: z.string().trim().min(1, 'El producto debe tener nombre').max(160),
  description: z.string().trim().max(500).nullish(),
  quantity: z.number().int().min(1, 'Cantidad minima 1').max(9999).default(1),
  unitValueCents: z.number().int().min(0).max(MAX_DECLARED_VALUE).default(0),
  weightGrams: z.number().int().min(1).max(MAX_WEIGHT_KG * 1000).nullish(),
  isFragile: z.boolean().default(false),
  isHazmat: z.boolean().default(false),
});

export type ShipmentItemInput = z.infer<typeof shipmentItemSchema>;

// ── Creacion de envio ──────────────────────────────────────────

export const createShipmentSchema = z.object({
  /** Receptor registrado en el sistema. Opcional: puede enviarse a un tercero. */
  recipientId: z.string().uuid('recipientId invalido').nullish(),

  recipientEmail: z.string().trim().toLowerCase().email().nullish(),

  senderAddress: addressSchema,
  recipientAddress: addressSchema,

  items: z
    .array(shipmentItemSchema)
    .min(1, 'El envio debe tener al menos un producto')
    .max(MAX_ITEMS_PER_SHIPMENT, `Maximo ${MAX_ITEMS_PER_SHIPMENT} productos por envio`),

  weightGrams: z
    .number()
    .int()
    .min(1, 'Indica el peso del paquete')
    .max(MAX_WEIGHT_KG * 1000, `Peso maximo ${MAX_WEIGHT_KG} kg`)
    .optional(),

  declaredValueCents: z.number().int().min(0).max(MAX_DECLARED_VALUE).optional(),

  paymentMethod: z.enum(['ONLINE', 'ON_DELIVERY']).default('ON_DELIVERY'),
  currency: z.string().trim().length(3).default('BOB'),

  originBranchId: z.string().uuid().nullish(),
  destinationBranchId: z.string().uuid().nullish(),

  /** Negocio del emisor: "hace cuanto se creo". */
  notes: z.string().trim().max(1000).nullish(),

  /**
   * Importe a cobrar. Solo aplica si `paymentMethod` es ONLINE.
   * Si se omite, se deriva del valor declarado de los productos y el
   * envio se registra con `NOT_REQUIRED` (a cotizar por el emisor).
   */
  amountCents: z.number().int().min(0).max(MAX_DECLARED_VALUE).optional(),

  /**
   * Clave de idempotencia. Si se repite la misma peticion con la misma
   * clave, se devuelve el envio ya creado en vez de crear otro.
   */
  idempotencyKey: z.string().trim().min(8).max(120).optional(),
}).superRefine((value, ctx) => {
  // Sin receptor en el sistema se necesita su correo para notificarle.
  if (!value.recipientId && !value.recipientEmail) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['recipientId'],
      message: 'Indica el receptor (recipientId) o su correo (recipientEmail)',
    });
  }
  // Las direcciones no pueden ser identicas.
  if (
    value.senderAddress.line1.trim().toLowerCase() === value.recipientAddress.line1.trim().toLowerCase() &&
    value.senderAddress.city.trim().toLowerCase() === value.recipientAddress.city.trim().toLowerCase()
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['recipientAddress'],
      message: 'La direccion de destino debe ser distinta a la de origen',
    });
  }
});

export type CreateShipmentInput = z.infer<typeof createShipmentSchema>;

// ── Actualizacion (solo antes del despacho) ───────────────────

export const updateShipmentSchema = z
  .object({
    recipientAddress: addressSchema.optional(),
    weightGrams: z.number().int().min(1).max(MAX_WEIGHT_KG * 1000).optional(),
    declaredValueCents: z.number().int().min(0).max(MAX_DECLARED_VALUE).optional(),
    notes: z.string().trim().max(1000).nullish(),
    paymentMethod: z.enum(['ONLINE', 'ON_DELIVERY']).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'No hay campos para actualizar');

// ── Listado con filtros ───────────────────────────────────────

export const listShipmentsSchema = z.object({
  status: z
    .union([
      z.enum([
        'CREATED',
        'CONFIRMED',
        'AWAITING_PAYMENT',
        'AWAITING_PICKUP',
        'PICKED_UP',
        'IN_TRANSIT',
        'AT_DISTRIBUTION_CENTER',
        'OUT_FOR_DELIVERY',
        'DELIVERY_ATTEMPTED',
        'DELIVERED',
        'ON_HOLD',
        'EXCEPTION',
        'RETURNING',
        'RETURNED',
        'LOST',
        'CANCELLED',
      ]),
      z.array(z.string()),
    ])
    .optional(),
  /** Solo para operadores y admins. */
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  courierCode: z.string().trim().max(40).optional(),
  courierTrackingNumber: z.string().trim().max(80).optional(),
  originBranchId: z.string().uuid().optional(),
  destinationBranchId: z.string().uuid().optional(),
  /** "active" excluye los estados terminales. */
  scope: z.enum(['all', 'active', 'closed']).default('all'),
  search: z.string().trim().max(80).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  sort: z.enum(['createdAt', 'statusChangedAt', 'estimatedDeliveryAt']).default('createdAt'),
  order: z.enum(['asc', 'desc']).default('desc'),
});

export type ListShipmentsQuery = z.infer<typeof listShipmentsSchema>;

// ── Eventos manuales ───────────────────────────────────────────

export const manualEventSchema = z.object({
  status: z.enum([
    'CONFIRMED',
    'AWAITING_PAYMENT',
    'AWAITING_PICKUP',
    'PICKED_UP',
    'IN_TRANSIT',
    'AT_DISTRIBUTION_CENTER',
    'OUT_FOR_DELIVERY',
    'DELIVERY_ATTEMPTED',
    'DELIVERED',
    'ON_HOLD',
    'EXCEPTION',
    'RETURNING',
    'RETURNED',
    'LOST',
    'CANCELLED',
  ]),
  title: z.string().trim().min(3).max(120).optional(),
  description: z.string().trim().max(500).optional(),
  locationName: z.string().trim().max(120).optional(),
  /** Cuando ocurrio de verdad. Si se omite, es ahora. */
  occurredAt: z.coerce.date().optional(),
  metadata: z.record(z.unknown()).optional(),
  /** Hace la transicion idempotente si se reintenta el mismo request. */
  idempotencyKey: z.string().trim().min(8).max(120).optional(),
});

export type ManualEventInput = z.infer<typeof manualEventSchema>;

// ── Cancelacion ────────────────────────────────────────────────

export const cancelShipmentSchema = z.object({
  reason: z.string().trim().min(5, 'Indica el motivo de la cancelacion').max(300),
});

// ── Custodia ──────────────────────────────────────────────────

export const custodySchema = z.object({
  action: z.enum([
    'PICKUP',
    'SCAN_IN',
    'SCAN_OUT',
    'HANDOFF',
    'SORT',
    'LOAD_VEHICLE',
    'DELIVER',
    'ATTEMPT_DELIVERY',
    'RETURN',
  ]),
  branchId: z.string().uuid().nullish(),
  scanCode: z.string().trim().max(60).nullish(),
  latitude: z.number().min(-90).max(90).nullish(),
  longitude: z.number().min(-180).max(180).nullish(),
  note: z.string().trim().max(300).nullish(),
  occurredAt: z.coerce.date().optional(),
});

// ── Entrega ───────────────────────────────────────────────────

export const deliverShipmentSchema = z
  .object({
    /**
     * PRUEBA DE ENTREGA. Para confirmar, el receptor debe presentar
     * una de estas. Sin ninguna, el envio queda DELIVERED pero con
     * `deliveredAt` sin verificar, y el sistema lo marca.
     */
    otp: z.string().regex(/^\d{6}$/, 'El codigo tiene 6 digitos').optional(),
    signatureUrl: z.string().url().max(500).nullish(),
    photoUrls: z.array(z.string().url().max(500)).max(6).default([]),
    locationName: z.string().trim().max(120).optional(),
    latitude: z.number().min(-90).max(90).nullish(),
    longitude: z.number().min(-180).max(180).nullish(),
    /** Recepcion sin prueba, firmada por el repartidor. */
    unverifiedReason: z.string().trim().min(10).max(300).optional(),
  })
  .superRefine((value, ctx) => {
    const hasProof = Boolean(value.otp) || Boolean(value.signatureUrl) || value.photoUrls.length > 0;
    if (!hasProof && !value.unverifiedReason) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['otp'],
        message: 'Se requiere al menos una prueba de entrega (OTP, firma o foto)',
      });
    }
  });

export type DeliverShipmentInput = z.infer<typeof deliverShipmentSchema>;

// ── Consultas de la linea de tiempo ────────────────────────────

export const timelineQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.coerce.number().int().min(1).optional(),
});