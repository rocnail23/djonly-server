import {
  BadRequestException,
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { compare, hash } from 'bcrypt';
import { randomBytes } from 'crypto';
import { JwtService } from '@nestjs/jwt';
import { type AuthTokenType } from 'src/generated/prisma/enums';
import { ResendMailService } from '../mail/resend-mail.service';
import { PrismaService } from '../prisma/prisma.service';
import { UsersService } from '../users/users.service';
import { type AccessTokenResponse } from './types/access-token-response.type';
import { type AuthenticatedUser } from './types/authenticated-user.type';
import { type JwtPayload } from './types/jwt-payload.type';

const AUTH_TOKEN_EXPIRATION_MINUTES = 20;
const EMAIL_CONFIRMATION_TOKEN_TYPE: AuthTokenType = 'EMAIL_CONFIRMATION';
const PASSWORD_RESET_TOKEN_TYPE: AuthTokenType = 'PASSWORD_RESET';

type ComparePasswordFunction = (
  plainTextPassword: string,
  hashedPassword: string,
) => Promise<boolean>;

type HashPasswordFunction = (
  plainTextPassword: string,
  saltOrRounds: string | number,
) => Promise<string>;

interface RegisterUserOptions {
  readonly email: string;
  readonly password: string;
  readonly username?: string;
  readonly name?: string;
}

@Injectable()
export class AuthService {
  public constructor(
    private readonly usersService: UsersService,
    private readonly jwtService: JwtService,
    private readonly mailService: ResendMailService,
    private readonly prisma: PrismaService,
  ) {}

  public async validateUser(
    email: string,
    password: string,
  ): Promise<AuthenticatedUser | null> {
    const user = await this.usersService.findByEmail(email);
    if (!user) {
      return null;
    }
    const comparePassword: ComparePasswordFunction =
      compare as ComparePasswordFunction;
    const isValidPassword = await comparePassword(password, user.password);
    if (!isValidPassword) {
      return null;
    }
    if (!user.emailVerified) {
      throw new UnauthorizedException({
        code: 'AUTH_EMAIL_NOT_VERIFIED',
        message: 'Debes verificar tu correo antes de iniciar sesión',
      });
    }
    return {
      userId: user.id,
      email: user.email,
      role: user.role,
    };
  }

  public async generateAccessToken(
    user: AuthenticatedUser,
  ): Promise<AccessTokenResponse> {
    const payload: JwtPayload = {
      sub: user.userId,
      email: user.email,
      role: user.role,
    };
    const accessToken = await this.jwtService.signAsync(payload);
    return {
      accessToken,
    };
  }

  public async registerUser(
    options: RegisterUserOptions,
  ): Promise<AuthenticatedUser> {
    const existingUser = await this.usersService.findByEmail(options.email);
    if (existingUser) {
      throw new ConflictException({
        code: 'AUTH_EMAIL_ALREADY_EXISTS',
        message: 'Ya existe un usuario con este correo',
      });
    }

    const hashPassword: HashPasswordFunction = hash as HashPasswordFunction;
    const hashedPassword = await hashPassword(options.password, 12);
    const displayName = options.name ?? options.username;
    const createdUser = await this.usersService.createUser({
      email: options.email,
      password: hashedPassword,
      name: displayName,
      emailVerified: false,
    });

    const confirmationToken = await this.createAuthToken(
      createdUser.id,
      EMAIL_CONFIRMATION_TOKEN_TYPE,
    );
    const confirmationUrl = this.buildFrontendUrl(
      `/verify-email?token=${confirmationToken}`,
    );
    await this.mailService.sendConfirmationEmail({
      to: createdUser.email,
      confirmationUrl,
    });

    return {
      userId: createdUser.id,
      email: createdUser.email,
      role: createdUser.role,
    };
  }

  public async requestPasswordReset(email: string): Promise<void> {
    const user = await this.usersService.findByEmail(email);
    if (!user) {
      return;
    }
    const resetToken = await this.createAuthToken(
      user.id,
      PASSWORD_RESET_TOKEN_TYPE,
    );
    const resetPasswordUrl = this.buildFrontendUrl(
      `/reset-password?token=${resetToken}`,
    );
    await this.mailService.sendRetrievePasswordEmail({
      to: user.email,
      resetPasswordUrl,
      purpose: 'RECOVERY',
    });
  }

  public async requestPasswordChange(userId: string): Promise<void> {
    const user = await this.usersService.findById(userId);
    if (!user) {
      throw new UnauthorizedException(
        'No se encontró el usuario para solicitar cambio de contraseña',
      );
    }
    const resetToken = await this.createAuthToken(
      user.id,
      PASSWORD_RESET_TOKEN_TYPE,
    );
    const resetPasswordUrl = this.buildFrontendUrl(
      `/reset-password?token=${resetToken}`,
    );
    await this.mailService.sendRetrievePasswordEmail({
      to: user.email,
      resetPasswordUrl,
      purpose: 'CHANGE',
    });
  }

  public async isPasswordResetTokenValid(token: string): Promise<boolean> {
    const tokenRecord = await this.findValidTokenRecord(
      token,
      PASSWORD_RESET_TOKEN_TYPE,
    );
    return tokenRecord !== null;
  }

  public async resetPasswordWithToken(
    token: string,
    password: string,
  ): Promise<void> {
    const tokenRecord = await this.findValidTokenRecord(
      token,
      PASSWORD_RESET_TOKEN_TYPE,
    );
    if (!tokenRecord) {
      throw new BadRequestException('El token no es válido o ha expirado');
    }
    const hashPassword: HashPasswordFunction = hash as HashPasswordFunction;
    const hashedPassword = await hashPassword(password, 12);
    await this.usersService.updatePassword(tokenRecord.userId, hashedPassword);
    await this.markTokenAsUsed(tokenRecord.id);
  }

  public async confirmEmailWithToken(token: string): Promise<void> {
    const tokenRecord = await this.findValidTokenRecord(
      token,
      EMAIL_CONFIRMATION_TOKEN_TYPE,
    );
    if (!tokenRecord) {
      throw new BadRequestException('El token no es válido o ha expirado');
    }
    await this.usersService.markEmailAsVerified(tokenRecord.userId);
    await this.markTokenAsUsed(tokenRecord.id);
  }

  private async createAuthToken(
    userId: string,
    tokenType: AuthTokenType,
  ): Promise<string> {
    await this.prisma.authToken.updateMany({
      where: {
        userId,
        type: tokenType,
        usedAt: null,
      },
      data: {
        usedAt: new Date(),
      },
    });
    const token = randomBytes(32).toString('hex');
    const expiresAt = new Date(
      Date.now() + AUTH_TOKEN_EXPIRATION_MINUTES * 60 * 1000,
    );
    await this.prisma.authToken.create({
      data: {
        token,
        type: tokenType,
        expiresAt,
        userId,
      },
    });
    return token;
  }

  private findValidTokenRecord(
    token: string,
    tokenType: AuthTokenType,
  ): Promise<{ readonly id: string; readonly userId: string } | null> {
    return this.prisma.authToken.findFirst({
      where: {
        token,
        type: tokenType,
        usedAt: null,
        expiresAt: {
          gt: new Date(),
        },
      },
      select: {
        id: true,
        userId: true,
      },
      orderBy: {
        createdAt: 'desc',
      },
    });
  }

  private async markTokenAsUsed(tokenId: string): Promise<void> {
    await this.prisma.authToken.update({
      where: { id: tokenId },
      data: {
        usedAt: new Date(),
      },
    });
  }

  private buildFrontendUrl(path: string): string {
    const frontendUrl = process.env.FRONTEND_URL ?? 'http://localhost:3000';
    const normalizedBaseUrl = frontendUrl.endsWith('/')
      ? frontendUrl.slice(0, -1)
      : frontendUrl;
    return `${normalizedBaseUrl}${path}`;
  }
}
