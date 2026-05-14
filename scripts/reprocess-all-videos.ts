import 'dotenv/config';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from 'src/generated/prisma/client';
import { Queue } from 'bullmq';

const QUEUE_NAME = 'video-processing';
const JOB_NAME = 'process-video';

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

  const queue = new Queue(QUEUE_NAME, {
    connection: {
      host: process.env.REDIS_HOST ?? 'redis',
      port: Number(process.env.REDIS_PORT ?? 6379),
      password: process.env.REDIS_PASSWORD || undefined,
    },
  });

  try {
    const videos = await prisma.video.findMany({
      where: { fullVideoKey: { not: '' } },
      select: { id: true, fullVideoKey: true, title: true },
    });

    console.log(`Found ${videos.length} videos to reprocess`);

    for (const video of videos) {
      // Reset processing state so the worker regenerates preview and thumbnail
      await prisma.video.update({
        where: { id: video.id },
        data: {
          isProcessing: true,
          previewKey: null,
          thumbnailKey: null,
          processingError: null,
          processedAt: null,
        },
      });

      await queue.add(JOB_NAME, { videoId: video.id, fullVideoKey: video.fullVideoKey }, {
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: 100,
        removeOnFail: 100,
      });

      console.log(`Queued: [${video.id}] ${video.title}`);
    }

    console.log('Done — all videos queued for reprocessing');
  } finally {
    await queue.close();
    await prisma.$disconnect();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
