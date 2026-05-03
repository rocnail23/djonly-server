import { IsNotEmpty, IsString } from 'class-validator';

export class CreateUpgradeSubscriptionDto {
  @IsString()
  @IsNotEmpty()
  public readonly toPriceId!: string;
}
