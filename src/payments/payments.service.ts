import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
} from '@nestjs/common';
import Stripe from 'stripe';
import {
  PaymentProvider,
  PaymentStatus,
  Prisma,
  StripeWebhookEventStatus,
  SubscriptionPlan,
  SubscriptionSource,
  SubscriptionStatus,
  UpgradeRequestStatus,
} from 'src/generated/prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import {
  StripeCheckoutSessionResponse,
  StripePrice,
  StripeService,
} from 'src/stripe/stripe.service';
import { CreateCheckoutSessionDto } from './dto/create-checkout-session.dto';
import { CreateUpgradeSubscriptionDto } from './dto/create-upgrade-subscription.dto';

interface HandleWebhookInput {
  readonly rawBody: Buffer;
  readonly signature: string;
}

interface StripeObjectWithId {
  readonly id: string;
}

interface AdminPaymentsQueryInput {
  readonly page: number;
  readonly limit: number;
}

interface AdminWebhookFailuresQueryInput {
  readonly page: number;
  readonly limit: number;
}

export interface AdminPaymentListItem {
  readonly id: string;
  readonly externalId: string | null;
  readonly amount: number;
  readonly currency: string;
  readonly status: PaymentStatus;
  readonly provider: PaymentProvider;
  readonly createdAt: Date;
  readonly customerEmail: string;
  readonly subscriptionEndsAt: Date | null;
}

export interface PaginatedAdminPaymentsResponse {
  readonly items: readonly AdminPaymentListItem[];
  readonly page: number;
  readonly limit: number;
  readonly total: number;
  readonly totalPages: number;
}

export interface AdminPaymentsStatsResponse {
  readonly totalSoldAmount: number;
  readonly soldAmountThisMonth: number;
  readonly conversionRatio: number;
  readonly paidUsersCount: number;
  readonly registeredUsersCount: number;
}

export interface AdminFailedWebhookEventListItem {
  readonly eventId: string;
  readonly type: string;
  readonly stripeCreatedAt: Date | null;
  readonly errorMessage: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface PaginatedAdminFailedWebhookEventsResponse {
  readonly items: readonly AdminFailedWebhookEventListItem[];
  readonly page: number;
  readonly limit: number;
  readonly total: number;
  readonly totalPages: number;
}

export interface UpgradeSubscriptionResponse {
  readonly upgradeRequestId: string;
  readonly invoiceId: string | null;
  readonly status: UpgradeRequestStatus;
}

const DEFAULT_SUBSCRIPTION_PLAN: SubscriptionPlan = SubscriptionPlan.PREMIUM;
const ACTIVE_STRIPE_SUBSCRIPTION_STATUS = 'active';
const PAST_DUE_STRIPE_SUBSCRIPTION_STATUS = 'past_due';
const TRIALING_STRIPE_SUBSCRIPTION_STATUS = 'trialing';
const CANCELED_STRIPE_SUBSCRIPTION_STATUS = 'canceled';
const UNPAID_STRIPE_SUBSCRIPTION_STATUS = 'unpaid';
const INCOMPLETE_STRIPE_SUBSCRIPTION_STATUS = 'incomplete';
const INCOMPLETE_EXPIRED_STRIPE_SUBSCRIPTION_STATUS = 'incomplete_expired';
const PAUSED_STRIPE_SUBSCRIPTION_STATUS = 'paused';
const WEBHOOK_EVENT_STATUS_PROCESSING = 'PROCESSING';
const WEBHOOK_EVENT_STATUS_PROCESSED = 'PROCESSED';
const WEBHOOK_EVENT_STATUS_FAILED = 'FAILED';
const THIRTY_DAYS_IN_MILLISECONDS = 30 * 24 * 60 * 60 * 1000;

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  public constructor(
    private readonly stripeService: StripeService,
    private readonly prismaService: PrismaService,
  ) {}

  public async createCheckoutSession(
    createCheckoutSessionDto: CreateCheckoutSessionDto,
    userId: string,
  ): Promise<StripeCheckoutSessionResponse> {
    this.logger.log(
      `Creating checkout session for user=${userId} price=${createCheckoutSessionDto.priceId}`,
    );
    await this.assertUserHasNoActiveSubscription(userId);
    const checkoutSession = await this.stripeService.createCheckoutSession({
      userId,
      priceId: createCheckoutSessionDto.priceId,
    });
    this.logger.log(
      `Checkout session created for user=${userId} session=${checkoutSession.id}`,
    );
    return checkoutSession;
  }

