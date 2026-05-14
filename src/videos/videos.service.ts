import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  InternalServerErrorException,
  HttpException,
  Logger,
} from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { type Cache } from 'cache-manager';
import { Prisma } from 'src/generated/prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { UploadsService } from 'src/uploads/uploads.service';
import { VideoProcessingService } from 'src/video-processing/video-processing.service';
import { CreateVideoDto } from './dto/create-video.dto';
import { FindVideosQueryDto } from './dto/find-videos-query.dto';
import { UpdateVideoDto } from './dto/update-video.dto';

type VideoRecord = Awaited<ReturnType<PrismaService['video']['findUnique']>>;
type GenreRecord = Awaited<ReturnType<PrismaService['genre']['findUnique']>>;
export type ExistingVideo = NonNullable<VideoRecord>;
type ExistingGenre = NonNullable<GenreRecord>;
export type VideoListItem = ExistingVideo & {
  readonly genre: Pick<ExistingGenre, 'id' | 'name'> | null;
};
export interface PaginatedVideosResponse {
  readonly items: readonly VideoListItem[];
  readonly page: number;
  readonly limit: number;
  readonly total: number;
  readonly totalPages: number;
}

const MAX_DOWNLOADS_PER_MONTH = 2;
const DOWNLOAD_URL_CACHE_PREFIX = 'video-download-url';
const DOWNLOAD_URL_TTL_SECONDS = 3600;
const FALLBACK_UNKNOWN_USER_ID = '__unknown_user__';
const FUTURE_REFERENCE_DATE = new Date('9999-12-31T00:00:00.000Z');

export interface HomeVideoListItem extends VideoListItem {
  readonly userDownloadCount: number;
  readonly remainingDownloads: number | null;
}

export interface PaginatedHomeVideosResponse {
  readonly items: readonly HomeVideoListItem[];
  readonly page: number;
  readonly limit: number;
  readonly total: number;
  readonly totalPages: number;
}

interface CachedVideoDownloadUrl {
  readonly url: string;
  readonly expiresAt: string;
}

interface ActiveSubscriptionWindow {
  readonly periodStart: Date;
  readonly periodEnd: Date;
  readonly monthStart: Date;
  readonly monthEnd: Date;
}

interface ListUserDownloadHistoryInput {
  readonly userId: string;
  readonly query: {
    readonly page: number;
    readonly limit: number;
    readonly search?: string;
  };
}

interface DownloadHistoryMonthBoundary {
  readonly monthStart: Date;
  readonly monthEnd: Date;
}

interface DownloadHistoryRow {
  readonly id: string;
  readonly videoId: string;
  readonly downloadedAt: Date;
  readonly video: {
    readonly title: string;
  };
}

export interface UserDownloadHistoryItem {
  readonly id: string;
  readonly videoId: string;
  readonly videoTitle: string;
  readonly downloadedAt: Date;
  readonly downloadCountInMonth: number;
  readonly downloadLimit: number;
  readonly status: 'AVAILABLE' | 'LIMIT_REACHED';
}

export interface PaginatedUserDownloadHistoryResponse {
  readonly items: readonly UserDownloadHistoryItem[];
  readonly page: number;
  readonly limit: number;
  readonly total: number;
  readonly totalPages: number;
}

export interface VideoDownloadUrlResponse {
  readonly url: string;
  readonly expiresAt: string;
  readonly remainingDownloads: number;
}

