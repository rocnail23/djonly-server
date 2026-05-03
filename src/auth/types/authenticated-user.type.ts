import { type Role } from 'src/generated/prisma/client';

export interface AuthenticatedUser {
  readonly userId: string;
  readonly email: string;
  readonly role: Role;
}
