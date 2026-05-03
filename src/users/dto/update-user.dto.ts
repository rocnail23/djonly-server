import { IsString, MaxLength, MinLength } from 'class-validator';

export class UpdateUserDto {
  @IsString({ message: 'El usuario debe ser un texto válido' })
  @MinLength(2, { message: 'El usuario debe tener al menos 2 caracteres' })
  @MaxLength(120, { message: 'El usuario no puede superar 120 caracteres' })
  public readonly username!: string;
}
