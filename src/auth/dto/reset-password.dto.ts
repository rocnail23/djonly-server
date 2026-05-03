import { IsString, MinLength } from 'class-validator';

export class ResetPasswordDto {
  @IsString()
  public readonly token!: string;

  @IsString()
  @MinLength(8)
  public readonly password!: string;
}