@Injectable()
export class VideosService {
  private readonly logger = new Logger(VideosService.name);

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly uploadsService: UploadsService,
    private readonly videoProcessingService: VideoProcessingService,
    @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
  ) {}

  public async findAllVideos(
    query: FindVideosQueryDto,
  ): Promise<PaginatedVideosResponse> {
    const skip = (query.page - 1) * query.limit;
    const trimmedTitle = query.title?.trim();
    const whereClause = {
      title: trimmedTitle
        ? {
            contains: trimmedTitle,
            mode: 'insensitive' as const,
          }
        : undefined,
      genreId: query.genreId,
    };
    return this.executeDatabaseOperation(async () => {
      const [items, total] = await this.prismaService.$transaction([
        this.prismaService.video.findMany({
          where: whereClause,
          orderBy: { createdAt: 'desc' },
          skip,
          take: query.limit,
          include: {
            genre: {
              select: {
                id: true,
                name: true,
              },
            },
          },
        }),
        this.prismaService.video.count({ where: whereClause }),
      ]);
      const totalPages = Math.max(1, Math.ceil(total / query.limit));
      return {
        items,
        page: query.page,
        limit: query.limit,
        total,
        totalPages,
      };
    }, 'No se pudieron obtener los videos');
  }

  public async findHomeVideos(
    query: FindVideosQueryDto,
    userId?: string,
  ): Promise<PaginatedHomeVideosResponse> {
    const skip = (query.page - 1) * query.limit;
    const trimmedTitle = query.title?.trim();
    const whereClause = {
      title: trimmedTitle
        ? {
            contains: trimmedTitle,
            mode: 'insensitive' as const,
          }
        : undefined,
      genreId: query.genreId,
    };
    const now = new Date();
    const activeSubscriptionWindow = userId
      ? await this.findActiveSubscriptionWindow(userId, now)
      : null;
    return this.executeDatabaseOperation(async () => {
      const [items, total] = await this.prismaService.$transaction([
        this.prismaService.video.findMany({
          where: whereClause,
          orderBy: { createdAt: 'desc' },
          skip,
          take: query.limit,
          include: {
            genre: {
              select: {
                id: true,
                name: true,
              },
            },
            downloadHistory: {
              where: {
                userId: userId ?? FALLBACK_UNKNOWN_USER_ID,
                downloadedAt: {
                  gte:
                    activeSubscriptionWindow?.monthStart ??
                    FUTURE_REFERENCE_DATE,
                  lt:
                    activeSubscriptionWindow?.monthEnd ?? FUTURE_REFERENCE_DATE,
                },
              },
              select: {
                id: true,
              },
            },
          },
        }),
        this.prismaService.video.count({ where: whereClause }),
      ]);
      const mappedItems: HomeVideoListItem[] = items.map((item) => {
        const userDownloadCount = item.downloadHistory.length;
        const remainingDownloads = activeSubscriptionWindow
          ? Math.max(0, MAX_DOWNLOADS_PER_MONTH - userDownloadCount)
          : null;
        return {
          id: item.id,
          title: item.title,
          artist: item.artist,
          bpm: item.bpm,
          genreId: item.genreId,
          genre: item.genre,
          fullVideoKey: item.fullVideoKey,
          previewKey: item.previewKey,
          thumbnailKey: item.thumbnailKey,
          isProcessing: item.isProcessing,
          processingError: item.processingError,
          processedAt: item.processedAt,
          createdAt: item.createdAt,
          updatedAt: item.updatedAt,
          userDownloadCount,
          remainingDownloads,
        };
      });
      const totalPages = Math.max(1, Math.ceil(total / query.limit));
      return {
        items: mappedItems,
        page: query.page,
        limit: query.limit,
        total,
        totalPages,
      };
    }, 'No se pudieron obtener los videos para el home');
  }

  public async listUserDownloadHistory(
    input: ListUserDownloadHistoryInput,
  ): Promise<PaginatedUserDownloadHistoryResponse> {
    const safePage = input.query.page >= 1 ? input.query.page : 1;
    const safeLimit = input.query.limit >= 1 ? input.query.limit : 10;
    const skip = (safePage - 1) * safeLimit;
    const trimmedSearch = input.query.search?.trim();
    const whereClause: Prisma.DownloadHistoryWhereInput = {
      userId: input.userId,
      video: trimmedSearch
        ? {
            title: {
              contains: trimmedSearch,
              mode: 'insensitive',
            },
          }
        : undefined,
    };
    const [downloadRows, total]: [DownloadHistoryRow[], number] =
      await this.executeDatabaseOperation(
        () =>
          this.prismaService.$transaction([
            this.prismaService.downloadHistory.findMany({
              where: whereClause,
              orderBy: {
                downloadedAt: 'desc',
              },
              skip,
              take: safeLimit,
              select: {
                id: true,
                videoId: true,
                downloadedAt: true,
                video: {
                  select: {
                    title: true,
                  },
                },
              },
            }),
            this.prismaService.downloadHistory.count({
              where: whereClause,
            }),
          ]),
        'No se pudo obtener el historial de descargas',
      );
    const monthlyCountMap = await this.buildMonthlyDownloadCountMap({
      userId: input.userId,
      rows: downloadRows,
    });
    const items: readonly UserDownloadHistoryItem[] = downloadRows.map(
      (row) => {
        const monthBoundary = this.findDownloadHistoryMonthBoundary(
          row.downloadedAt,
        );
        const countKey = this.buildMonthlyCountKey({
          userId: input.userId,
          videoId: row.videoId,
          monthStart: monthBoundary.monthStart,
        });
        const downloadCountInMonth = monthlyCountMap.get(countKey) ?? 0;
        return {
          id: row.id,
          videoId: row.videoId,
          videoTitle: row.video.title,
          downloadedAt: row.downloadedAt,
          downloadCountInMonth,
          downloadLimit: MAX_DOWNLOADS_PER_MONTH,
          status:
            downloadCountInMonth >= MAX_DOWNLOADS_PER_MONTH
              ? 'LIMIT_REACHED'
              : 'AVAILABLE',
        };
      },
    );
    return {
      items,
      page: safePage,
      limit: safeLimit,
      total,
      totalPages: Math.max(1, Math.ceil(total / safeLimit)),
    };
  }

  public async findVideoById(videoId: string): Promise<ExistingVideo> {
    const video = await this.executeDatabaseOperation(
      () => this.prismaService.video.findUnique({ where: { id: videoId } }),
      'No se pudo consultar el video',
    );
    if (!video) {
      throw new NotFoundException('Video not found');
    }
    return video;
  }

  public async createVideo(
    createVideoDto: CreateVideoDto,
  ): Promise<ExistingVideo> {
    await this.assertGenreExists(createVideoDto.genreId);
    await this.assertVideoTitleIsUnique(createVideoDto.title);
    const createdVideo = await this.executeDatabaseOperation(
      () =>
        this.prismaService.video.create({
          data: {
            title: createVideoDto.title,
            genreId: createVideoDto.genreId,
            artist: createVideoDto.artist,
            fullVideoKey: createVideoDto.fullVideoKey,
            isProcessing: true,
          },
        }),
      'No se pudo crear el video',
    );
    try {
      await this.videoProcessingService.enqueueVideoProcessing({
        videoId: createdVideo.id,
        fullVideoKey: createdVideo.fullVideoKey,
      });
      return createdVideo;
    } catch (error: unknown) {
      this.logger.error('No se pudo encolar el procesamiento del video', error);
      await this.prismaService.video.update({
        where: { id: createdVideo.id },
        data: {
          isProcessing: false,
        },
      });
      await this.prismaService.$executeRaw`
        UPDATE "Video"
        SET "processingError" = 'No se pudo encolar el procesamiento del video',
            "processedAt" = NULL
        WHERE "id" = ${createdVideo.id}
      `;
      throw new InternalServerErrorException(
        'No se pudo iniciar el procesamiento del video',
      );
    }
  }

  public async reprocessAllVideos(): Promise<{ readonly queued: number }> {
    const videos = await this.executeDatabaseOperation(
      () =>
        this.prismaService.video.findMany({
          where: { fullVideoKey: { not: '' } },
          select: { id: true, fullVideoKey: true },
        }),
      'No se pudieron obtener los videos para reprocesar',
    );

    let queued = 0;
    for (const video of videos) {
      await this.executeDatabaseOperation(
        () =>
          this.prismaService.video.update({
            where: { id: video.id },
            data: {
              isProcessing: true,
              previewKey: null,
              thumbnailKey: null,
              processingError: null,
              processedAt: null,
            },
          }),
        'No se pudo resetear el estado del video',
      );
      try {
        await this.videoProcessingService.enqueueVideoProcessing({
          videoId: video.id,
          fullVideoKey: video.fullVideoKey,
        });
        queued++;
      } catch (error: unknown) {
        this.logger.error(
          `No se pudo encolar el video id=${video.id} para reprocesamiento`,
          error,
        );
      }
    }

    this.logger.log(
      `Reprocess all: queued=${queued} of total=${videos.length}`,
    );
    return { queued };
  }

  public async deleteVideo(videoId: string): Promise<void> {
    const existingVideo = await this.findVideoById(videoId);
    await this.deleteVideoAssets(existingVideo);
    await this.executeDatabaseOperation(
      () => this.prismaService.video.delete({ where: { id: videoId } }),
      'No se pudo eliminar el video',
    );
  }

  public async updateVideo(
    videoId: string,
    updateVideoDto: UpdateVideoDto,
  ): Promise<ExistingVideo> {
    const existingVideo = await this.findVideoById(videoId);
    if (
      updateVideoDto.genreId &&
      updateVideoDto.genreId !== existingVideo.genreId
    ) {
      await this.assertGenreExists(updateVideoDto.genreId);
    }
    if (updateVideoDto.title && updateVideoDto.title !== existingVideo.title) {
      await this.assertVideoTitleIsUnique(updateVideoDto.title, videoId);
    }
    return this.executeDatabaseOperation(
      () =>
        this.prismaService.video.update({
          where: { id: videoId },
          data: {
            title: updateVideoDto.title ?? existingVideo.title,
            genreId: updateVideoDto.genreId ?? existingVideo.genreId,
            artist: updateVideoDto.artist ?? existingVideo.artist,
          },
          include: {
            genre: {
              select: {
                id: true,
                name: true,
              },
            },
          },
        }),
      'No se pudo actualizar el video',
    );
  }

  public async generateVideoDownloadUrl(
    videoId: string,
    userId: string,
  ): Promise<VideoDownloadUrlResponse> {
    const now = new Date();
    const video = await this.findVideoById(videoId);
    const activeSubscriptionWindow = await this.findActiveSubscriptionWindow(
      userId,
      now,
    );
    if (!activeSubscriptionWindow) {
      throw new ForbiddenException(
        'Necesitas una suscripción activa para descargar videos',
      );
    }
    const downloadUrlData = await this.findCachedDownloadUrl(
      userId,
      videoId,
      now,
    );
    if (downloadUrlData) {
      const currentDownloadCount = await this.executeDatabaseOperation(
        () =>
          this.prismaService.downloadHistory.count({
            where: {
              userId,
              videoId,
              downloadedAt: {
                gte: activeSubscriptionWindow.monthStart,
                lt: activeSubscriptionWindow.monthEnd,
              },
            },
          }),
        'No se pudo validar el límite de descargas del usuario',
      );
      return {
        url: downloadUrlData.url,
        expiresAt: downloadUrlData.expiresAt,
        remainingDownloads: Math.max(
          0,
          MAX_DOWNLOADS_PER_MONTH - currentDownloadCount,
        ),
      };
    }
    const updatedDownloadCount = await this.executeDatabaseOperation(
      async () => {
        const transactionResult = await this.prismaService.$transaction(
          async (transactionClient) => {
            const latestDownloadCount =
              await transactionClient.downloadHistory.count({
                where: {
                  userId,
                  videoId,
                  downloadedAt: {
                    gte: activeSubscriptionWindow.monthStart,
                    lt: activeSubscriptionWindow.monthEnd,
                  },
                },
              });
            if (latestDownloadCount >= MAX_DOWNLOADS_PER_MONTH) {
              throw new ForbiddenException(
                'Ya alcanzaste el límite de descargas para este video en tu periodo actual',
              );
            }
            await transactionClient.downloadHistory.create({
              data: {
                userId,
                videoId,
              },
            });
            return latestDownloadCount + 1;
          },
        );
        return transactionResult;
      },
      'No se pudo registrar el historial de descargas del usuario',
    );
    const generatedDownloadUrlData = await this.generateAndCacheDownloadUrl({
      key: video.fullVideoKey,
      userId,
      videoId,
      now,
      filename: video.title,
    });
    return {
      url: generatedDownloadUrlData.url,
      expiresAt: generatedDownloadUrlData.expiresAt,
      remainingDownloads: Math.max(
        0,
        MAX_DOWNLOADS_PER_MONTH - updatedDownloadCount,
      ),
    };
  }

  private async findCachedDownloadUrl(
    userId: string,
    videoId: string,
    now: Date,
  ): Promise<CachedVideoDownloadUrl | null> {
    const cacheKey = this.buildDownloadUrlCacheKey(userId, videoId);
    const cachedDownloadData =
      await this.cacheManager.get<CachedVideoDownloadUrl>(cacheKey);
    if (!cachedDownloadData?.url || !cachedDownloadData.expiresAt) {
      return null;
    }
    if (new Date(cachedDownloadData.expiresAt).getTime() <= now.getTime()) {
      return null;
    }
    return cachedDownloadData;
  }

  private async generateAndCacheDownloadUrl(input: {
    readonly key: string;
    readonly userId: string;
    readonly videoId: string;
    readonly now: Date;
    readonly filename?: string;
  }): Promise<CachedVideoDownloadUrl> {
    const url = await this.uploadsService.signPrivateObjectUrl(
      input.key,
      DOWNLOAD_URL_TTL_SECONDS,
      input.filename,
    );
    const expiresAt = new Date(
      input.now.getTime() + DOWNLOAD_URL_TTL_SECONDS * 1000,
    ).toISOString();
    const cacheKey = this.buildDownloadUrlCacheKey(input.userId, input.videoId);
    await this.cacheManager.set(cacheKey, {
      url,
      expiresAt,
    });
    return {
      url,
      expiresAt,
    };
  }

  private buildDownloadUrlCacheKey(userId: string, videoId: string): string {
    return `${DOWNLOAD_URL_CACHE_PREFIX}:${userId}:${videoId}`;
  }

  private findDownloadHistoryMonthBoundary(
    downloadedAt: Date,
  ): DownloadHistoryMonthBoundary {
    const monthStart = new Date(downloadedAt);
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);
    const monthEnd = new Date(monthStart);
    monthEnd.setMonth(monthEnd.getMonth() + 1);
    return {
      monthStart,
      monthEnd,
    };
  }

  private buildMonthlyCountKey(input: {
    readonly userId: string;
    readonly videoId: string;
    readonly monthStart: Date;
  }): string {
    return `${input.userId}:${input.videoId}:${input.monthStart.toISOString()}`;
  }

  private async buildMonthlyDownloadCountMap(input: {
    readonly userId: string;
    readonly rows: readonly {
      readonly videoId: string;
      readonly downloadedAt: Date;
    }[];
  }): Promise<Map<string, number>> {
    const uniquePeriodsMap = new Map<
      string,
      {
        readonly videoId: string;
        readonly monthStart: Date;
        readonly monthEnd: Date;
      }
    >();
    for (const row of input.rows) {
      const monthBoundary = this.findDownloadHistoryMonthBoundary(
        row.downloadedAt,
      );
      const uniqueKey = this.buildMonthlyCountKey({
        userId: input.userId,
        videoId: row.videoId,
        monthStart: monthBoundary.monthStart,
      });
      if (!uniquePeriodsMap.has(uniqueKey)) {
        uniquePeriodsMap.set(uniqueKey, {
          videoId: row.videoId,
          monthStart: monthBoundary.monthStart,
          monthEnd: monthBoundary.monthEnd,
        });
      }
    }
    const countEntries = await Promise.all(
      Array.from(uniquePeriodsMap.entries()).map(async ([key, period]) => {
        const count = await this.executeDatabaseOperation(
          () =>
            this.prismaService.downloadHistory.count({
              where: {
                userId: input.userId,
                videoId: period.videoId,
                downloadedAt: {
                  gte: period.monthStart,
                  lt: period.monthEnd,
                },
              },
            }),
          'No se pudo calcular el conteo mensual de descargas',
        );
        return {
          key,
          count,
        };
      }),
    );
    return new Map(countEntries.map((entry) => [entry.key, entry.count]));
  }

  private async assertGenreExists(genreId: string): Promise<void> {
    const genre = await this.executeDatabaseOperation(
      () => this.prismaService.genre.findUnique({ where: { id: genreId } }),
      'No se pudo validar el género del video',
    );
    if (!genre) {
      throw new NotFoundException('Genre not found');
    }
  }

  private async executeDatabaseOperation<T>(
    operation: () => Promise<T>,
    safeMessage: string,
  ): Promise<T> {
    try {
      return await operation();
    } catch (error: unknown) {
      if (error instanceof HttpException) {
        throw error;
      }
      this.logger.error(safeMessage, error);
      throw new InternalServerErrorException(
        'Ocurrió un error interno al procesar la solicitud',
      );
    }
  }

  private async assertVideoTitleIsUnique(
    title: string,
    excludeVideoId?: string,
  ): Promise<void> {
    const duplicatedVideo = await this.executeDatabaseOperation(
      () =>
        this.prismaService.video.findFirst({
          where: {
            title: {
              equals: title,
              mode: 'insensitive',
            },
            NOT: excludeVideoId
              ? {
                  id: excludeVideoId,
                }
              : undefined,
          },
        }),
      'No se pudo validar el título del video',
    );
    if (duplicatedVideo) {
      throw new ConflictException('Ya existe un video con ese nombre');
    }
  }

  private async deleteVideoAssets(video: ExistingVideo): Promise<void> {
    const keys = Array.from(
      new Set([video.fullVideoKey, video.previewKey, video.thumbnailKey]),
    ).filter((key): key is string => typeof key === 'string' && key.length > 0);
    for (const key of keys) {
      try {
        await this.uploadsService.deleteObject(key);
      } catch (error: unknown) {
        this.logger.warn(
          `No se pudo eliminar el objeto key=${key} en R2. Se continuará con la eliminación del registro`,
        );
        this.logger.error(error);
      }
    }
  }

  private async findActiveSubscriptionWindow(
    userId: string,
    now: Date,
  ): Promise<ActiveSubscriptionWindow | null> {
    const activeSubscription = await this.executeDatabaseOperation(
      () =>
        this.prismaService.subscription.findFirst({
          where: {
            userId,
            status: 'ACTIVE',
            currentPeriodStart: {
              lte: now,
            },
            currentPeriodEnd: {
              gt: now,
            },
          },
          orderBy: {
            currentPeriodStart: 'desc',
          },
          select: {
            currentPeriodStart: true,
            currentPeriodEnd: true,
          },
        }),
      'No se pudo consultar la suscripción activa del usuario',
    );
    if (!activeSubscription) {
      return null;
    }
    const monthWindow = this.resolveCurrentMonthWindow({
      periodStart: activeSubscription.currentPeriodStart,
      periodEnd: activeSubscription.currentPeriodEnd,
      now,
    });
    if (!monthWindow) {
      return null;
    }
    return {
      periodStart: activeSubscription.currentPeriodStart,
      periodEnd: activeSubscription.currentPeriodEnd,
      monthStart: monthWindow.monthStart,
      monthEnd: monthWindow.monthEnd,
    };
  }

  private resolveCurrentMonthWindow(input: {
    readonly periodStart: Date;
    readonly periodEnd: Date;
    readonly now: Date;
  }): { readonly monthStart: Date; readonly monthEnd: Date } | null {
    let monthStart = new Date(input.periodStart);
    while (monthStart.getTime() < input.periodEnd.getTime()) {
      const nextMonthStart = this.addMonthsToDate(monthStart, 1);
      const monthEnd =
        nextMonthStart.getTime() < input.periodEnd.getTime()
          ? nextMonthStart
          : input.periodEnd;
      const isNowInsideMonth =
        input.now.getTime() >= monthStart.getTime() &&
        input.now.getTime() < monthEnd.getTime();
      if (isNowInsideMonth) {
        return {
          monthStart,
          monthEnd,
        };
      }
      monthStart = monthEnd;
    }
    return null;
  }

  private addMonthsToDate(date: Date, months: number): Date {
    const result = new Date(date);
    result.setMonth(result.getMonth() + months);
    return result;
  }
}
