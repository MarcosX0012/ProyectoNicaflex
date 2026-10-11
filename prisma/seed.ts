/**
 * SEED DE DESARROLLO
 * ==================
 *
 * Crea una base de datos de demostracion con datos coherentes entre si:
 * sucursales, usuarios de cada rol y envios en distintos estados de la
 * maquina de estados (no todos los envios empiezan igual).
 *
 * Dos propiedades importantes:
 *
 *  1. ES IDEMPOTENTE. Se puede ejecutar `npm run db:seed` las veces que
 *     haga falta: reejecutarlo actualiza los registros demo en vez de
 *     duplicarlos. Se identifica a los registros demo por el sufijo
 *     `@demo.hossana.local` y por los codigos de sucursal `DEMO-*`, nunca
 *     por su id, para que sobreviva a un reseteo de la base.
 *
 *  2. USA LOS MISMOS SERVICIOS QUE LA API. Los envios se crean con
 *     `createShipment` y avanzan con `applyStateChange`, de modo que el
 *     seed no puede producir datos que la API nunca produciria (eventos
 *     fuera de la maquina de estados, secuencias rotas, QR sin firmar).
 *     Si el seed pasa, las invariantes del sistema son correctas.
 *
 * Las contrasenas demo son deliberadamente debiles (`Demo1234!`) porque
 * su unico proposito es desarrollo local. En produccion este archivo
 * nunca se ejecuta.
 */

import 'dotenv/config';
import type { PrismaClient, UserRole } from '@prisma/client';
import type { z } from 'zod';
import { prisma } from '../src/lib/prisma.js';
import { hashPassword } from '../src/modules/auth/service.js';
import { issueOtp } from '../src/modules/auth/tokens.js';
import { createShipment, applyStateChange, deliverShipment } from '../src/modules/shipments/service.js';
import { encryptPII, blindIndex } from '../src/lib/crypto.js';
import { createShipmentSchema } from '../src/modules/shipments/schema.js';

/**
 * Tipo de ENTRADA del esquema (con opcionales y defaults sin aplicar).
 * El seed escribe datos a mano y omite campos como `isFragile` o
 * `currency`; `createShipmentSchema.parse` los rellena igual que lo
 * haria la API, asi que el seed no puede saltarse una validacion.
 */
type ShipmentSeedInput = z.input<typeof createShipmentSchema>;
type AddressSeedInput = ShipmentSeedInput['senderAddress'];
type ItemSeedInput = NonNullable<ShipmentSeedInput['items']>[number];

const DEMO_PASSWORD = 'Demo1234!';
const DEMO_DOMAIN = 'demo.hossana.local';

// ── Utilidades de consola ──────────────────────────────────────

function heading(title: string): void {
  process.stdout.write(`\n\x1b[1m${title}\x1b[0m\n${'─'.repeat(title.length)}\n`);
}

function ok(message: string): void {
  process.stdout.write(`  \x1b[32m✓\x1b[0m ${message}\n`);
}

function info(message: string): void {
  process.stdout.write(`  \x1b[90m·\x1b[0m ${message}\n`);
}

// ── Helpers de datos ───────────────────────────────────────────

/** Upsert por una clave natural (correo), que sobrevive a un reseteo. */
async function upsertUser(
  data: {
    email: string;
    firstName: string;
    lastName: string;
    password: string;
    phone?: string;
    roles: UserRole[];
    status?: 'ACTIVE' | 'PENDING_VERIFICATION' | 'SUSPENDED';
    locale?: string;
  },
): Promise<{ id: string; email: string }> {
  const passwordHash = await hashPassword(data.password);

  const user = await prisma.user.upsert({
    where: { email: data.email },
    create: {
      email: data.email,
      firstName: data.firstName,
      lastName: data.lastName,
      passwordHash,
      phoneCipher: data.phone ? encryptPII(data.phone) : null,
      phoneHash: data.phone ? blindIndex(data.phone) : null,
      roles: data.roles,
      status: data.status ?? 'ACTIVE',
      emailVerifiedAt: new Date(),
      phoneVerifiedAt: data.phone ? new Date() : null,
    },
    update: {
      firstName: data.firstName,
      lastName: data.lastName,
      passwordHash,
      phoneCipher: data.phone ? encryptPII(data.phone) : null,
      phoneHash: data.phone ? blindIndex(data.phone) : null,
      roles: data.roles,
      status: data.status ?? 'ACTIVE',
    },
    select: { id: true, email: true },
  });

  return user;
}

interface BranchSeed {
  code: string;
  name: string;
  city: string;
  addressLine: string;
  latitude: number;
  longitude: number;
}

