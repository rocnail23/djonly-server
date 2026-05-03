import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import { Role as UserRole } from 'src/generated/prisma/client';
import { Public } from 'src/auth/custom.decorator/public.decorator';
import { Roles } from 'src/auth/custom.decorator/roles.decorator';
import { CreateGenreDto } from './dto/create-genre.dto';
import { UpdateGenreDto } from './dto/update-genre.dto';
import { type ExistingGenre, GenresService } from './genres.service';
import { type RequestWithUser } from 'src/auth/types/request-with-user.type';

@Controller('genres')
export class GenresController {
  public constructor(private readonly genresService: GenresService) {}

  @Public()
  @Get()
  public async findAllGenres(
    @Req() request: RequestWithUser,
  ): Promise<readonly ExistingGenre[]> {
    console.log('findAllGenres');
    console.log(request.user);
    return this.genresService.findAllGenres();
  }

  @Roles(UserRole.ADMIN)
  @Get(':genreId')
  public async findGenreById(
    @Param('genreId') genreId: string,
  ): Promise<ExistingGenre> {
    return this.genresService.findGenreById(genreId);
  }

  @Roles(UserRole.ADMIN)
  @Post()
  public async createGenre(
    @Body() createGenreDto: CreateGenreDto,
  ): Promise<ExistingGenre> {
    return this.genresService.createGenre(createGenreDto);
  }

  @Roles(UserRole.ADMIN)
  @Patch(':genreId')
  public async updateGenre(
    @Param('genreId') genreId: string,
    @Body() updateGenreDto: UpdateGenreDto,
  ): Promise<ExistingGenre> {
    return this.genresService.updateGenre(genreId, updateGenreDto);
  }

  @Roles(UserRole.ADMIN)
  @Delete(':genreId')
  public async deleteGenre(
    @Param('genreId') genreId: string,
  ): Promise<ExistingGenre> {
    return this.genresService.deleteGenre(genreId);
  }
}
