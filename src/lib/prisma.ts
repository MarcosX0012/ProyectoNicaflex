import { PrismaClient } from '@prisma/client';
import { env } from '../config/env.js';

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

/**
 * Cliente unico de Prisma. En desarrollo se cachea en `globalThis`
 * para que el hot-reload de tsx no abra un pool por cada recarga.
 */
export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: env.isDevelopment ? ['warn', 'error'] : ['error'],
  });

if (!env.isProduction) {
  globalForPrisma.prisma = prisma;
}

export async function connectDatabase(): Promise<void> {
  await prisma.$connect();
  // La secuencia global de codigos de rastreo debe existir siempre:
  // es la garantia de que un trackingCode nunca se reutiliza.
  await prisma.$executeRawUnsafe(`
    CREATE SEQUENCE IF NOT EXISTS shipment_code_seq START 1 INCREMENT 1 NO CYCLE
  `);
}

export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}