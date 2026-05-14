import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Injectable, Logger } from '@nestjs/common';
import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { type ReadableStream as NodeReadableStream } from 'node:stream/web';
import { pipeline } from 'node:stream/promises';
import { envs } from 'src/config/envs';
import { PrismaService } from 'src/prisma/prisma.service';
import { type VideoProcessingJobPayload } from './video-processing.types';

const PREVIEW_DURATION_SECONDS = 40;
const THUMBNAIL_CAPTURE_SECOND = 1;
const MAX_PROCESSING_ERROR_LENGTH = 1200;

interface BodyWithWebStream {
  transformToWebStream: () => NodeReadableStream;
}

@Injectable()
export class VideoProcessingProcessorService {
  private readonly logger = new Logger(VideoProcessingProcessorService.name);
  private readonly s3Client = new S3Client({
    region: envs.R2_REGION,
    endpoint: `https://${envs.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: envs.R2_ACCESS_KEY_ID,
      secretAccessKey: envs.R2_SECRET_ACCESS_KEY,
    },
    forcePathStyle: true,
  });

  public constructor(private readonly prismaService: PrismaService) {}

  public async processVideo(payload: VideoProcessingJobPayload): Promise<void> {
    const workingDirectory = await mkdtemp(join(tmpdir(), 'video-processing-'));
    const sourcePath = join(workingDirectory, 'source.mp4');
    const previewPath = join(workingDirectory, 'preview.mp4');
    const thumbnailPath = join(workingDirectory, 'thumbnail.webp');
    const previewKey = `previews/${payload.videoId}.mp4`;
    const thumbnailKey = `thumbnails/${payload.videoId}.webp`;
    try {
      this.logger.log(
        `Starting processing for video=${payload.videoId}, key=${payload.fullVideoKey}`,
      );
      await this.downloadOriginalVideo(payload.fullVideoKey, sourcePath);
      await this.generatePreviewClip(sourcePath, previewPath);
      await this.generateThumbnail(sourcePath, thumbnailPath);
      await this.uploadPublicAsset(previewPath, previewKey, 'video/mp4');
      await this.uploadPublicAsset(thumbnailPath, thumbnailKey, 'image/webp');
      await this.prismaService.video.update({
        where: { id: payload.videoId },
        data: {
          previewKey,
          thumbnailKey,
          isProcessing: false,
        },
      });
      await this.prismaService.$executeRaw`
        UPDATE "Video"
        SET "processingError" = NULL,
            "processedAt" = NOW()
        WHERE "id" = ${payload.videoId}
      `;
      this.logger.log(`Finished processing for video=${payload.videoId}`);
    } catch (error: unknown) {
      const message = this.getErrorMessage(error);
      this.logger.error(
        `Processing failed for video=${payload.videoId}: ${message}`,
      );
      await this.prismaService.video.update({
        where: { id: payload.videoId },
        data: {
          isProcessing: false,
        },
      });
      const processingError = message.slice(0, MAX_PROCESSING_ERROR_LENGTH);
      await this.prismaService.$executeRaw`
        UPDATE "Video"
        SET "processingError" = ${processingError},
            "processedAt" = NULL
        WHERE "id" = ${payload.videoId}
      `;
      throw error;
    } finally {
      await rm(workingDirectory, { recursive: true, force: true });
    }
  }

  private async downloadOriginalVideo(
    objectKey: string,
    destinationPath: string,
  ): Promise<void> {
    const response = await this.s3Client.send(
      new GetObjectCommand({
        Bucket: envs.R2_PRIVATE_BUCKET,
        Key: objectKey,
      }),
    );
    const body = response.Body;
    if (!body) {
      throw new Error(`Original object body is empty for key=${objectKey}`);
    }
    const stream = this.getReadableBody(body);
    await pipeline(stream, createWriteStream(destinationPath));
  }

  private async generatePreviewClip(
    inputPath: string,
    outputPath: string,
  ): Promise<void> {
    await this.executeFfmpegCommand([
      '-y',
      '-i',
      inputPath,
      '-ss',
      '0',
      '-t',
      PREVIEW_DURATION_SECONDS.toString(),
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-c:a',
      'aac',
      '-movflags',
      '+faststart',
      outputPath,
    ]);
  }

  private async generateThumbnail(
    inputPath: string,
    outputPath: string,
  ): Promise<void> {
    await this.executeFfmpegCommand([
      '-y',
      '-ss',
      THUMBNAIL_CAPTURE_SECOND.toString(),
      '-i',
      inputPath,
      '-vframes',
      '1',
      '-c:v',
      'libwebp',
      '-quality',
      '80',
      outputPath,
    ]);
  }

  private async uploadPublicAsset(
    localFilePath: string,
    key: string,
    contentType: string,
  ): Promise<void> {
    await this.s3Client.send(
      new PutObjectCommand({
        Bucket: envs.R2_PUBLIC_BUCKET,
        Key: key,
        Body: createReadStream(localFilePath),
        ContentType: contentType,
      }),
    );
  }

  private async executeFfmpegCommand(args: readonly string[]): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const ffmpegProcess = spawn('ffmpeg', args, {
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let stderrOutput = '';
      ffmpegProcess.stderr.on('data', (chunk: Buffer) => {
        stderrOutput += chunk.toString('utf8');
      });
      ffmpegProcess.on('error', reject);
      ffmpegProcess.on('close', (code: number | null) => {
        if (code === 0) {
          resolve();
          return;
        }
        reject(
          new Error(
            `ffmpeg exited with code=${code}. ${stderrOutput.slice(-500)}`,
          ),
        );
      });
    });
  }

  private getReadableBody(body: unknown): Readable {
    if (body instanceof Readable) {
      return body;
    }
    if (this.hasWebStreamTransformer(body)) {
      const webStream = body.transformToWebStream();
      return Readable.fromWeb(webStream);
    }
    throw new Error('Unsupported stream type for S3 object body');
  }

  private hasWebStreamTransformer(value: unknown): value is BodyWithWebStream {
    return (
      typeof value === 'object' &&
      value !== null &&
      'transformToWebStream' in value &&
      typeof value.transformToWebStream === 'function'
    );
  }

  private getErrorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }
    return String(error);
  }
}
