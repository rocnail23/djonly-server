import {
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Reflector } from '@nestjs/core';
import { Observable } from 'rxjs';
import { IS_PUBLIC_KEY } from './custom.decorator/public.decorator';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private reflector: Reflector) {
    super();
  }

  // Definimos los tipos de retorno que espera NestJS
  canActivate(
    context: ExecutionContext,
  ): boolean | Promise<boolean> | Observable<boolean> {
    // IMPORTANTE: No retornamos true aquí si es público.
    // Simplemente llamamos al padre para que intente validar el JWT.
    return super.canActivate(context);
  }

  // Sobrescribimos handleRequest con tipos explícitos
  handleRequest<TUser = any>(
    err: any,
    user: TUser,
    info: any,
    context: ExecutionContext,
  ): TUser {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    // 1. Si el JWT es válido, user contendrá los datos (payload)
    if (user) {
      return user;
    }

    // 2. Si hay error o no hay usuario, pero la ruta es @Public(),
    // permitimos el acceso devolviendo null (en lugar de lanzar excepción)
    if (isPublic) {
      return null as TUser;
    }

    // 3. Si no hay usuario y NO es público, lanzamos el error 401
    throw (
      err ||
      new UnauthorizedException('No autorizado para acceder a este recurso')
    );
  }
}
