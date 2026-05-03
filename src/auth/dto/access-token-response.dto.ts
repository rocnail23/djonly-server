import { Expose } from 'class-transformer';

export class AccessTokenResponseDto {
  @Expose()
  public readonly accessToken!: string;
}
