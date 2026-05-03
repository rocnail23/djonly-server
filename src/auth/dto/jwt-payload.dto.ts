import { Expose } from 'class-transformer';
import { type Role } from 'src/generated/prisma/client';

export class JwtPayloadDto {
  @Expose()
  public readonly sub!: string;

  @Expose()
  public readonly email!: string;

  @Expose()
  public readonly role!: Role;
}
