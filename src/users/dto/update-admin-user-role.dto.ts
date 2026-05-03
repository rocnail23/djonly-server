import { IsEnum } from 'class-validator';
import { Role } from 'src/generated/prisma/client';

export class UpdateAdminUserRoleDto {
  @IsEnum(Role)
  public readonly role!: Role;
}