const BRANCHES: BranchSeed[] = [
  {
    code: 'DEMO-LP',
    name: 'Centro de distribucion La Paz',
    city: 'La Paz',
    addressLine: 'Av. Cristo Redentor 1200',
    latitude: -16.4897,
    longitude: -68.1193,
  },
  {
    code: 'DEMO-SCZ',
    name: 'Centro de distribucion Santa Cruz',
    city: 'Santa Cruz',
    addressLine: 'Av. Banzer 3450',
    latitude: -17.7833,
    longitude: -63.1821,
  },
  {
    code: 'DEMO-CBB',
    name: 'Centro de distribucion Cochabamba',
    city: 'Cochabamba',
    addressLine: 'Av. Blanco Galindo 890',
    latitude: -17.3895,
    longitude: -66.1568,
  },
];

/**
 * Direcciones de ejemplo. `contactPhone` es PII: se cifra en reposo,
 * igual que en el flujo real de la API.
 */
const ADDRESSES = {
  laPaz: {
    contactName: 'Elena Vargas',
    contactPhone: '+59170011223',
    line1: 'Calle Soruco 145, Edificio Aurora, Depto 4B',
    city: 'La Paz',
    region: 'La Paz',
    postalCode: '0001',
    countryCode: 'BO',
    latitude: -16.5053,
    longitude: -68.135,
  },
  santaCruz: {
    contactName: 'Marco Villalba',
    contactPhone: '+59170123456',
    line1: 'Av. Cheyenne 8200, Barrio Los Cusis, Casa 17',
    city: 'Santa Cruz',
    region: 'Santa Cruz',
    postalCode: '0002',
    countryCode: 'BO',
    latitude: -17.7431,
    longitude: -63.1818,
  },
  cochabamba: {
    contactName: 'Rosa Quisbert',
    contactPhone: '+59170234567',
    line1: 'Av.-BY56 4560, Villa adoptive lote 22',
    city: 'Cochabamba',
    region: 'Cochabamba',
    postalCode: '0004',
    countryCode: 'BO',
    latitude: -17.379,
    longitude: -66.1603,
  },
} satisfies Record<string, AddressSeedInput>;

/**
 * Ciudad de cada direccion -> su clave en `ADDRESSES`. Permite tomar la
 * direccion de origen a partir de la sucursal de la que sale el envio.
 */
const CITY_KEY_BY_NAME: Record<string, keyof typeof ADDRESSES> = Object.fromEntries(
  (Object.keys(ADDRESSES) as (keyof typeof ADDRESSES)[]).map((key) => [ADDRESSES[key].city, key]),
);

// ── Seed ───────────────────────────────────────────────────────

async function seedBranches(): Promise<Record<string, string>> {
  heading('Sucursales');

  const ids: Record<string, string> = {};

  for (const branch of BRANCHES) {
    const row = await prisma.branch.upsert({
      where: { code: branch.code },
      create: {
        code: branch.code,
        name: branch.name,
        city: branch.city,
        countryCode: 'BO',
        addressLine: branch.addressLine,
        latitude: branch.latitude,
        longitude: branch.longitude,
      },
      update: {
        name: branch.name,
        city: branch.city,
        addressLine: branch.addressLine,
        latitude: branch.latitude,
        longitude: branch.longitude,
        isActive: true,
      },
      select: { id: true },
    });

    ids[branch.code] = row.id;
    ok(`${branch.code} · ${branch.name}`);
  }

  return ids;
}

interface DemoUsers {
  admin: { id: string; email: string };
  operator: { id: string; email: string };
  courier: { id: string; email: string };
  alice: { id: string; email: string };
  bruno: { id: string; email: string };
  carla: { id: string; email: string };
}

