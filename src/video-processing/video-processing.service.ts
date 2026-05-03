import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import { VIDEO_PROCESSING_QUEUE_NAME } from './video-processing.constants';
import { buildVideoProcessingRedisConnection } from './video-processing-redis-options';
import { type VideoProcessingJobPayload } from './video-processing.types';

const PROCESS_VIDEO_JOB_NAME = 'process-video';

@Injectable()
export class VideoProcessingService implements OnModuleDestroy {
  private readonly logger = new Logger(VideoProcessingService.name);
  private readonly queue = new Queue<VideoProcessingJobPayload>(
    VIDEO_PROCESSING_QUEUE_NAME,
    {
      connection: buildVideoProcessingRedisConnection(),
    },
  );

  public async enqueueVideoProcessing(
    payload: VideoProcessingJobPayload,
  ): Promise<void> {
    await this.queue.add(PROCESS_VIDEO_JOB_NAME, payload, {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 2000,
      },
      removeOnComplete: 100,
      removeOnFail: 100,
    });
    this.logger.log(
      `Queued processing job for video=${payload.videoId}, key=${payload.fullVideoKey}`,
    );
  }

  public async onModuleDestroy(): Promise<void> {
    await this.queue.close();
  }
}
