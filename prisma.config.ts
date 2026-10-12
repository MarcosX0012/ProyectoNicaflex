import { defineConfig } from 'prisma/config';
import { config as loadEnv } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dirname = path.dirname(fileURLToPath(import.meta.url));
loadEnv({ path: path.join(dirname, '.env') });

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    url: process.env.DATABASE_URL ?? '',
  },
});