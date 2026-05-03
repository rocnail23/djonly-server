import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from 'src/generated/prisma/client';

// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const GENRE_NAMES: readonly string[] = [
  'House',
  'Tech House',
  'Techno',
  'Afro House',
  'Hip Hop',
  'Latin',
  'Drum & Bass',
  'Open Format',
] as const;

async function seedGenres(): Promise<void> {
  await prisma.genre.createMany({
    data: GENRE_NAMES.map((name: string) => ({ name })),
    skipDuplicates: true,
  });
}

async function executeSeed(): Promise<void> {
  await seedGenres();
}

executeSeed()
  .then(async (): Promise<void> => {
    await prisma.$disconnect();
    console.info('Seed completed: genres inserted.');
  })
  .catch(async (error: unknown): Promise<void> => {
    console.error('Seed failed:', error);
    await prisma.$disconnect();
    process.exit(1);
  });
