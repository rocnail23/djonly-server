import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, ValidateNested } from 'class-validator';
import { S3PartDto } from './s3-part.dto';

export class CompleteMultipartUploadDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => S3PartDto)
  public readonly parts!: readonly S3PartDto[];
}
