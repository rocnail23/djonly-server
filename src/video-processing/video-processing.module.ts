import { Module } from '@nestjs/common';
import { PrismaModule } from 'src/prisma/prisma.module';
import { VideoProcessingProcessorService } from './video-processing-processor.service';
import { VideoProcessingService } from './video-processing.service';
import { VideoProcessingWorkerService } from './video-processing.worker';

@Module({
  imports: [PrismaModule],
  providers: [
    VideoProcessingService,
    VideoProcessingProcessorService,
    VideoProcessingWorkerService,
  ],
  exports: [VideoProcessingService],
})
export class VideoProcessingModule {}
