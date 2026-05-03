import { type AuthenticatedUser } from './authenticated-user.type';

export interface RequestWithUser {
  readonly user?: AuthenticatedUser;
}
