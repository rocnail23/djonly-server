import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { type Request } from 'express';
import { envs } from '../config/envs';
import { type AuthenticatedUser } from './types/authenticated-user.type';
import { type JwtPayload } from './types/jwt-payload.type';

function extractAccessTokenFromCookie(request: Request): string | null {
  const cookieHeader = request.headers.cookie;
  if (!cookieHeader) {
    return null;
  }
  const cookieEntries = cookieHeader.split(';').map((entry) => entry.trim());
  const accessTokenCookie = cookieEntries.find((entry) =>
    entry.startsWith('access_token='),
  );
  if (!accessTokenCookie) {
    return null;
  }
  const accessToken = accessTokenCookie.slice('access_token='.length);
  return accessToken.length > 0 ? decodeURIComponent(accessToken) : null;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  public constructor() {
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([
        extractAccessTokenFromCookie,
        ExtractJwt.fromAuthHeaderAsBearerToken(),
      ]),
      ignoreExpiration: false,
      secretOrKey: envs.JWT_SECRET,
      passReqToCallback: false,
    });
  }

  public validate(payload: JwtPayload): AuthenticatedUser {
    return {
      userId: payload.sub,
      email: payload.email,
      role: payload.role,
    };
  }
}
