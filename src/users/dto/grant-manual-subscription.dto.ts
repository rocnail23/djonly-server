import { IsIn, IsInt } from 'class-validator';

const ALLOWED_MANUAL_SUBSCRIPTION_MONTHS = [1, 3, 6] as const;

export class GrantManualSubscriptionDto {
  @IsInt()
  @IsIn(ALLOWED_MANUAL_SUBSCRIPTION_MONTHS)
  public readonly months!: number;
}
