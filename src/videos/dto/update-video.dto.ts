import {
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

export class UpdateVideoDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  public readonly title?: string;

  @IsOptional()
  @IsUUID()
  public readonly genreId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  public readonly artist?: string;
}
