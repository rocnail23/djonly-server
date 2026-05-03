import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { Roles } from 'src/auth/custom.decorator/roles.decorator';
import { Public } from 'src/auth/custom.decorator/public.decorator';
import { Role as UserRole } from 'src/generated/prisma/client';
import { type RequestWithUser } from 'src/auth/types/request-with-user.type';
import { CreateVideoDto } from './dto/create-video.dto';
import { FindDownloadHistoryQueryDto } from './dto/find-download-history-query.dto';
import { FindVideosQueryDto } from './dto/find-videos-query.dto';
import { UpdateVideoDto } from './dto/update-video.dto';
import {
  type PaginatedUserDownloadHistoryResponse,
  type ExistingVideo,
  type VideoDownloadUrlResponse,
  type PaginatedHomeVideosResponse,
  type PaginatedVideosResponse,
  VideosService,
} from './videos.service';

@Controller('videos')
export class VideosController {
  public constructor(private readonly videosService: VideosService) {}

  @Get()
  public async findAllVideos(
    @Query() query: FindVideosQueryDto,
  ): Promise<PaginatedVideosResponse> {
    return this.videosService.findAllVideos(query);
  }

  @Public()
  @Get('home')
  public async findHomeVideos(
    @Query() query: FindVideosQueryDto,
    @Req() request: RequestWithUser,
  ): Promise<PaginatedHomeVideosResponse> {
    return this.videosService.findHomeVideos(query, request.user?.userId);
  }

  @Roles(UserRole.ADMIN, UserRole.USER)
  @Get('me/download-history')
  public listCurrentUserDownloadHistory(
    @Query() query: FindDownloadHistoryQueryDto,
    @Req() request: RequestWithUser,
  ): Promise<PaginatedUserDownloadHistoryResponse> {
    const userId = request.user?.userId;
    if (!userId) {
      throw new UnauthorizedException('Debes iniciar sesión para continuar');
    }
    return this.videosService.listUserDownloadHistory({
      userId,
      query,
    });
  }

  @Get(':videoId')
  public async findVideoById(
    @Param('videoId') videoId: string,
  ): Promise<ExistingVideo> {
    return this.videosService.findVideoById(videoId);
  }

  @Roles(UserRole.ADMIN)
  @Post()
  public async createVideo(
    @Body() createVideoDto: CreateVideoDto,
  ): Promise<ExistingVideo> {
    return this.videosService.createVideo(createVideoDto);
  }

  @Roles(UserRole.ADMIN)
  @Patch(':videoId')
  public async updateVideo(
    @Param('videoId') videoId: string,
    @Body() updateVideoDto: UpdateVideoDto,
  ): Promise<ExistingVideo> {
    return this.videosService.updateVideo(videoId, updateVideoDto);
  }

  @Roles(UserRole.ADMIN)
  @Delete(':videoId')
  public async deleteVideo(@Param('videoId') videoId: string): Promise<void> {
    await this.videosService.deleteVideo(videoId);
  }

  @Roles(UserRole.ADMIN, UserRole.USER)
  @Post(':videoId/download-url')
  public async generateVideoDownloadUrl(
    @Param('videoId') videoId: string,
    @Req() request: RequestWithUser,
  ): Promise<VideoDownloadUrlResponse> {
    const userId = request.user?.userId;
    if (!userId) {
      throw new UnauthorizedException(
        'Debes iniciar sesión para descargar videos',
      );
    }
    return await this.videosService.generateVideoDownloadUrl(videoId, userId);
  }
}
