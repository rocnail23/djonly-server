import { IsNotEmpty, IsObject, IsOptional, IsString } from 'class-validator';

export class CreateMultipartUploadDto {
  @IsString()
  @IsNotEmpty()
  public readonly filename!: string;

  @IsString()
  @IsNotEmpty()
  public readonly type!: string;

  @IsOptional()
  @IsObject()
  public readonly metadata?: Record<string, string>;
}
