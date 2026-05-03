import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  ListMultipartUploadsCommand,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { envs } from '../config/envs';
import { type S3PartDto } from './dto/s3-part.dto';

const SIGNED_URL_EXPIRATION_SECONDS = 900;
const MAX_PART_NUMBER = 10000;
const DEFAULT_DOWNLOAD_EXTENSION = 'mp4';

interface UploadRequestInput {
  readonly filename: string;
  readonly contentType: string;
  readonly userId: string;
}

interface MultipartRequestInput extends UploadRequestInput {
  readonly metadata?: Record<string, string>;
}

interface SignPartInput {
  readonly uploadId: string;
  readonly key: string;
  readonly partNumber: number;
}

interface CompleteMultipartInput {
  readonly uploadId: string;
  readonly key: string;
  readonly parts: readonly S3PartDto[];
}

export interface ActiveMultipartUpload {
  readonly uploadId: string;
  readonly key: string;
  readonly initiatedAt: Date | null;
}

@Injectable()
export class UploadsService {
  private readonly logger = new Logger(UploadsService.name);
  private s3Client: S3Client | null = null;

  public constructor() {}

  public async signUploadParameters(input: UploadRequestInput): Promise<{
    readonly method: 'PUT';
    readonly url: string;
    readonly key: string;
  }> {
    this.validateUploadRequest(input);
    const key = this.generateObjectKey(input);
    this.logger.log(
      `Signing direct upload URL for user=${input.userId}, file=${input.filename}, key=${key}`,
    );
    const command = new PutObjectCommand({
      Bucket: this.getPrivateBucketName(),
      Key: key,
      ContentType: input.contentType,
    });
    const url = await getSignedUrl(this.getS3Client(), command, {
      expiresIn: SIGNED_URL_EXPIRATION_SECONDS,
    });
    return {
      method: 'PUT',
      url,
      key,
    };
  }

  public async createMultipartUpload(
    input: MultipartRequestInput,
  ): Promise<{ readonly uploadId: string; readonly key: string }> {
    this.validateUploadRequest(input);
    const key = this.generateObjectKey(input);
    this.logger.log(
      `Creating multipart upload for user=${input.userId}, file=${input.filename}, key=${key}`,
    );
    const command = new CreateMultipartUploadCommand({
      Bucket: this.getPrivateBucketName(),
      Key: key,
      ContentType: input.contentType,
      Metadata: input.metadata,
    });
    const response = await this.getS3Client().send(command);
    if (!response.UploadId || !response.Key) {
      this.logger.error(
        `Multipart init failed for key=${key}: missing UploadId/Key in provider response`,
      );
      throw new InternalServerErrorException(
        'No se pudo inicializar la carga multipart',
      );
    }
    return {
      uploadId: response.UploadId,
      key: response.Key,
    };
  }

  public async signMultipartPart(
    input: SignPartInput,
  ): Promise<{ readonly url: string; readonly expires: number }> {
    this.validatePartNumber(input.partNumber);
    this.logger.log(
      `Signing multipart part uploadId=${input.uploadId}, part=${input.partNumber}, key=${input.key}`,
    );
    const command = new UploadPartCommand({
      Bucket: this.getPrivateBucketName(),
      Key: input.key,
      UploadId: input.uploadId,
      PartNumber: input.partNumber,
      Body: '',
    });
    const url = await getSignedUrl(this.getS3Client(), command, {
      expiresIn: SIGNED_URL_EXPIRATION_SECONDS,
    });
    return {
      url,
      expires: SIGNED_URL_EXPIRATION_SECONDS,
    };
  }

  public async listMultipartParts(input: {
    readonly uploadId: string;
    readonly key: string;
  }): Promise<
    readonly {
      readonly PartNumber?: number;
      readonly ETag?: string;
      readonly Size?: number;
    }[]
  > {
    this.logger.log(
      `Listing multipart parts uploadId=${input.uploadId}, key=${input.key}`,
    );
    const command = new ListPartsCommand({
      Bucket: this.getPrivateBucketName(),
      Key: input.key,
      UploadId: input.uploadId,
    });
    const response = await this.getS3Client().send(command);
    return response.Parts ?? [];
  }

  public async completeMultipartUpload(
    input: CompleteMultipartInput,
  ): Promise<{ readonly location: string | null }> {
    this.logger.log(
      `Completing multipart uploadId=${input.uploadId}, key=${input.key}, parts=${input.parts.length}`,
    );
    const completedParts: { ETag: string; PartNumber: number }[] = input.parts
      .map((part: S3PartDto) => ({
        ETag: part.ETag,
        PartNumber: part.PartNumber,
      }))
      .sort((partA, partB) => partA.PartNumber - partB.PartNumber);
    const command = new CompleteMultipartUploadCommand({
      Bucket: this.getPrivateBucketName(),
      Key: input.key,
      UploadId: input.uploadId,
      MultipartUpload: {
        Parts: completedParts,
      },
    });
    await this.getS3Client().send(command);
    return { location: null };
  }

  public async abortMultipartUpload(input: {
    readonly uploadId: string;
    readonly key: string;
  }): Promise<void> {
    this.logger.log(
      `Aborting multipart uploadId=${input.uploadId}, key=${input.key}`,
    );
    const command = new AbortMultipartUploadCommand({
      Bucket: this.getPrivateBucketName(),
      Key: input.key,
      UploadId: input.uploadId,
    });
    await this.getS3Client().send(command);
  }

