// Prisma CLI configuration (Prisma 7). Connection URL lives here — never in
// schema.prisma — and is read from the environment (see ADR 0003).
import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: env('DATABASE_URL'),
  },
});
