import { Type } from 'class-transformer';
import { IsInt, Max, Min } from 'class-validator';

export class FindAdminWebhookFailuresQueryDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  public readonly page: number = 1;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  public readonly limit: number = 20;
}