  public async deleteObject(key: string): Promise<void> {
    this.logger.log(`Deleting object key=${key}`);
    const command = new DeleteObjectCommand({
      Bucket: this.getPrivateBucketName(),
      Key: key,
    });
    await this.getS3Client().send(command);
  }

  public async signPrivateObjectUrl(
    key: string,
    expiresInSeconds = SIGNED_URL_EXPIRATION_SECONDS,
    filename?: string,
  ): Promise<string> {
    if (!key?.trim()) {
      throw new BadRequestException('El key del objeto es obligatorio');
    }
    const contentDisposition = this.buildAttachmentContentDisposition(
      key,
      filename,
    );
    this.logger.log(`Signing download URL for key=${key}`);
    const command = new GetObjectCommand({
      Bucket: this.getPrivateBucketName(),
      ResponseContentDisposition: contentDisposition,
      Key: key,
    });
    return getSignedUrl(this.getS3Client(), command, {
      expiresIn: expiresInSeconds,
    });
  }

  private buildAttachmentContentDisposition(
    key: string,
    filename?: string,
  ): string {
    const fallbackName =
      key.split('/').pop() ?? `video.${DEFAULT_DOWNLOAD_EXTENSION}`;
    const requestedName = filename?.trim() || fallbackName;
    const hasExtension = requestedName.includes('.');
    const normalizedName = hasExtension
      ? requestedName
      : `${requestedName}.${DEFAULT_DOWNLOAD_EXTENSION}`;
    const safeName = normalizedName
      .replace(/[^a-zA-Z0-9._ -]/g, '_')
      .replace(/[\r\n"]/g, '_')
      .trim();
    const resolvedName = safeName || `video.${DEFAULT_DOWNLOAD_EXTENSION}`;
    return `attachment; filename="${resolvedName}"`;
  }

  public async listActiveMultipartUploads(): Promise<ActiveMultipartUpload[]> {
    const command = new ListMultipartUploadsCommand({
      Bucket: this.getPrivateBucketName(),
    });
    const response = await this.getS3Client().send(command);
    const uploads = response.Uploads ?? [];
    return uploads
      .filter((upload) => upload.UploadId && upload.Key)
      .map((upload) => ({
        uploadId: upload.UploadId as string,
        key: upload.Key as string,
        initiatedAt: upload.Initiated ? new Date(upload.Initiated) : null,
      }));
  }

  private getS3Client(): S3Client {
    if (!this.s3Client) {
      this.s3Client = this.createS3Client();
    }
    return this.s3Client;
  }

  private createS3Client(): S3Client {
    const accountId = envs.R2_ACCOUNT_ID;
    const accessKeyId = envs.R2_ACCESS_KEY_ID;
    const secretAccessKey = envs.R2_SECRET_ACCESS_KEY;
    if (!accountId || !accessKeyId || !secretAccessKey) {
      this.logger.error(
        'Upload service is misconfigured: missing R2_ACCOUNT_ID, R2_ACCESS_KEY_ID or R2_SECRET_ACCESS_KEY',
      );
      throw new Error(
        'Upload service is misconfigured: missing R2_ACCOUNT_ID, R2_ACCESS_KEY_ID or R2_SECRET_ACCESS_KEY',
      );
    }
    this.logger.log(
      `Initializing S3 client for bucket=${envs.R2_PRIVATE_BUCKET}, account=${accountId}, region=${envs.R2_REGION}`,
    );
    return new S3Client({
      region: envs.R2_REGION,
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId,
        secretAccessKey,
      },
      forcePathStyle: true,
    });
  }

  private getPrivateBucketName(): string {
    if (!envs.R2_PRIVATE_BUCKET) {
      this.logger.error(
        'Upload service is misconfigured: missing R2_PRIVATE_BUCKET',
      );
      throw new Error(
        'Upload service is misconfigured: missing R2_PRIVATE_BUCKET',
      );
    }
    return envs.R2_PRIVATE_BUCKET;
  }

  private validateUploadRequest(input: UploadRequestInput): void {
    if (!input.filename.trim() || !input.contentType.trim()) {
      this.logger.warn('Rejected upload request due to missing filename/type');
      throw new BadRequestException('filename y type son obligatorios');
    }
    const isVideoContent = input.contentType.startsWith('video/');
    if (!isVideoContent) {
      this.logger.warn(
        `Rejected upload request: invalid content-type ${input.contentType}`,
      );
      throw new BadRequestException('Solo se permiten archivos de video');
    }
  }

  private validatePartNumber(partNumber: number): void {
    const isValidPartNumber =
      Number.isInteger(partNumber) &&
      partNumber >= 1 &&
      partNumber <= MAX_PART_NUMBER;
    if (!isValidPartNumber) {
      this.logger.warn(`Rejected partNumber=${partNumber}`);
      throw new BadRequestException(
        'El partNumber debe ser un entero entre 1 y 10000',
      );
    }
  }

  private generateObjectKey(input: UploadRequestInput): string {
    const safeName = input.filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    return `videos/${input.userId}/${randomUUID()}-${safeName}`;
  }
}
