import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { SubscriptionStatus } from 'src/generated/prisma/client';

export class FindAdminUsersQueryDto {
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

  @IsOptional()
  @IsEnum(SubscriptionStatus)
  public readonly subscriptionStatus?: SubscriptionStatus;
}
