import { Controller, Post } from '@nestjs/common';

import { Public } from 'src/auth/custom.decorator/public.decorator';

import { SeedsService } from './seeds.service';

@Controller('admin/seeds')
export class SeedsController {
  constructor(private readonly seedsService: SeedsService) {}
  @Public()
  @Post('genres')
  async seedGenres() {
    return this.seedsService.seedGenres();
  }

  @Public()
  @Post('users')
  async seedUsers() {
    return this.seedsService.seedUsers();
  }
}
