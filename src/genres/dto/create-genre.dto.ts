import { IsString, MaxLength, MinLength } from 'class-validator';

export class CreateGenreDto {
  @IsString()
  @MinLength(2)
  @MaxLength(60)
  public readonly name!: string;
}
