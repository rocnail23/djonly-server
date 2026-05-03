import { IsNotEmpty, IsString } from 'class-validator';

export class KeyQueryDto {
  @IsString()
  @IsNotEmpty()
  public readonly key!: string;
}
