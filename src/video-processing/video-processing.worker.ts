import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Job, Worker } from 'bullmq';
import { envs } from 'src/config/envs';
import { VIDEO_PROCESSING_QUEUE_NAME } from './video-processing.constants';
import { VideoProcessingProcessorService } from './video-processing-processor.service';
import { buildVideoProcessingRedisConnection } from './video-processing-redis-options';
import { type VideoProcessingJobPayload } from './video-processing.types';

@Injectable()
export class VideoProcessingWorkerService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(VideoProcessingWorkerService.name);
  private worker: Worker<VideoProcessingJobPayload> | null = null;

  public constructor(
    private readonly videoProcessingProcessorService: VideoProcessingProcessorService,
  ) {}

  public onModuleInit(): void {
    this.worker = new Worker<VideoProcessingJobPayload>(
      VIDEO_PROCESSING_QUEUE_NAME,
      async (job: Job<VideoProcessingJobPayload>): Promise<void> => {
        await this.videoProcessingProcessorService.processVideo(job.data);
      },
      {
        connection: buildVideoProcessingRedisConnection(),
        concurrency: envs.VIDEO_PROCESSING_CONCURRENCY,
      },
    );
    this.worker.on('completed', (job: Job<VideoProcessingJobPayload>) => {
      this.logger.log(`Processing completed for video=${job.data.videoId}`);
    });
    this.worker.on(
      'failed',
      (job: Job<VideoProcessingJobPayload> | undefined, error: Error) => {
        this.logger.error(
          `Processing failed for video=${job?.data.videoId ?? 'unknown'}: ${error.message}`,
        );
      },
    );
  }

  public async onModuleDestroy(): Promise<void> {
    if (!this.worker) {
      return;
    }
    await this.worker.close();
  }
}