  public async createUpgradeRequest(
    createUpgradeSubscriptionDto: CreateUpgradeSubscriptionDto,
    userId: string,
  ): Promise<UpgradeSubscriptionResponse> {
    const now = new Date();
    const activeSubscription = await this.prismaService.subscription.findFirst({
      where: {
        userId,
        source: SubscriptionSource.STRIPE,
        status: SubscriptionStatus.ACTIVE,
        currentPeriodStart: {
          lte: now,
        },
        currentPeriodEnd: {
          gt: now,
        },
      },
      select: {
        id: true,
        externalId: true,
      },
      orderBy: {
        currentPeriodEnd: 'desc',
      },
    });
    if (!activeSubscription?.externalId) {
      throw new BadRequestException(
        'No tienes una suscripción Stripe activa para actualizar',
      );
    }
    const hasPendingUpgrade = await this.prismaService.upgradeRequest.findFirst(
      {
        where: {
          subscriptionId: activeSubscription.id,
          status: UpgradeRequestStatus.PENDING,
        },
        select: {
          id: true,
        },
        orderBy: {
          createdAt: 'desc',
        },
      },
    );
    if (hasPendingUpgrade?.id) {
      throw new ConflictException(
        'Ya existe un upgrade pendiente para esta suscripción',
      );
    }
    const stripeUpgrade = await this.stripeService.upgradeSubscription({
      subscriptionId: activeSubscription.externalId,
      newPriceId: createUpgradeSubscriptionDto.toPriceId,
    });
    const upgradeRequest = await this.prismaService.upgradeRequest.create({
      data: {
        userId,
        subscriptionId: activeSubscription.id,
        stripeSubscriptionId: stripeUpgrade.subscriptionId,
        stripeInvoiceId: stripeUpgrade.invoiceId,
        fromPriceId: stripeUpgrade.fromPriceId,
        toPriceId: stripeUpgrade.toPriceId,
        status: UpgradeRequestStatus.PENDING,
      },
      select: {
        id: true,
        stripeInvoiceId: true,
        status: true,
      },
    });
    return {
      upgradeRequestId: upgradeRequest.id,
      invoiceId: upgradeRequest.stripeInvoiceId,
      status: upgradeRequest.status,
    };
  }

  public async listPrices(): Promise<readonly StripePrice[]> {
    return this.stripeService.listRecurringPrices();
  }

  public async listAdminPayments(
    query: AdminPaymentsQueryInput,
  ): Promise<PaginatedAdminPaymentsResponse> {
    const safePage = query.page >= 1 ? query.page : 1;
    const safeLimit = query.limit >= 1 ? query.limit : 20;
    const skip = (safePage - 1) * safeLimit;
    const [payments, total] = await this.prismaService.$transaction([
      this.prismaService.payment.findMany({
        orderBy: {
          createdAt: 'desc',
        },
        skip,
        take: safeLimit,
        include: {
          user: {
            select: {
              email: true,
            },
          },
          subscription: {
            select: {
              currentPeriodEnd: true,
            },
          },
        },
      }),
      this.prismaService.payment.count(),
    ]);
    const totalPages = Math.max(1, Math.ceil(total / safeLimit));
    const items: readonly AdminPaymentListItem[] = payments.map((payment) => ({
      id: payment.id,
      externalId: payment.externalId,
      amount: payment.amount,
      currency: payment.currency,
      status: payment.status,
      provider: payment.provider,
      createdAt: payment.createdAt,
      customerEmail: payment.user.email,
      subscriptionEndsAt: payment.subscription?.currentPeriodEnd ?? null,
    }));
    return {
      items,
      page: safePage,
      limit: safeLimit,
      total,
      totalPages,
    };
  }

  public async getAdminPaymentsStats(): Promise<AdminPaymentsStatsResponse> {
    const monthRange = this.resolveCurrentMonthRange();
    const [
      allCompletedAmount,
      monthCompletedAmount,
      paidUsersCount,
      totalUsers,
    ] = await this.prismaService.$transaction([
      this.prismaService.payment.aggregate({
        where: {
          status: PaymentStatus.COMPLETED,
        },
        _sum: {
          amount: true,
        },
      }),
      this.prismaService.payment.aggregate({
        where: {
          status: PaymentStatus.COMPLETED,
          createdAt: {
            gte: monthRange.monthStart,
            lt: monthRange.monthEnd,
          },
        },
        _sum: {
          amount: true,
        },
      }),
      this.prismaService.user.count({
        where: {
          payments: {
            some: {
              status: PaymentStatus.COMPLETED,
            },
          },
        },
      }),
      this.prismaService.user.count(),
    ]);
    const totalSoldAmount = allCompletedAmount._sum.amount ?? 0;
    const soldAmountThisMonth = monthCompletedAmount._sum.amount ?? 0;
    const conversionRatio =
      totalUsers === 0
        ? 0
        : Number(((paidUsersCount / totalUsers) * 100).toFixed(2));
    return {
      totalSoldAmount,
      soldAmountThisMonth,
      conversionRatio,
      paidUsersCount,
      registeredUsersCount: totalUsers,
    };
  }

