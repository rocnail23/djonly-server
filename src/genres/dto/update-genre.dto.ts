import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class UpdateGenreDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(60)
  public readonly name?: string;
}
