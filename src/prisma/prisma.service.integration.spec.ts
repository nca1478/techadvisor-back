import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';

/**
 * Integration test: requires the Docker Compose PostgreSQL with migrations
 * applied (`docker compose up -d && npx prisma migrate dev`).
 */
describe('PostgreSQL pgvector extension (integration)', () => {
  it('has the vector extension installed', async () => {
    const databaseUrl = process.env['DATABASE_URL'];
    if (!databaseUrl) {
      throw new Error(
        'DATABASE_URL is not set. Copy backend/.env.example to backend/.env or export DATABASE_URL before running integration tests.',
      );
    }

    const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
    try {
      const rows = await prisma.$queryRaw<Array<{ extname: string }>>`
        SELECT extname FROM pg_extension WHERE extname = 'vector'
      `;
      expect(rows).toEqual([{ extname: 'vector' }]);
    } finally {
      await prisma.$disconnect();
    }
  }, 30_000);
});
