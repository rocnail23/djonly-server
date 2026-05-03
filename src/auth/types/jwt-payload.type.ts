import { type Role } from 'src/generated/prisma/client';

export interface JwtPayload {
  readonly sub: string;
  readonly email: string;
  readonly role: Role;
}
