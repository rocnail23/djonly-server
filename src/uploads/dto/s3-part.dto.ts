import { IsInt, IsNotEmpty, IsString, Max, Min } from 'class-validator';

export class S3PartDto {
  @IsString()
  @IsNotEmpty()
  public readonly ETag!: string;

  @IsInt()
  @Min(1)
  @Max(10000)
  public readonly PartNumber!: number;
}
