import { Expose } from 'class-transformer';
import { type Role } from 'src/generated/prisma/client';

export class AuthenticatedUserDto {
  @Expose()
  public readonly userId!: string;

  @Expose()
  public readonly email!: string;

  @Expose()
  public readonly role!: Role;
}
