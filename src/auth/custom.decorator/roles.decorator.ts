import { SetMetadata } from '@nestjs/common';
import { type Role } from 'src/generated/prisma/client';

export const ROLES_KEY = 'roles';
export const Roles = (...roles: readonly Role[]) =>
  SetMetadata(ROLES_KEY, roles);
