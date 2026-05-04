import {
  Body,
  BadRequestException,
  Controller,
  Get,
  Post,
  Put,
  Query,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { type CookieOptions, type Response } from 'express';
import { JwtAuthGuard } from './jwt-auth.guard';
import { AuthService } from './auth.service';
import { Public } from './custom.decorator/public.decorator';
import { Roles } from './custom.decorator/roles.decorator';
import { LocalAuthGuard } from './local-auth.guard';
import {
  Role as UserRole,
  SubscriptionPlan,
  SubscriptionSource,
} from 'src/generated/prisma/client';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { RegisterUserDto } from './dto/register-user.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { UpdateUserDto } from 'src/users/dto/update-user.dto';
import { type AuthenticatedUser } from './types/authenticated-user.type';
import { type RequestWithUser } from './types/request-with-user.type';
import { UsersService } from 'src/users/users.service';

const ACCESS_TOKEN_COOKIE_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 7; // 7 days

interface ProfileResponse {
  readonly userId: string;
  readonly email: string;
  readonly role: UserRole;
  readonly subscriptionActive: boolean;
}

@Controller('auth')
export class AuthController {
  public constructor(
    private readonly authService: AuthService,
    private readonly usersService: UsersService,
  ) {}

  @Public()
  @UseGuards(LocalAuthGuard)
  @Post('login')
  public async login(
    @Req() request: RequestWithUser,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AuthenticatedUser> {
    const authenticatedUser = this.getRequestUserOrThrow(request);
    const tokenResponse =
      await this.authService.generateAccessToken(authenticatedUser);
    this.setAccessTokenCookie(response, tokenResponse.accessToken);
    return authenticatedUser;
  }

  @Public()
  @Post('register')
  public async register(
    @Body() registerUserDto: RegisterUserDto,
  ): Promise<AuthenticatedUser> {
    return this.authService.registerUser(registerUserDto);
  }

  @Public()
  @Post('forgot-password')
  public async forgotPassword(
    @Body() forgotPasswordDto: ForgotPasswordDto,
  ): Promise<{ readonly message: string }> {
    await this.authService.requestPasswordReset(forgotPasswordDto.email);
    return {
      message:
        'Si el correo existe, te enviamos instrucciones para recuperar tu contraseña',
    };
  }

  @Post('change-password/request')
  public async requestPasswordChange(
    @Req() request: RequestWithUser,
  ): Promise<{ readonly message: string }> {
    const user = this.getRequestUserOrThrow(request);
    await this.authService.requestPasswordChange(user.userId);
    return {
      message: 'Te enviamos un enlace a tu correo para cambiar tu contraseña',
    };
  }

  @Public()
  @Get('reset-password/validate')
  public async validateResetPasswordToken(
    @Query('token') token: string,
  ): Promise<{ readonly isValid: boolean }> {
    if (!token) {
      return { isValid: false };
    }
    const isValid = await this.authService.isPasswordResetTokenValid(token);
    return { isValid };
  }

  @Public()
  @Post('reset-password')
  public async resetPassword(
    @Body() resetPasswordDto: ResetPasswordDto,
  ): Promise<{ readonly message: string }> {
    await this.authService.resetPasswordWithToken(
      resetPasswordDto.token,
      resetPasswordDto.password,
    );
    return {
      message: 'La contraseña fue actualizada correctamente',
    };
  }

  @Public()
  @Get('confirm-email')
  public async confirmEmail(
    @Query('token') token: string,
  ): Promise<{ readonly message: string }> {
    if (!token) {
      throw new BadRequestException('El token es obligatorio');
    }
    await this.authService.confirmEmailWithToken(token);
    return {
      message: 'Tu correo fue verificado correctamente',
    };
  }

  @Public()
  @Post('logout')
  public logout(@Res({ passthrough: true }) response: Response): void {
    response.clearCookie('access_token', this.getAccessTokenCookieOptions());
  }

  @UseGuards(JwtAuthGuard)
  @Get('profile')
  public async getProfile(
    @Req() request: RequestWithUser,
  ): Promise<ProfileResponse> {
    const user = this.getRequestUserOrThrow(request);
    const existingUser = await this.usersService.findById(user.userId);
    if (!existingUser) {
      throw new UnauthorizedException(
        'No se encontró el usuario para la solicitud actual',
      );
    }
    return {
      userId: existingUser.id,
      email: existingUser.email,
      role: existingUser.role,
      subscriptionActive: Boolean(existingUser.subscriptionActive),
    };
  }

  @Roles(UserRole.ADMIN)
  @Get('admin')
  public getAdminProfile(@Req() request: RequestWithUser): AuthenticatedUser {
    return this.getRequestUserOrThrow(request);
  }

  @Get('profile/details')
  public async getProfileDetails(@Req() request: RequestWithUser): Promise<{
    readonly userId: string;
    readonly email: string;
    readonly role: UserRole;
    readonly name: string | null;
    readonly subscriptionActive: boolean;
    readonly subscriptionPlan: SubscriptionPlan | null;
    readonly subscriptionSource: SubscriptionSource | null;
    readonly subscriptionCurrentPeriodStart: Date | null;
    readonly subscriptionCurrentPeriodEnd: Date | null;
    readonly subscriptionAmount: number | null;
    readonly subscriptionCurrency: string | null;
    readonly subscriptionInterval: string | null;
    readonly subscriptionIntervalCount: number | null;
  }> {
    const user = this.getRequestUserOrThrow(request);
    const existingUser = await this.usersService.findById(user.userId);
    if (!existingUser) {
      throw new UnauthorizedException(
        'No se encontró el usuario para la solicitud actual',
      );
    }
    const currentSubscription =
      await this.usersService.findCurrentUserSubscriptionSummary(user.userId);
    return {
      userId: existingUser.id,
      email: existingUser.email,
      role: existingUser.role,
      name: existingUser.name ?? null,
      subscriptionActive: Boolean(existingUser.subscriptionActive),
      subscriptionPlan: currentSubscription?.plan ?? null,
      subscriptionSource: currentSubscription?.source ?? null,
      subscriptionCurrentPeriodStart:
        currentSubscription?.currentPeriodStart ?? null,
      subscriptionCurrentPeriodEnd:
        currentSubscription?.currentPeriodEnd ?? null,
      subscriptionAmount: currentSubscription?.amount ?? null,
      subscriptionCurrency: currentSubscription?.currency ?? null,
      subscriptionInterval: currentSubscription?.interval ?? null,
      subscriptionIntervalCount: currentSubscription?.intervalCount ?? null,
    };
  }

  @Roles(UserRole.ADMIN, UserRole.USER)
  @Put('profile')
  public async updateProfile(
    @Req() request: RequestWithUser,
    @Body() payload: UpdateUserDto,
  ): Promise<{ readonly message: string }> {
    const user = this.getRequestUserOrThrow(request);
    await this.usersService.updateUser(user.userId, payload);
    return {
      message: 'Perfil actualizado correctamente',
    };
  }

  private getRequestUserOrThrow(request: RequestWithUser): AuthenticatedUser {
    if (!request.user) {
      throw new UnauthorizedException(
        'Falta el usuario autenticado en el contexto de la solicitud',
      );
    }
    return request.user;
  }

  private setAccessTokenCookie(response: Response, accessToken: string): void {
    response.cookie(
      'access_token',
      accessToken,
      this.getAccessTokenCookieOptions(),
    );
  }

  private getAccessTokenCookieOptions(): CookieOptions {
    const isProductionEnvironment = process.env.NODE_ENV === 'production';
    const sameSitePolicy: CookieOptions['sameSite'] = isProductionEnvironment
      ? 'none'
      : 'lax';
    return {
      httpOnly: true,
      secure: isProductionEnvironment,
      sameSite: sameSitePolicy,
      maxAge: ACCESS_TOKEN_COOKIE_MAX_AGE_MS,
      path: '/',
    };
  }
}
