import {
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

export class CreateVideoDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  public readonly title!: string;

  @IsUUID()
  public readonly genreId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  public readonly artist?: string;

  @IsString()
  @IsNotEmpty()
  public readonly fullVideoKey!: string;
}
