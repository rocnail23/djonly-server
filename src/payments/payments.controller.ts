import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Query,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';
import { type RequestWithUser } from 'src/auth/types/request-with-user.type';
import { Role as UserRole } from 'src/generated/prisma/client';
import { Roles } from 'src/auth/custom.decorator/roles.decorator';
import { Public } from 'src/auth/custom.decorator/public.decorator';
import { CreateCheckoutSessionDto } from './dto/create-checkout-session.dto';
import { CreateUpgradeSubscriptionDto } from './dto/create-upgrade-subscription.dto';
import { FindAdminPaymentsQueryDto } from './dto/find-admin-payments-query.dto';
import { FindAdminWebhookFailuresQueryDto } from './dto/find-admin-webhook-failures-query.dto';
import {
  PaginatedAdminFailedWebhookEventsResponse,
  AdminPaymentsStatsResponse,
  PaginatedAdminPaymentsResponse,
  PaymentsService,
  UpgradeSubscriptionResponse,
} from './payments.service';

interface StripeWebhookRequest extends Request {
  readonly rawBody?: Buffer;
}

@Controller('payments')
export class PaymentsController {
  public constructor(private readonly paymentsService: PaymentsService) {}

  @Public()
  @Get('prices')
  public async listPrices(): Promise<
    readonly {
      readonly id: string;
      readonly amount: number;
      readonly currency: string;
      readonly interval: string | null;
      readonly intervalCount: number | null;
      readonly productName: string | null;
      readonly productDescription: string | null;
    }[]
  > {
    return this.paymentsService.listPrices();
  }

  @Roles(UserRole.ADMIN, UserRole.USER)
  @Post('checkout-session')
  public async createCheckoutSession(
    @Body() createCheckoutSessionDto: CreateCheckoutSessionDto,
    @Req() request: RequestWithUser,
  ): Promise<{ readonly id: string; readonly url: string }> {
    const userId = this.getUserIdOrThrow(request);
    return this.paymentsService.createCheckoutSession(
      createCheckoutSessionDto,
      userId,
    );
  }

  @Roles(UserRole.ADMIN, UserRole.USER)
  @Post('upgrade')
  public async createUpgradeRequest(
    @Body() createUpgradeSubscriptionDto: CreateUpgradeSubscriptionDto,
    @Req() request: RequestWithUser,
  ): Promise<UpgradeSubscriptionResponse> {
    const userId = this.getUserIdOrThrow(request);
    return this.paymentsService.createUpgradeRequest(
      createUpgradeSubscriptionDto,
      userId,
    );
  }

  @Roles(UserRole.ADMIN)
  @Get('admin')
  public async listAdminPayments(
    @Query() query: FindAdminPaymentsQueryDto,
  ): Promise<PaginatedAdminPaymentsResponse> {
    return this.paymentsService.listAdminPayments(query);
  }

  @Roles(UserRole.ADMIN)
  @Get('admin/stats')
  public async getAdminPaymentsStats(): Promise<AdminPaymentsStatsResponse> {
    return this.paymentsService.getAdminPaymentsStats();
  }

  @Roles(UserRole.ADMIN)
  @Get('admin/webhook-failures')
  public listAdminFailedWebhookEvents(
    @Query() query: FindAdminWebhookFailuresQueryDto,
  ): Promise<PaginatedAdminFailedWebhookEventsResponse> {
    return this.paymentsService.listAdminFailedWebhookEvents(query);
  }

  @Public()
  @Post('webhook')
  public async handleWebhook(
    @Req() request: StripeWebhookRequest,
  ): Promise<{ readonly received: true }> {
    const signature = this.getStripeSignatureOrThrow(request);
    const rawBody = this.getRawBodyOrThrow(request);
    await this.paymentsService.handleWebhook({
      rawBody,
      signature,
    });
    return {
      received: true,
    };
  }

  private getUserIdOrThrow(request: RequestWithUser): string {
    const userId = request.user?.userId;
    if (!userId) {
      throw new UnauthorizedException('Debes iniciar sesión para continuar');
    }
    return userId;
  }

  private getStripeSignatureOrThrow(request: StripeWebhookRequest): string {
    const signature = request.headers['stripe-signature'];
    if (typeof signature !== 'string') {
      throw new BadRequestException('Header stripe-signature inválido');
    }
    return signature;
  }

  private getRawBodyOrThrow(request: StripeWebhookRequest): Buffer {
    const rawBody = request.rawBody;
    if (!rawBody || !(rawBody instanceof Buffer)) {
      throw new BadRequestException('No se pudo leer el raw body del webhook');
    }
    return rawBody;
  }
}
