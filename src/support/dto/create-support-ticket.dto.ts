import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateSupportTicketDto {
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  public readonly fullName!: string;

  @IsEmail()
  public readonly email!: string;

  @IsString()
  @MinLength(3)
  @MaxLength(140)
  public readonly subject!: string;

  @IsString()
  @MinLength(10)
  @MaxLength(2000)
  public readonly message!: string;
}
