import { Type } from 'class-transformer';
import { IsInt, Max, Min } from 'class-validator';

export class FindStripeInvoicesQueryDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  public readonly page: number = 1;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  public readonly limit: number = 10;
}