async function seedUsers(): Promise<DemoUsers> {
  heading('Usuarios');

  const admin = await upsertUser({
    email: `admin@${DEMO_DOMAIN}`,
    firstName: 'Ana',
    lastName: 'Rojas',
    password: DEMO_PASSWORD,
    phone: '+59170000001',
    roles: ['ADMIN'],
  });
  ok(`ADMIN      · ${admin.email}`);

  const operator = await upsertUser({
    email: `operador@${DEMO_DOMAIN}`,
    firstName: 'Luis',
    lastName: 'Mamani',
    password: DEMO_PASSWORD,
    phone: '+59170000002',
    roles: ['OPERATOR'],
  });
  ok(`OPERATOR   · ${operator.email}`);

  const courier = await upsertUser({
    email: `repartidor@${DEMO_DOMAIN}`,
    firstName: 'Jorge',
    lastName: 'Salas',
    password: DEMO_PASSWORD,
    phone: '+59170000003',
    roles: ['COURIER'],
  });
  ok(`COURIER    · ${courier.email}`);

  const alice = await upsertUser({
    email: `alice@${DEMO_DOMAIN}`,
    firstName: 'Alice',
    lastName: 'Fernandez',
    password: DEMO_PASSWORD,
    phone: '+59171111111',
    roles: ['SENDER', 'RECIPIENT'],
  });
  ok(`USER       · ${alice.email}  (SENDER, RECIPIENT)`);

  const bruno = await upsertUser({
    email: `bruno@${DEMO_DOMAIN}`,
    firstName: 'Bruno',
    lastName: 'Cespedes',
    password: DEMO_PASSWORD,
    phone: '+59172222222',
    roles: ['SENDER', 'RECIPIENT'],
  });
  ok(`USER       · ${bruno.email}  (SENDER, RECIPIENT)`);

  const carla = await upsertUser({
    email: `carla@${DEMO_DOMAIN}`,
    firstName: 'Carla',
    lastName: 'Mendoza',
    password: DEMO_PASSWORD,
    phone: '+59173333333',
    roles: ['SENDER', 'RECIPIENT'],
  });
  ok(`USER       · ${carla.email}  (SENDER, RECIPIENT)`);

  // Un usuario sin verificar, para probar el flujo de verificacion.
  const pending = await upsertUser({
    email: `pendiente@${DEMO_DOMAIN}`,
    firstName: 'Diego',
    lastName: 'Rojas',
    password: DEMO_PASSWORD,
    roles: ['RECIPIENT'],
    status: 'PENDING_VERIFICATION',
  });
  ok(`PENDING    · ${pending.email}`);

  return { admin, operator, courier, alice, bruno, carla };
}

/** Borra envios demo previos para no acumular duplicados al reejecutar. */
async function clearDemoShipments(): Promise<number> {
  const demoEmails = [
    `alice@${DEMO_DOMAIN}`,
    `bruno@${DEMO_DOMAIN}`,
    `carla@${DEMO_DOMAIN}`,
  ];

  const result = await prisma.shipment.deleteMany({
    where: { sender: { email: { in: demoEmails } } },
  });

  return result.count;
}

/** Estados por los que puede avanzar un envio en el seed. */
type SeedPathState =
  | 'AWAITING_PICKUP'
  | 'PICKED_UP'
  | 'IN_TRANSIT'
  | 'AT_DISTRIBUTION_CENTER'
  | 'OUT_FOR_DELIVERY'
  | 'DELIVERY_ATTEMPTED'
  | 'ON_HOLD'
  | 'EXCEPTION';

interface ShipmentSeed {
  label: string;
  senderId: string;
  recipientId: string;
  originBranchId: string;
  destinationBranchId: string;
  /** Direccion de destino. Determina a que ciudad llega el paquete. */
  recipientCity: keyof typeof ADDRESSES;
  items: ItemSeedInput[];
  notes: string;
  /** Estados por los que pasa, en orden. El ultimo es el estado final. */
  path: SeedPathState[];
  /** Si el envio termina entregado con OTP confirmado por el receptor. */
  deliverWithOtp?: boolean;
  paymentMethod?: 'ONLINE' | 'ON_DELIVERY';
  amountCents?: number;
}

/**
 * Crea un envio y lo avanza por `path` usando el servicio real de
 * transiciones. Las fechas de los hitos se retroceden para que la
 * linea de tiempo parezca historica y no todo un instante en el mismo
 * segundo.
 */
