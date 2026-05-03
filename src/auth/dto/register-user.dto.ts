import { IsEmail, IsOptional, IsString, MinLength } from 'class-validator';

export class RegisterUserDto {
  @IsEmail({}, { message: 'Debes ingresar un correo válido' })
  public readonly email!: string;

  @IsString({ message: 'La contraseña es obligatoria' })
  @MinLength(8, {
    message: 'La contraseña debe tener al menos 8 caracteres',
  })
  public readonly password!: string;

  @IsOptional()
  @IsString({ message: 'El nombre de usuario debe ser texto' })
  @MinLength(2, {
    message: 'El nombre de usuario debe tener al menos 2 caracteres',
  })
  public readonly username?: string;

  @IsOptional()
  @IsString({ message: 'El nombre debe ser texto' })
  @MinLength(2, { message: 'El nombre debe tener al menos 2 caracteres' })
  public readonly name?: string;
}
