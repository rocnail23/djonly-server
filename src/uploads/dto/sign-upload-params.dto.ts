import { IsNotEmpty, IsString } from 'class-validator';

export class SignUploadParamsDto {
  @IsString()
  @IsNotEmpty()
  public readonly filename!: string;

  @IsString()
  @IsNotEmpty()
  public readonly type!: string;
}