  public async listAdminFailedWebhookEvents(
    query: AdminWebhookFailuresQueryInput,
  ): Promise<PaginatedAdminFailedWebhookEventsResponse> {
    const safePage = query.page >= 1 ? query.page : 1;
    const safeLimit = query.limit >= 1 ? query.limit : 20;
    const skip = (safePage - 1) * safeLimit;
    const [events, total] = await this.prismaService.$transaction([
      this.prismaService.stripeWebhookEvent.findMany({
        where: {
          status: StripeWebhookEventStatus.FAILED,
        },
        orderBy: {
          updatedAt: 'desc',
        },
        skip,
        take: safeLimit,
        select: {
          eventId: true,
          type: true,
          stripeCreatedAt: true,
          errorMessage: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
      this.prismaService.stripeWebhookEvent.count({
        where: {
          status: StripeWebhookEventStatus.FAILED,
        },
      }),
    ]);
    return {
      items: events,
      page: safePage,
      limit: safeLimit,
      total,
      totalPages: Math.max(1, Math.ceil(total / safeLimit)),
    };
  }

  public async handleWebhook(input: HandleWebhookInput): Promise<void> {
    const event = this.stripeService.constructWebhookEvent({
      rawBody: input.rawBody,
      signature: input.signature,
    });
    this.logger.log(
      `Stripe webhook received type=${event.type} id=${event.id}`,
    );
    const canProcess = await this.acquireWebhookEventForProcessing(event);
    if (!canProcess) {
      this.logger.log(
        `Stripe webhook already processed or in-flight type=${event.type} id=${event.id}`,
      );
      return;
    }
    this.processWebhookEventInBackground(event);
  }

  private processWebhookEventInBackground(event: Stripe.Event): void {
    void (async () => {
      try {
        await this.dispatchWebhookEvent(event);
        await this.markWebhookEventAsProcessed(event.id);
      } catch (error: unknown) {
        await this.markWebhookEventAsFailed({
          eventId: event.id,
          error,
        });
        this.logger.error(
          `Stripe webhook processing failed type=${event.type} id=${event.id}`,
          error instanceof Error ? error.stack : undefined,
        );
      }
    })();
  }

  private async dispatchWebhookEvent(event: Stripe.Event): Promise<void> {
    switch (event.type) {
      case 'checkout.session.completed': {
        this.handleCheckoutSessionCompleted(event.data.object);
        return;
      }
      case 'invoice.paid': {
        await this.handleInvoicePaid(event.data.object);
        return;
      }
      case 'invoice.payment_failed': {
        await this.handleInvoicePaymentFailed(event.data.object);
        return;
      }
      case 'customer.subscription.updated': {
        await this.handleSubscriptionUpdated(event.data.object);
        return;
      }
      case 'customer.subscription.pending_update_applied': {
        await this.handleSubscriptionPendingUpdateApplied(event.data.object);
        return;
      }
      case 'customer.subscription.pending_update_expired': {
        await this.handleSubscriptionPendingUpdateExpired(event.data.object);
        return;
      }
      case 'customer.subscription.deleted': {
        await this.handleSubscriptionDeleted(event.data.object);
        return;
      }
      case 'customer.subscription.trial_will_end': {
        this.logger.log(`Stripe trial will end event received id=${event.id}`);
        return;
      }
      default: {
        this.logger.log(
          `Stripe event ignored type=${event.type} id=${event.id}`,
        );
      }
    }
  }

  private async acquireWebhookEventForProcessing(
    event: Stripe.Event,
  ): Promise<boolean> {
    try {
      await this.prismaService.stripeWebhookEvent.create({
        data: {
          eventId: event.id,
          type: event.type,
          stripeCreatedAt: this.fromUnixTimestamp(event.created),
          status: WEBHOOK_EVENT_STATUS_PROCESSING,
        },
      });
      return true;
    } catch (error: unknown) {
      if (!this.isUniqueConstraintError(error)) {
        throw error;
      }
    }
    const existingEvent =
      await this.prismaService.stripeWebhookEvent.findUnique({
        where: {
          eventId: event.id,
        },
        select: {
          status: true,
        },
      });
    if (existingEvent?.status !== WEBHOOK_EVENT_STATUS_FAILED) {
      return false;
    }
    const retryClaim = await this.prismaService.stripeWebhookEvent.updateMany({
      where: {
        eventId: event.id,
        status: WEBHOOK_EVENT_STATUS_FAILED,
      },
      data: {
        status: WEBHOOK_EVENT_STATUS_PROCESSING,
        errorMessage: null,
        processedAt: null,
        type: event.type,
        stripeCreatedAt: this.fromUnixTimestamp(event.created),
      },
    });
    return retryClaim.count === 1;
  }

  private async markWebhookEventAsProcessed(eventId: string): Promise<void> {
    await this.prismaService.stripeWebhookEvent.updateMany({
      where: {
        eventId,
        status: WEBHOOK_EVENT_STATUS_PROCESSING,
      },
      data: {
        status: WEBHOOK_EVENT_STATUS_PROCESSED,
        processedAt: new Date(),
        errorMessage: null,
      },
    });
  }

  private async markWebhookEventAsFailed(input: {
    readonly eventId: string;
    readonly error: unknown;
  }): Promise<void> {
    await this.prismaService.stripeWebhookEvent.updateMany({
      where: {
        eventId: input.eventId,
      },
      data: {
        status: WEBHOOK_EVENT_STATUS_FAILED,
        errorMessage: this.resolveWebhookErrorMessage(input.error),
      },
    });
  }

  private isUniqueConstraintError(error: unknown): boolean {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    );
  }

  private resolveWebhookErrorMessage(error: unknown): string {
    if (error instanceof Error && error.message) {
      return error.message;
    }
    return 'Unknown Stripe webhook error';
  }

  private async assertUserHasNoActiveSubscription(
    userId: string,
  ): Promise<void> {
    const now = new Date();
    const activeSubscription = await this.prismaService.subscription.findFirst({
      where: {
        userId,
        status: 'ACTIVE',
        currentPeriodStart: {
          lte: now,
        },
        currentPeriodEnd: {
          gt: now,
        },
      },
      select: {
        id: true,
      },
    });
    if (activeSubscription) {
      this.logger.warn(
        `User already has an active subscription user=${userId}`,
      );
      throw new ConflictException('El usuario ya tiene una suscripción activa');
    }
  }

  private handleCheckoutSessionCompleted(
    session: Stripe.Checkout.Session,
  ): void {
    const sessionId = session.id;
    this.logger.log(`Stripe checkout.session.completed received: ${sessionId}`);
  }

  private async handleInvoicePaid(invoice: Stripe.Invoice): Promise<void> {
    if (typeof invoice.id !== 'string') {
      return;
    }
    this.logger.log(`Stripe invoice.paid received: ${JSON.stringify(invoice)}`);
    const subscriptionExternalId = this.extractSubscriptionId(invoice);
    const userId = await this.resolveUserIdForInvoice({
      invoice,
      subscriptionExternalId,
    });
    await this.attachStripeCustomerToUser({
      userId,
      customerReference: invoice.customer,
    });
    if (!userId || !subscriptionExternalId) {
      this.logger.warn(
        `Skipping invoice.paid ${invoice.id}: user or subscription missing`,
      );
      return;
    }
    const period = this.resolveInvoicePeriod({
      invoice,
      subscriptionExternalId,
    });

    await this.prismaService.$transaction(async (prisma) => {
      const existingPayment = await prisma.payment.findUnique({
        where: {
          externalId: invoice.id,
        },
        select: {
          id: true,
        },
      });
      if (existingPayment) {
        this.logger.log(
          `Ignoring duplicated invoice.paid invoice=${invoice.id}`,
        );
        return;
      }

      await prisma.subscription.updateMany({
        where: {
          userId,
          externalId: {
            not: subscriptionExternalId,
          },
        },
        data: {
          status: SubscriptionStatus.EXPIRED,
        },
      });

      const existingSubscription = await prisma.subscription.findFirst({
        where: {
          userId,
          externalId: subscriptionExternalId,
        },
        select: {
          id: true,
        },
      });
      const currentSubscriptionId = existingSubscription?.id;

      if (currentSubscriptionId) {
        await prisma.subscription.update({
          where: {
            id: currentSubscriptionId,
          },
          data: {
            plan: DEFAULT_SUBSCRIPTION_PLAN,
            source: SubscriptionSource.STRIPE,
            status: SubscriptionStatus.ACTIVE,
            currentPeriodStart: period.start,
            currentPeriodEnd: period.end,
            canceledAt: null,
          },
        });
      }
      const newSubscription =
        currentSubscriptionId ??
        (
          await prisma.subscription.create({
            data: {
              userId,
              plan: DEFAULT_SUBSCRIPTION_PLAN,
              source: SubscriptionSource.STRIPE,
              status: SubscriptionStatus.ACTIVE,
              currentPeriodStart: period.start,
              currentPeriodEnd: period.end,
              externalId: subscriptionExternalId,
            },
            select: {
              id: true,
            },
          })
        ).id;
      await prisma.payment.create({
        data: {
          userId,
          subscriptionId: newSubscription,
          amount: this.resolveInvoiceAmount(invoice),
          currency: this.resolveInvoiceCurrency(invoice),
          status: PaymentStatus.COMPLETED,
          provider: PaymentProvider.STRIPE,
          externalId: invoice.id,
        },
      });
    });
    await this.syncUserSubscriptionActivity(userId);
    this.logger.log(
      `Processed invoice.paid invoice=${invoice.id} user=${userId} subscription=${subscriptionExternalId}`,
    );
  }

  private async handleInvoicePaymentFailed(
    invoice: Stripe.Invoice,
  ): Promise<void> {
    this.logger.log(
      `Stripe invoice.payment_failed received: ${JSON.stringify(invoice)}`,
    );
    if (typeof invoice.id !== 'string') {
      return;
    }
    const subscriptionExternalId = this.extractSubscriptionId(invoice);
    const userId = await this.resolveUserIdForInvoice({
      invoice,
      subscriptionExternalId,
    });
    if (!userId) {
      this.logger.warn(
        `Skipping invoice.payment_failed ${invoice.id}: user missing`,
      );
      return;
    }
    await this.prismaService.payment.upsert({
      where: {
        externalId: invoice.id,
      },
      update: {
        status: PaymentStatus.FAILED,
        amount: this.resolveInvoiceAmount(invoice),
        currency: this.resolveInvoiceCurrency(invoice),
      },
      create: {
        userId,
        amount: this.resolveInvoiceAmount(invoice),
        currency: this.resolveInvoiceCurrency(invoice),
        status: PaymentStatus.FAILED,
        provider: PaymentProvider.STRIPE,
        externalId: invoice.id,
      },
    });
    if (subscriptionExternalId) {
      await this.prismaService.subscription.updateMany({
        where: {
          userId,
          externalId: subscriptionExternalId,
        },
        data: {
          status: SubscriptionStatus.PAST_DUE,
        },
      });
    }
    await this.syncUserSubscriptionActivity(userId);
    this.logger.log(
      `Processed invoice.payment_failed invoice=${invoice.id} user=${userId} subscription=${subscriptionExternalId ?? 'unknown'}`,
    );
  }

  private async handleSubscriptionUpdated(
    subscription: Stripe.Subscription,
  ): Promise<void> {
    this.logger.log(
      `Stripe customer.subscription.updated received: ${JSON.stringify(subscription)}`,
    );
    const userId = await this.resolveUserIdForSubscription(subscription);
    await this.attachStripeCustomerToUser({
      userId,
      customerReference: subscription.customer,
    });
    if (!userId) {
      this.logger.warn(
        `Skipping customer.subscription.updated ${subscription.id}: user missing`,
      );
      return;
    }
    const nextStatus = this.mapStripeSubscriptionStatus(subscription.status);
    if (!nextStatus) {
      this.logger.log(
        `Ignoring unsupported subscription status subscription=${subscription.id} status=${subscription.status}`,
      );
      return;
    }
    await this.prismaService.$transaction(async (prisma) => {
      if (nextStatus === SubscriptionStatus.ACTIVE) {
        await prisma.subscription.updateMany({
          where: {
            userId,
            status: {
              in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.PAST_DUE],
            },
            externalId: {
              not: subscription.id,
            },
          },
          data: {
            status: SubscriptionStatus.EXPIRED,
          },
        });
      }
      const existingSubscription = await prisma.subscription.findFirst({
        where: {
          userId,
          externalId: subscription.id,
        },
        select: {
          id: true,
        },
      });
      const period = this.resolveSubscriptionPeriod(subscription);
      if (existingSubscription?.id) {
        await prisma.subscription.update({
          where: {
            id: existingSubscription.id,
          },
          data: {
            source: SubscriptionSource.STRIPE,
            status: nextStatus,
            currentPeriodStart: period.start,
            currentPeriodEnd: period.end,
            canceledAt: this.resolveCanceledAtForSubscription({
              subscription,
              nextStatus,
            }),
          },
        });
        return;
      }
      await prisma.subscription.create({
        data: {
          userId,
          plan: DEFAULT_SUBSCRIPTION_PLAN,
          source: SubscriptionSource.STRIPE,
          status: nextStatus,
          currentPeriodStart: period.start,
          currentPeriodEnd: period.end,
          canceledAt: this.resolveCanceledAtForSubscription({
            subscription,
            nextStatus,
          }),
          externalId: subscription.id,
        },
      });
    });
    await this.markUpgradeRequestAsFailedFromSubscriptionUpdate({
      userId,
      subscription,
    });
    await this.syncUserSubscriptionActivity(userId);
    this.logger.log(
      `Processed customer.subscription.updated subscription=${subscription.id} user=${userId} status=${nextStatus}`,
    );
  }

  private async handleSubscriptionPendingUpdateApplied(
    subscription: Stripe.Subscription,
  ): Promise<void> {
    const userId = await this.resolveUserIdForSubscription(subscription);
    if (!userId) {
      this.logger.warn(
        `Skipping customer.subscription.pending_update_applied ${subscription.id}: user missing`,
      );
      return;
    }
    const pendingUpgradeRequest =
      await this.findLatestPendingUpgradeRequestBySubscription({
        userId,
        stripeSubscriptionId: subscription.id,
      });
    if (!pendingUpgradeRequest?.id) {
      this.logger.log(
        `Ignoring pending_update_applied subscription=${subscription.id}: no pending upgrade request`,
      );
      return;
    }
    await this.prismaService.upgradeRequest.updateMany({
      where: {
        id: pendingUpgradeRequest.id,
        status: UpgradeRequestStatus.PENDING,
      },
      data: {
        status: UpgradeRequestStatus.COMPLETED,
        failureReason: null,
        resolvedAt: new Date(),
      },
    });
    this.logger.log(
      `Processed customer.subscription.pending_update_applied subscription=${subscription.id} upgradeRequest=${pendingUpgradeRequest.id}`,
    );
  }

  private async handleSubscriptionPendingUpdateExpired(
    subscription: Stripe.Subscription,
  ): Promise<void> {
    const userId = await this.resolveUserIdForSubscription(subscription);
    if (!userId) {
      this.logger.warn(
        `Skipping customer.subscription.pending_update_expired ${subscription.id}: user missing`,
      );
      return;
    }
    const pendingUpgradeRequest =
      await this.findLatestPendingUpgradeRequestBySubscription({
        userId,
        stripeSubscriptionId: subscription.id,
      });
    if (!pendingUpgradeRequest?.id) {
      this.logger.log(
        `Ignoring pending_update_expired subscription=${subscription.id}: no pending upgrade request`,
      );
      return;
    }
    await this.prismaService.upgradeRequest.updateMany({
      where: {
        id: pendingUpgradeRequest.id,
        status: UpgradeRequestStatus.PENDING,
      },
      data: {
        status: UpgradeRequestStatus.EXPIRED,
        failureReason: 'Pending update expired in Stripe',
        resolvedAt: new Date(),
      },
    });
    this.logger.log(
      `Processed customer.subscription.pending_update_expired subscription=${subscription.id} upgradeRequest=${pendingUpgradeRequest.id}`,
    );
  }

  private async handleSubscriptionDeleted(
    subscription: Stripe.Subscription,
  ): Promise<void> {
    const userId = await this.resolveUserIdForSubscription(subscription);
    if (!userId) {
      this.logger.warn(
        `Skipping customer.subscription.deleted ${subscription.id}: user missing`,
      );
      return;
    }
    await this.prismaService.subscription.updateMany({
      where: {
        userId,
        externalId: subscription.id,
      },
      data: {
        status: SubscriptionStatus.CANCELED,
        canceledAt: new Date(),
      },
    });
    await this.syncUserSubscriptionActivity(userId);
    this.logger.log(
      `Processed customer.subscription.deleted subscription=${subscription.id} user=${userId}`,
    );
  }

  private extractSubscriptionId(invoice: Stripe.Invoice): string | null {
    const invoiceRecord = invoice as unknown as Record<string, unknown>;
    const invoiceSubscription = invoiceRecord['subscription'];
    if (typeof invoiceSubscription === 'string') {
      return invoiceSubscription;
    }
    if (this.hasStringId(invoiceSubscription)) {
      return invoiceSubscription.id;
    }
    const subscriptionReference =
      invoice.parent?.subscription_details?.subscription;
    if (typeof subscriptionReference === 'string') {
      return subscriptionReference;
    }
    if (
      subscriptionReference &&
      typeof subscriptionReference === 'object' &&
      'id' in subscriptionReference &&
      typeof subscriptionReference.id === 'string'
    ) {
      return subscriptionReference.id;
    }
    return null;
  }

  private async resolveUserIdForInvoice(input: {
    readonly invoice: Stripe.Invoice;
    readonly subscriptionExternalId: string | null;
  }): Promise<string | null> {
    const metadataUserId =
      input.invoice.parent?.subscription_details?.metadata?.user_id;
    if (metadataUserId) {
      return metadataUserId;
    }
    if (!input.subscriptionExternalId) {
      return this.resolveUserIdFromStripeCustomer(input.invoice.customer);
    }
    const existingSubscription =
      await this.prismaService.subscription.findFirst({
        where: {
          externalId: input.subscriptionExternalId,
        },
        select: {
          userId: true,
        },
        orderBy: {
          createdAt: 'desc',
        },
      });
    if (existingSubscription?.userId) {
      this.logger.warn(
        `Resolved user from subscription fallback subscription=${input.subscriptionExternalId} user=${existingSubscription.userId}`,
      );
    }
    return existingSubscription?.userId ?? null;
  }

  private async resolveUserIdFromStripeCustomer(
    customerReference: string | Stripe.Customer | Stripe.DeletedCustomer | null,
  ): Promise<string | null> {
    const customerId = this.resolveStripeCustomerId(customerReference);
    if (!customerId) {
      return null;
    }
    const user = await this.prismaService.user.findFirst({
      where: {
        stripeCustomerId: customerId,
      },
      select: {
        id: true,
      },
    });
    return user?.id ?? null;
  }

  private resolveStripeCustomerId(
    customerReference: string | Stripe.Customer | Stripe.DeletedCustomer | null,
  ): string | null {
    if (typeof customerReference === 'string') {
      return customerReference;
    }
    if (!customerReference || typeof customerReference !== 'object') {
      return null;
    }
    if ('deleted' in customerReference && customerReference.deleted) {
      return null;
    }
    return customerReference.id;
  }

  private async markUpgradeRequestAsFailedFromSubscriptionUpdate(input: {
    readonly userId: string;
    readonly subscription: Stripe.Subscription;
  }): Promise<void> {
    if (this.shouldIgnoreUpgradeFailureFromSubscription(input.subscription)) {
      return;
    }
    const pendingUpgradeRequest =
      await this.findLatestPendingUpgradeRequestBySubscription({
        userId: input.userId,
        stripeSubscriptionId: input.subscription.id,
      });
    if (!pendingUpgradeRequest?.id) {
      return;
    }
    await this.prismaService.upgradeRequest.updateMany({
      where: {
        id: pendingUpgradeRequest.id,
        status: UpgradeRequestStatus.PENDING,
      },
      data: {
        status: UpgradeRequestStatus.FAILED,
        failureReason: `Stripe subscription updated with status=${input.subscription.status}`,
        resolvedAt: new Date(),
      },
    });
    this.logger.warn(
      `Marked upgrade as failed from customer.subscription.updated subscription=${input.subscription.id} upgradeRequest=${pendingUpgradeRequest.id}`,
    );
  }

  private shouldIgnoreUpgradeFailureFromSubscription(
    subscription: Stripe.Subscription,
  ): boolean {
    if (subscription.pending_update) {
      return true;
    }
    return !this.isStripeSubscriptionFailureStatus(subscription.status);
  }

  private isStripeSubscriptionFailureStatus(
    status: Stripe.Subscription.Status,
  ): boolean {
    return (
      status === PAST_DUE_STRIPE_SUBSCRIPTION_STATUS ||
      status === INCOMPLETE_STRIPE_SUBSCRIPTION_STATUS ||
      status === INCOMPLETE_EXPIRED_STRIPE_SUBSCRIPTION_STATUS ||
      status === UNPAID_STRIPE_SUBSCRIPTION_STATUS
    );
  }

  private findLatestPendingUpgradeRequestBySubscription(input: {
    readonly userId: string;
    readonly stripeSubscriptionId: string;
  }): Promise<{ readonly id: string } | null> {
    return this.prismaService.upgradeRequest.findFirst({
      where: {
        userId: input.userId,
        stripeSubscriptionId: input.stripeSubscriptionId,
        status: UpgradeRequestStatus.PENDING,
      },
      select: {
        id: true,
      },
      orderBy: {
        createdAt: 'desc',
      },
    });
  }

  private async attachStripeCustomerToUser(input: {
    readonly userId: string | null;
    readonly customerReference:
      | string
      | Stripe.Customer
      | Stripe.DeletedCustomer
      | null;
  }): Promise<void> {
    if (!input.userId) {
      return;
    }
    const customerId = this.resolveStripeCustomerId(input.customerReference);
    if (!customerId) {
      return;
    }
    await this.prismaService.user.update({
      where: {
        id: input.userId,
      },
      data: {
        stripeCustomerId: customerId,
      },
    });
  }

  private async resolveUserIdForSubscription(
    subscription: Stripe.Subscription,
  ): Promise<string | null> {
    const metadataUserId = subscription.metadata?.user_id;
    if (metadataUserId) {
      return metadataUserId;
    }
    const existingSubscription =
      await this.prismaService.subscription.findFirst({
        where: {
          externalId: subscription.id,
        },
        select: {
          userId: true,
        },
        orderBy: {
          createdAt: 'desc',
        },
      });
    if (existingSubscription?.userId) {
      this.logger.warn(
        `Resolved user from subscription fallback subscription=${subscription.id} user=${existingSubscription.userId}`,
      );
    }
    return existingSubscription?.userId ?? null;
  }

  private resolveInvoicePeriod(input: {
    readonly invoice: Stripe.Invoice;
    readonly subscriptionExternalId: string;
  }): { readonly start: Date; readonly end: Date } {
    void input.subscriptionExternalId;
    const invoiceLines = input.invoice.lines.data;
    const invoiceLinesWithPeriod = invoiceLines.filter((lineItem) => {
      return (
        typeof lineItem.period?.start === 'number' &&
        typeof lineItem.period?.end === 'number'
      );
    });
    const lineItem =
      invoiceLinesWithPeriod.find((currentLineItem) => {
        return currentLineItem.amount > 0;
      }) ??
      invoiceLinesWithPeriod.reduce<Stripe.InvoiceLineItem | null>(
        (latestLineItem, currentLineItem) => {
          if (!latestLineItem) {
            return currentLineItem;
          }
          return currentLineItem.period.end > latestLineItem.period.end
            ? currentLineItem
            : latestLineItem;
        },
        null,
      );
    const periodStart = lineItem?.period?.start;
    const periodEnd = lineItem?.period?.end;
    if (typeof periodStart === 'number' && typeof periodEnd === 'number') {
      return {
        start: this.fromUnixTimestamp(periodStart),
        end: this.fromUnixTimestamp(periodEnd),
      };
    }
    const now = new Date();
    return {
      start: now,
      end: new Date(now.getTime() + THIRTY_DAYS_IN_MILLISECONDS),
    };
  }

  private resolveInvoiceAmount(invoice: Stripe.Invoice): number {
    const amountPaid = invoice.amount_paid ?? invoice.amount_due ?? 0;
    return amountPaid / 100;
  }

  private resolveInvoiceCurrency(invoice: Stripe.Invoice): string {
    return (invoice.currency ?? 'usd').toUpperCase();
  }

  private mapStripeSubscriptionStatus(
    stripeStatus: Stripe.Subscription.Status,
  ): SubscriptionStatus | null {
    if (
      stripeStatus === ACTIVE_STRIPE_SUBSCRIPTION_STATUS ||
      stripeStatus === TRIALING_STRIPE_SUBSCRIPTION_STATUS
    ) {
      return SubscriptionStatus.ACTIVE;
    }
    if (stripeStatus === PAST_DUE_STRIPE_SUBSCRIPTION_STATUS) {
      return SubscriptionStatus.PAST_DUE;
    }
    if (
      stripeStatus === INCOMPLETE_STRIPE_SUBSCRIPTION_STATUS ||
      stripeStatus === UNPAID_STRIPE_SUBSCRIPTION_STATUS ||
      stripeStatus === PAUSED_STRIPE_SUBSCRIPTION_STATUS
    ) {
      return SubscriptionStatus.PAST_DUE;
    }
    if (stripeStatus === CANCELED_STRIPE_SUBSCRIPTION_STATUS) {
      return SubscriptionStatus.CANCELED;
    }
    if (stripeStatus === INCOMPLETE_EXPIRED_STRIPE_SUBSCRIPTION_STATUS) {
      return SubscriptionStatus.EXPIRED;
    }
    return null;
  }

  private resolveSubscriptionPeriod(subscription: Stripe.Subscription): {
    readonly start: Date;
    readonly end: Date;
  } {
    const subscriptionRecord = subscription as unknown as Record<
      string,
      unknown
    >;
    const currentPeriodStart = subscriptionRecord['current_period_start'];
    const currentPeriodEnd = subscriptionRecord['current_period_end'];
    if (
      typeof currentPeriodStart === 'number' &&
      typeof currentPeriodEnd === 'number'
    ) {
      return {
        start: this.fromUnixTimestamp(currentPeriodStart),
        end: this.fromUnixTimestamp(currentPeriodEnd),
      };
    }
    const now = new Date();
    return {
      start: now,
      end: new Date(now.getTime() + THIRTY_DAYS_IN_MILLISECONDS),
    };
  }

  private resolveCanceledAtForSubscription(input: {
    readonly subscription: Stripe.Subscription;
    readonly nextStatus: SubscriptionStatus;
  }): Date | null {
    if (input.nextStatus !== SubscriptionStatus.CANCELED) {
      return null;
    }
    const canceledAtTimestamp = input.subscription.canceled_at;
    if (typeof canceledAtTimestamp === 'number') {
      return this.fromUnixTimestamp(canceledAtTimestamp);
    }
    return new Date();
  }

  private hasStringId(value: unknown): value is StripeObjectWithId {
    if (!value || typeof value !== 'object' || !('id' in value)) {
      return false;
    }
    return typeof value.id === 'string';
  }

  private fromUnixTimestamp(timestamp: number): Date {
    return new Date(timestamp * 1000);
  }

  private resolveCurrentMonthRange(): {
    readonly monthStart: Date;
    readonly monthEnd: Date;
  } {
    const now = new Date();
    const monthStart = new Date(
      now.getFullYear(),
      now.getMonth(),
      1,
      0,
      0,
      0,
      0,
    );
    const monthEnd = new Date(
      now.getFullYear(),
      now.getMonth() + 1,
      1,
      0,
      0,
      0,
      0,
    );
    return {
      monthStart,
      monthEnd,
    };
  }

  private async syncUserSubscriptionActivity(userId: string): Promise<void> {
    const now = new Date();
    const activeSubscription = await this.prismaService.subscription.findFirst({
      where: {
        userId,
        status: SubscriptionStatus.ACTIVE,
        currentPeriodEnd: {
          gt: now,
        },
      },
      select: {
        currentPeriodEnd: true,
      },
      orderBy: {
        currentPeriodEnd: 'desc',
      },
    });
    await this.prismaService.user.update({
      where: {
        id: userId,
      },
      data: {
        subscriptionActive: Boolean(activeSubscription),
        subscriptionEnd: activeSubscription?.currentPeriodEnd ?? null,
      },
    });
  }
}
