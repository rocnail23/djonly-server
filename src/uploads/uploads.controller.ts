import {
  Body,
  Controller,
  Delete,
  Get,
  Logger,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { Roles } from 'src/auth/custom.decorator/roles.decorator';
import { Role as UserRole } from 'src/generated/prisma/client';
import { type RequestWithUser } from '../auth/types/request-with-user.type';
import { CompleteMultipartUploadDto } from './dto/complete-multipart-upload.dto';
import { CreateMultipartUploadDto } from './dto/create-multipart-upload.dto';
import { KeyQueryDto } from './dto/key-query.dto';
import { SignUploadParamsDto } from './dto/sign-upload-params.dto';
import { UploadsService } from './uploads.service';

@Controller('uploads/s3')
export class UploadsController {
  private readonly logger = new Logger(UploadsController.name);

  public constructor(private readonly uploadsService: UploadsService) {}

  @Roles(UserRole.ADMIN)
  @Post('params')
  public async signUploadParams(
    @Body() body: SignUploadParamsDto,
    @Req() request: RequestWithUser,
  ): Promise<{
    readonly method: 'PUT';
    readonly url: string;
    readonly key: string;
  }> {
    const userId = this.getUserIdOrThrow(request);
    return this.uploadsService.signUploadParameters({
      filename: body.filename,
      contentType: body.type,
      userId,
    });
  }

  @Roles(UserRole.ADMIN)
  @Post('multipart')
  public async createMultipartUpload(
    @Body() body: CreateMultipartUploadDto,
    @Req() request: RequestWithUser,
  ): Promise<{ readonly uploadId: string; readonly key: string }> {
    const userId = this.getUserIdOrThrow(request);
    return this.uploadsService.createMultipartUpload({
      filename: body.filename,
      contentType: body.type,
      metadata: body.metadata,
      userId,
    });
  }

  @Roles(UserRole.ADMIN)
  @Get('multipart/:uploadId/:partNumber')
  public async signPart(
    @Param('uploadId') uploadId: string,
    @Param('partNumber', ParseIntPipe) partNumber: number,
    @Query() query: KeyQueryDto,
  ): Promise<{ readonly url: string; readonly expires: number }> {
    return this.uploadsService.signMultipartPart({
      uploadId,
      key: query.key,
      partNumber,
    });
  }

  @Roles(UserRole.ADMIN)
  @Get('multipart/:uploadId')
  public async listParts(
    @Param('uploadId') uploadId: string,
    @Query() query: KeyQueryDto,
  ): Promise<
    readonly {
      readonly PartNumber?: number;
      readonly ETag?: string;
      readonly Size?: number;
    }[]
  > {
    return this.uploadsService.listMultipartParts({
      uploadId,
      key: query.key,
    });
  }

  @Roles(UserRole.ADMIN)
  @Post('multipart/:uploadId/complete')
  public async completeMultipartUpload(
    @Param('uploadId') uploadId: string,
    @Query() query: KeyQueryDto,
    @Body() body: CompleteMultipartUploadDto,
  ): Promise<{ readonly location: string | null }> {
    return this.uploadsService.completeMultipartUpload({
      uploadId,
      key: query.key,
      parts: body.parts,
    });
  }

  @Roles(UserRole.ADMIN)
  @Delete('multipart/:uploadId')
  public async abortMultipartUpload(
    @Param('uploadId') uploadId: string,
    @Query() query: KeyQueryDto,
  ): Promise<Record<string, never>> {
    await this.uploadsService.abortMultipartUpload({
      uploadId,
      key: query.key,
    });
    return {};
  }

  @Roles(UserRole.ADMIN)
  @Delete('object')
  public async deleteObject(
    @Query() query: KeyQueryDto,
  ): Promise<Record<string, never>> {
    await this.uploadsService.deleteObject(query.key);
    return {};
  }

  private getUserIdOrThrow(request: RequestWithUser): string {
    const userId = request.user?.userId;
    if (!userId) {
      this.logger.warn('Blocked upload request without authenticated user');
      throw new UnauthorizedException('Debes iniciar sesión para subir videos');
    }
    return userId;
  }
}
