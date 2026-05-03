import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export class FindDownloadHistoryQueryDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  public readonly page: number = 1;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  public readonly limit: number = 10;

  @IsOptional()
  @IsString()
  public readonly search?: string;
}
