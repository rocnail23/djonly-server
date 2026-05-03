import {
  ConflictException,
  HttpException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { CreateGenreDto } from './dto/create-genre.dto';
import { UpdateGenreDto } from './dto/update-genre.dto';

type GenreRecord = Awaited<ReturnType<PrismaService['genre']['findUnique']>>;
export type ExistingGenre = NonNullable<GenreRecord>;

@Injectable()
export class GenresService {
  private readonly logger = new Logger(GenresService.name);

  public constructor(private readonly prismaService: PrismaService) {}

  public async findAllGenres(): Promise<readonly ExistingGenre[]> {
    return this.executeDatabaseOperation(
      () =>
        this.prismaService.genre.findMany({
          orderBy: { name: 'asc' },
        }),
      'No se pudieron obtener los géneros',
    );
  }

  public async findGenreById(genreId: string): Promise<ExistingGenre> {
    return this.findGenreByIdOrThrow(genreId);
  }

  public async createGenre(
    createGenreDto: CreateGenreDto,
  ): Promise<ExistingGenre> {
    await this.validateGenreNameUniqueness(createGenreDto.name);
    return this.executeDatabaseOperation(
      () =>
        this.prismaService.genre.create({
          data: {
            name: createGenreDto.name,
          },
        }),
      'No se pudo crear el género',
    );
  }

  public async updateGenre(
    genreId: string,
    updateGenreDto: UpdateGenreDto,
  ): Promise<ExistingGenre> {
    const currentGenre = await this.findGenreByIdOrThrow(genreId);
    const nextName = updateGenreDto.name;
    if (!nextName || nextName === currentGenre.name) {
      return currentGenre;
    }
    await this.validateGenreNameUniqueness(nextName);
    return this.executeDatabaseOperation(
      () =>
        this.prismaService.genre.update({
          where: { id: genreId },
          data: { name: nextName },
        }),
      'No se pudo actualizar el género',
    );
  }

  public async deleteGenre(genreId: string): Promise<ExistingGenre> {
    await this.findGenreByIdOrThrow(genreId);
    return this.executeDatabaseOperation(
      () =>
        this.prismaService.genre.delete({
          where: { id: genreId },
        }),
      'No se pudo eliminar el género',
    );
  }

  private async findGenreByIdOrThrow(genreId: string): Promise<ExistingGenre> {
    const genre = await this.executeDatabaseOperation(
      () =>
        this.prismaService.genre.findUnique({
          where: { id: genreId },
        }),
      'No se pudo consultar el género',
    );
    if (!genre) {
      throw new NotFoundException('Genre not found');
    }
    return genre;
  }

  private async validateGenreNameUniqueness(genreName: string): Promise<void> {
    const existingGenre = await this.executeDatabaseOperation(
      () =>
        this.prismaService.genre.findUnique({
          where: { name: genreName },
        }),
      'No se pudo validar el género',
    );
    if (existingGenre) {
      throw new ConflictException('Genre name already exists');
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
}