async function seedShipment(
  seed: ShipmentSeed,
  senderCity: keyof typeof ADDRESSES,
): Promise<string | null> {
  // Se valida con el mismo esquema que usa la API: si el seed define un
  // dato invalido, falla aqui y no despues en una transicion.
  const input = createShipmentSchema.parse({
    recipientId: seed.recipientId,
    senderAddress: ADDRESSES[senderCity],
    recipientAddress: ADDRESSES[seed.recipientCity],
    items: seed.items,
    originBranchId: seed.originBranchId,
    destinationBranchId: seed.destinationBranchId,
    notes: seed.notes,
    paymentMethod: seed.paymentMethod ?? 'ON_DELIVERY',
    amountCents: seed.amountCents,
    // Semilla fija: reejecutar el seed devuelve el mismo envio en vez
    // de crear uno nuevo.
    idempotencyKey: `seed-${seed.label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
  });

  const created = await createShipment(seed.senderId, input);
  const shipmentId = (
    await prisma.shipment.findUniqueOrThrow({
      where: { trackingCode: created.trackingCode },
      select: { id: true },
    })
  ).id;

  // Retrocede los hitos: 6 horas entre cada uno, hacia atras desde ahora.
  const stepMs = 6 * 60 * 60 * 1000;
  let stepsAgo = seed.path.length + 1;

  for (const to of seed.path) {
    stepsAgo -= 1;
    await applyStateChange(shipmentId, {
      to,
      occurredAt: new Date(Date.now() - stepsAgo * stepMs),
      source: 'SYSTEM',
      title: undefined,
      description: undefined,
    });
  }

  if (seed.deliverWithOtp) {
    // El receptor emite su OTP y lo presenta: es la unica via por la que
    // el sistema acepta una entrega verificada.
    const otp = await issueOtp(seed.recipientId, shipmentId, 'DELIVERY_CONFIRMATION');
    info(`OTP de ${seed.label}: ${otp.code}`);

    await deliverShipment(
      created.trackingCode,
      { userId: seed.senderId, roles: ['COURIER'] },
      { otp: otp.code, photoUrls: [], unverifiedReason: undefined },
    );
  }

  return created.trackingCode;
}

async function seedShipments(users: DemoUsers, branchIds: Record<string, string>): Promise<void> {
  heading('Envios');

  const removed = await clearDemoShipments();
  if (removed > 0) {
    info(`${removed} envio(s) demo previo(s) eliminado(s) para evitar duplicados`);
  }

  // La direccion del emisor se toma de la sucursal de ORIGEN del envio.
  // Antes estaba fijada siempre en La Paz, y los envios que llegaban a
  // La Paz (SCZ->LP, CBB->LP) chocaban con la validacion de la API:
  // origen y destino no pueden ser la misma direccion.
  const cityByBranchId = new Map<string, keyof typeof ADDRESSES>();
  for (const branch of BRANCHES) {
    const id = branchIds[branch.code];
    const key = CITY_KEY_BY_NAME[branch.city];
    if (id && key) cityByBranchId.set(id, key);
  }
  const senderCityOf = (originBranchId: string): keyof typeof ADDRESSES =>
    cityByBranchId.get(originBranchId) ?? 'laPaz';

  const seeds: ShipmentSeed[] = [
    {
      label: 'electronics-lp-scz',
      senderId: users.alice.id,
      recipientId: users.bruno.id,
      originBranchId: branchIds['DEMO-LP']!,
      destinationBranchId: branchIds['DEMO-SCZ']!,
      recipientCity: 'santaCruz',
      notes: 'Vajilla de cocina, paquete fragile. Manipular con cuidado.',
      items: [
        { name: 'Juego de ollas antiadherentes', quantity: 1, unitValueCents: 45000, weightGrams: 3200, isFragile: true },
        { name: 'Cubiertos de acero (12 piezas)', quantity: 2, unitValueCents: 8000, weightGrams: 900 },
      ],
      path: ['AWAITING_PICKUP', 'PICKED_UP', 'IN_TRANSIT', 'AT_DISTRIBUTION_CENTER', 'OUT_FOR_DELIVERY'],
    },
    {
      label: 'documents-lp-cbb',
      senderId: users.alice.id,
      recipientId: users.carla.id,
      originBranchId: branchIds['DEMO-LP']!,
      destinationBranchId: branchIds['DEMO-CBB']!,
      recipientCity: 'cochabamba',
      notes: 'Documentos legales, sin valor comercial.',
      items: [
        { name: 'Carpeta de contratos firmados', quantity: 1, unitValueCents: 0, weightGrams: 400 },
      ],
      path: ['AWAITING_PICKUP', 'PICKED_UP', 'IN_TRANSIT'],
    },
    {
      label: 'clothing-scz-lp',
      senderId: users.bruno.id,
      recipientId: users.alice.id,
      originBranchId: branchIds['DEMO-SCZ']!,
      destinationBranchId: branchIds['DEMO-LP']!,
      recipientCity: 'laPaz',
      notes: 'Ropa de temporada.',
      items: [
        { name: 'Chaqueta de jean', quantity: 1, unitValueCents: 12000, weightGrams: 1100 },
        { name: 'Camisetas de algodón', quantity: 4, unitValueCents: 3500, weightGrams: 250 },
      ],
      path: ['AWAITING_PICKUP', 'PICKED_UP', 'IN_TRANSIT', 'AT_DISTRIBUTION_CENTER', 'OUT_FOR_DELIVERY', 'DELIVERY_ATTEMPTED', 'OUT_FOR_DELIVERY'],
    },
    {
      label: 'medicine-cbb-lp',
      senderId: users.carla.id,
      recipientId: users.alice.id,
      originBranchId: branchIds['DEMO-CBB']!,
      destinationBranchId: branchIds['DEMO-LP']!,
      recipientCity: 'laPaz',
      notes: 'Medicamento con receta. Entrega solo a la persona registrada.',
      items: [
        { name: 'Caja de medicamento (receta)', quantity: 1, unitValueCents: 22000, weightGrams: 600 },
      ],
      paymentMethod: 'ONLINE',
      amountCents: 6500,
      path: ['AWAITING_PICKUP', 'PICKED_UP', 'IN_TRANSIT', 'AT_DISTRIBUTION_CENTER', 'OUT_FOR_DELIVERY'],
    },
  ];

  for (const seed of seeds) {
    const code = await seedShipment(seed, senderCityOf(seed.originBranchId));
    if (code) ok(`${code} · ${seed.label}`);
  }

  // Un envio ya entregado y verificado con OTP: el caso de exito del
  // que el sistema entero depende.
  const delivered = await seedShipment({
    label: 'book-scz-cbb',
    senderId: users.bruno.id,
    recipientId: users.carla.id,
    originBranchId: branchIds['DEMO-SCZ']!,
    destinationBranchId: branchIds['DEMO-CBB']!,
    recipientCity: 'cochabamba',
    notes: 'Libros, sin merchandise fragil.',
    items: [
      { name: 'Caja de libros (6 tomos)', quantity: 1, unitValueCents: 30000, weightGrams: 5200 },
    ],
    path: ['AWAITING_PICKUP', 'PICKED_UP', 'IN_TRANSIT', 'AT_DISTRIBUTION_CENTER', 'OUT_FOR_DELIVERY'],
    deliverWithOtp: true,
  }, senderCityOf(branchIds['DEMO-SCZ']!));
  if (delivered) ok(`${delivered} · book-scz-cbb (entregado y verificado con OTP)`);

  // Un envio con incidencia, para que el panel no muestre siempre todo verde.
  const exception = await seedShipment({
    label: 'furniture-cbb-lp',
    senderId: users.carla.id,
    recipientId: users.bruno.id,
    originBranchId: branchIds['DEMO-CBB']!,
    destinationBranchId: branchIds['DEMO-LP']!,
    recipientCity: 'laPaz',
    notes: 'Mueble desarmado. Requiere dos personas para la entrega.',
    items: [
      { name: 'Estanteria (desarmada, 3 bulones)', quantity: 1, unitValueCents: 55000, weightGrams: 18400, isFragile: true },
    ],
    path: ['AWAITING_PICKUP', 'PICKED_UP', 'IN_TRANSIT', 'ON_HOLD'],
  }, senderCityOf(branchIds['DEMO-CBB']!));
  if (exception) ok(`${exception} · furniture-cbb-lp (en espera)`);

  // Resumen para comparar contra lo que muestra el panel.
  const byStatus = await prisma.shipment.groupBy({
    by: ['status'],
    _count: { _all: true },
    orderBy: { status: 'asc' },
  });

  info('Resumen por estado:');
  for (const row of byStatus) {
    process.stdout.write(`      ${row.status.padEnd(24)} ${row._count._all}\n`);
  }
}

// ── Punto de entrada ───────────────────────────────────────────

export async function main(client: PrismaClient = prisma): Promise<void> {
  void client;
  process.stdout.write('\x1b[1mHossana · seed de desarrollo\x1b[0m\n');

  const branchIds = await seedBranches();
  const users = await seedUsers();
  await seedShipments(users, branchIds);

  heading('Listo');
  process.stdout.write(`  Contrasena de todos los usuarios demo: \x1b[33m${DEMO_PASSWORD}\x1b[0m\n`);
  process.stdout.write('  Swagger:  http://localhost:3000/docs\n\n');
}

// Solo se ejecuta cuando se invoca directamente (`tsx prisma/seed.ts`),
// no cuando se importa desde un test.
const invokedDirectly = process.argv[1]?.replace(/\\/g, '/').endsWith('prisma/seed.ts');
if (invokedDirectly) {
  main()
    .then(async () => {
      await prisma.$disconnect();
    })
    .catch(async (error: unknown) => {
      process.stderr.write(`\n\x1b[31mEl seed fallo:\x1b[0m ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
      await prisma.$disconnect();
      process.exitCode = 1;
    });
}
