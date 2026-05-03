import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { UploadsService } from './uploads.service';

const STALE_UPLOAD_MAX_AGE_MS = 1000 * 60 * 120; // 2 hours

@Injectable()
export class UploadsCleanupService {
  private readonly logger = new Logger(UploadsCleanupService.name);

  public constructor(private readonly uploadsService: UploadsService) {}

  @Cron(CronExpression.EVERY_2_HOURS)
  public async abortStaleMultipartUploads(): Promise<void> {
    try {
      const activeUploads =
        await this.uploadsService.listActiveMultipartUploads();
      const now = Date.now();
      const staleUploads = activeUploads.filter((upload) => {
        if (!upload.initiatedAt) {
          return true;
        }
        const ageMs = now - upload.initiatedAt.getTime();
        return ageMs >= STALE_UPLOAD_MAX_AGE_MS;
      });
      if (staleUploads.length === 0) {
        return;
      }
      this.logger.log(
        `Found ${staleUploads.length} stale multipart uploads. Aborting them now`,
      );
      for (const upload of staleUploads) {
        try {
          await this.uploadsService.abortMultipartUpload({
            uploadId: upload.uploadId,
            key: upload.key,
          });
          this.logger.log(
            `Aborted stale multipart uploadId=${upload.uploadId}, key=${upload.key}`,
          );
        } catch (error) {
          this.logger.error(
            `Failed to abort stale upload uploadId=${upload.uploadId}, key=${upload.key}`,
            error,
          );
        }
      }
    } catch (error) {
      this.logger.error('Failed to clean stale multipart uploads', error);
    }
  }
}
