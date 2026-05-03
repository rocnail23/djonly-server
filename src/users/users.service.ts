import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import {
  PaymentStatus,
  Prisma,
  Role,
  SubscriptionPlan,
  SubscriptionSource,
  SubscriptionStatus,
} from 'src/generated/prisma/client';
import { UpdateUserDto } from './dto/update-user.dto';
import { PrismaService } from 'src/prisma/prisma.service';
import {
  StripeBillingPortalSessionResponse,
  StripeInvoiceSummary,
  StripeService,
} from 'src/stripe/stripe.service';
import { envs } from 'src/config/envs';

type UserRecord = Awaited<ReturnType<PrismaService['user']['findUnique']>>;
type ExistingUser = NonNullable<UserRecord>;

interface CreateUserOptions {
  readonly email: string;
  readonly password: string;
  readonly name?: string;
  readonly emailVerified?: boolean;
}

interface AdminUsersQueryInput {
  readonly page: number;
  readonly limit: number;
  readonly search?: string;
  readonly subscriptionStatus?: SubscriptionStatus;
}

interface UpdateAdminUserRoleInput {
  readonly userId: string;
  readonly role: Role;
}

interface GrantManualSubscriptionInput {
  readonly userId: string;
  readonly months: number;
}

interface ListCurrentUserStripeInvoicesInput {
  readonly userId: string;
  readonly page: number;
  readonly limit: number;
}

interface CurrentUserSubscriptionSummary {
  readonly plan: SubscriptionPlan;
  readonly source: SubscriptionSource;
  readonly currentPeriodStart: Date;
  readonly currentPeriodEnd: Date;
  readonly amount: number | null;
  readonly currency: string | null;
  readonly interval: string | null;
  readonly intervalCount: number | null;
}

export interface AdminUserListItem {
  readonly id: string;
  readonly email: string;
  readonly name: string | null;
  readonly role: Role;
  readonly stripeCustomerId: string | null;
  readonly createdAt: Date;
  readonly subscriptionStatus: SubscriptionStatus | null;
  readonly subscriptionSource: SubscriptionSource | null;
  readonly subscriptionExternalId: string | null;
  readonly subscriptionEnd: Date | null;
}

export interface AdminStripeInvoiceItem {
  readonly id: string;
  readonly number: string | null;
  readonly status: string | null;
  readonly amountPaid: number;
  readonly amountDue: number;
  readonly currency: string;
  readonly hostedInvoiceUrl: string | null;
  readonly invoicePdfUrl: string | null;
  readonly createdAt: Date;
}

export interface StripeBillingPortalResponse {
  readonly url: string;
}

export interface PaginatedStripeInvoicesResponse {
  readonly items: readonly AdminStripeInvoiceItem[];
  readonly page: number;
  readonly limit: number;
  readonly total: number;
  readonly totalPages: number;
}

export interface PaginatedAdminUsersResponse {
  readonly items: readonly AdminUserListItem[];
  readonly page: number;
  readonly limit: number;
  readonly total: number;
  readonly totalPages: number;
}

export interface AdminUsersStatsResponse {
  readonly totalUsers: number;
  readonly activeSubscriptions: number;
  readonly expiredSubscriptions: number;
  readonly canceledSubscriptions: number;
}

export interface AdminDashboardSaleItem {
  readonly id: string;
  readonly customerEmail: string;
  readonly amount: number;
  readonly currency: string;
  readonly status: PaymentStatus;
  readonly createdAt: Date;
  readonly plan: string | null;
}

export interface AdminDashboardRecentUserItem {
  readonly id: string;
  readonly email: string;
  readonly name: string | null;
  readonly role: Role;
  readonly createdAt: Date;
}

export interface AdminDashboardResponse {
  readonly monthlyRevenue: number;
  readonly monthlyUsers: number;
  readonly monthlyDownloads: number;
  readonly latestSales: readonly AdminDashboardSaleItem[];
  readonly latestUsers: readonly AdminDashboardRecentUserItem[];
}

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  public constructor(
    private readonly prisma: PrismaService,
    private readonly stripeService: StripeService,
  ) {}

  public async listAdminUsers(
    query: AdminUsersQueryInput,
  ): Promise<PaginatedAdminUsersResponse> {
    const safePage = query.page >= 1 ? query.page : 1;
    const safeLimit = query.limit >= 1 ? query.limit : 10;
    const skip = (safePage - 1) * safeLimit;
    const whereClause = this.buildAdminUsersWhereClause(query);
    const [users, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where: whereClause,
        orderBy: {
          createdAt: 'desc',
        },
        skip,
        take: safeLimit,
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          stripeCustomerId: true,
          createdAt: true,
          subscriptions: {
            orderBy: {
              createdAt: 'desc',
            },
            take: 1,
            select: {
              status: true,
              source: true,
              externalId: true,
              currentPeriodEnd: true,
            },
          },
        },
      }),
      this.prisma.user.count({
        where: whereClause,
      }),
    ]);
    const items: readonly AdminUserListItem[] = users.map((user) => {
      const latestSubscription = user.subscriptions[0];
      return {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        stripeCustomerId: user.stripeCustomerId,
        createdAt: user.createdAt,
        subscriptionStatus: latestSubscription?.status ?? null,
        subscriptionSource: latestSubscription?.source ?? null,
        subscriptionExternalId: latestSubscription?.externalId ?? null,
        subscriptionEnd: latestSubscription?.currentPeriodEnd ?? null,
      };
    });
    return {
      items,
      page: safePage,
      limit: safeLimit,
      total,
      totalPages: Math.max(1, Math.ceil(total / safeLimit)),
    };
  }

  public async updateAdminUserRole(
    input: UpdateAdminUserRoleInput,
  ): Promise<void> {
    await this.assertUserExists(input.userId);
    await this.prisma.user.update({
      where: {
        id: input.userId,
      },
      data: {
        role: input.role,
      },
    });
  }

  public async grantManualSubscription(
    input: GrantManualSubscriptionInput,
  ): Promise<void> {
    const allowedMonths = [1, 3, 6] as const;
    if (
      !allowedMonths.includes(input.months as (typeof allowedMonths)[number])
    ) {
      throw new BadRequestException(
        'Duración inválida para suscripción manual',
      );
    }
    await this.assertUserExists(input.userId);
    const existingStripeSubscription = await this.prisma.subscription.findFirst({
      where: {
        userId: input.userId,
        source: SubscriptionSource.STRIPE,
        status: {
          in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.PAST_DUE],
        },
      },
      select: {
        id: true,
      },
    });
    if (existingStripeSubscription) {
      throw new BadRequestException(
        'No se puede otorgar una suscripción manual si existe una suscripción Stripe activa',
      );
    }
    const now = new Date();
    const periodEnd = new Date(now);
    periodEnd.setMonth(periodEnd.getMonth() + input.months);
    await this.prisma.$transaction(async (prisma) => {
      await prisma.subscription.updateMany({
        where: {
          userId: input.userId,
          status: {
            in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.PAST_DUE],
          },
        },
        data: {
          status: SubscriptionStatus.EXPIRED,
        },
      });
      await prisma.subscription.create({
        data: {
          userId: input.userId,
          plan: SubscriptionPlan.PREMIUM,
          source: SubscriptionSource.MANUAL,
          status: SubscriptionStatus.ACTIVE,
          currentPeriodStart: now,
          currentPeriodEnd: periodEnd,
        },
      });
    });
    await this.syncUserSubscriptionActivity(input.userId);
  }

  public async cancelSubscriptionAsAdmin(userId: string): Promise<void> {
    await this.assertUserExists(userId);
    const subscriptions = await this.prisma.subscription.findMany({
      where: {
        userId,
        status: {
          in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.PAST_DUE],
        },
      },
      select: {
        id: true,
        source: true,
        externalId: true,
      },
    });
    for (const subscription of subscriptions) {
      if (
        subscription.source === SubscriptionSource.STRIPE &&
        subscription.externalId
      ) {
        await this.stripeService.cancelSubscriptionImmediately(
          subscription.externalId,
        );
      }
    }
    await this.prisma.subscription.updateMany({
      where: {
        userId,
        status: {
          in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.PAST_DUE],
        },
      },
      data: {
        status: SubscriptionStatus.CANCELED,
        currentPeriodEnd: new Date(),
        canceledAt: new Date(),
      },
    });
    await this.syncUserSubscriptionActivity(userId);
  }

  public async listStripeInvoicesForAdmin(
    userId: string,
  ): Promise<readonly AdminStripeInvoiceItem[]> {
    const user = await this.prisma.user.findUnique({
      where: {
        id: userId,
      },
      select: {
        stripeCustomerId: true,
      },
    });
    if (!user) {
      throw new NotFoundException('Usuario no encontrado');
    }
    if (!user.stripeCustomerId) {
      return [];
    }
    const invoices: readonly StripeInvoiceSummary[] =
      await this.stripeService.listInvoicesByCustomer(user.stripeCustomerId);
    return invoices;
  }

  public async listStripeInvoicesForCurrentUser(
    input: ListCurrentUserStripeInvoicesInput,
  ): Promise<PaginatedStripeInvoicesResponse> {
    const safePage = input.page >= 1 ? input.page : 1;
    const safeLimit = input.limit >= 1 ? input.limit : 10;
    const user = await this.prisma.user.findUnique({
      where: {
        id: input.userId,
      },
      select: {
        stripeCustomerId: true,
      },
    });
    if (!user) {
      throw new NotFoundException('Usuario no encontrado');
    }
    if (!user.stripeCustomerId) {
      return {
        items: [],
        page: safePage,
        limit: safeLimit,
        total: 0,
        totalPages: 1,
      };
    }
    const invoices: readonly StripeInvoiceSummary[] =
      await this.stripeService.listInvoicesByCustomer(user.stripeCustomerId);
    const total = invoices.length;
    const skip = (safePage - 1) * safeLimit;
    const items = invoices.slice(skip, skip + safeLimit);
    return {
      items,
      page: safePage,
      limit: safeLimit,
      total,
      totalPages: Math.max(1, Math.ceil(total / safeLimit)),
    };
  }

  public async createStripeBillingPortalForUser(
    userId: string,
  ): Promise<StripeBillingPortalResponse> {
    const customerId = await this.getStripeCustomerIdByUserIdOrThrow(userId);
    const portal: StripeBillingPortalSessionResponse =
      await this.stripeService.createBillingPortalSession({
        customerId,
        returnUrl: this.resolveBillingPortalReturnUrl(),
      });
    return {
      url: portal.url,
    };
  }

  private async getStripeCustomerIdByUserIdOrThrow(
    userId: string,
  ): Promise<string> {
    const user = await this.prisma.user.findUnique({
      where: {
        id: userId,
      },
      select: {
        stripeCustomerId: true,
      },
    });
    if (!user) {
      throw new NotFoundException('Usuario no encontrado');
    }
    if (!user.stripeCustomerId) {
      throw new BadRequestException(
        'El usuario no tiene cliente Stripe asociado',
      );
    }
    return user.stripeCustomerId;
  }

  private resolveBillingPortalReturnUrl(): string {
    const frontendUrl = envs.FRONTEND_URL ?? 'http://localhost:3000';
    return frontendUrl.endsWith('/') ? frontendUrl.slice(0, -1) : frontendUrl;
  }

  public async getAdminUsersStats(): Promise<AdminUsersStatsResponse> {
    const now = new Date();
    const [
      totalUsers,
      activeSubscriptions,
      expiredSubscriptions,
      canceledSubscriptions,
    ] = await this.prisma.$transaction([
      this.prisma.user.count(),
      this.prisma.subscription.count({
        where: {
          status: SubscriptionStatus.ACTIVE,
          currentPeriodEnd: {
            gt: now,
          },
        },
      }),
      this.prisma.subscription.count({
        where: {
          status: SubscriptionStatus.EXPIRED,
        },
      }),
      this.prisma.subscription.count({
        where: {
          status: SubscriptionStatus.CANCELED,
        },
      }),
    ]);
    return {
      totalUsers,
      activeSubscriptions,
      expiredSubscriptions,
      canceledSubscriptions,
    };
  }

  public async getAdminDashboard(): Promise<AdminDashboardResponse> {
    const monthRange = this.resolveCurrentMonthRange();
    const [
      monthlyRevenueAggregate,
      monthlyUsers,
      monthlyDownloads,
      latestSalesRows,
      latestUsers,
    ] = await this.prisma.$transaction([
      this.prisma.payment.aggregate({
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
      this.prisma.user.count({
        where: {
          createdAt: {
            gte: monthRange.monthStart,
            lt: monthRange.monthEnd,
          },
        },
      }),
      this.prisma.downloadHistory.count({
        where: {
          downloadedAt: {
            gte: monthRange.monthStart,
            lt: monthRange.monthEnd,
          },
        },
      }),
      this.prisma.payment.findMany({
        orderBy: {
          createdAt: 'desc',
        },
        take: 5,
        include: {
          user: {
            select: {
              email: true,
            },
          },
          subscription: {
            select: {
              plan: true,
            },
          },
        },
      }),
      this.prisma.user.findMany({
        orderBy: {
          createdAt: 'desc',
        },
        take: 5,
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          createdAt: true,
        },
      }),
    ]);
    const latestSales: readonly AdminDashboardSaleItem[] = latestSalesRows.map(
      (sale) => ({
        id: sale.id,
        customerEmail: sale.user.email,
        amount: sale.amount,
        currency: sale.currency,
        status: sale.status,
        createdAt: sale.createdAt,
        plan: sale.subscription?.plan ?? null,
      }),
    );
    return {
      monthlyRevenue: monthlyRevenueAggregate._sum.amount ?? 0,
      monthlyUsers,
      monthlyDownloads,
      latestSales,
      latestUsers,
    };
  }

  public async findByEmail(email: string): Promise<ExistingUser | null> {
    const user = await this.prisma.user.findUnique({
      where: { email },
    });

    return user;
  }

  public async findCurrentUserSubscriptionSummary(
    userId: string,
  ): Promise<CurrentUserSubscriptionSummary | null> {
    const subscription = await this.prisma.subscription.findFirst({
      where: {
        userId,
        status: {
          in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.PAST_DUE],
        },
      },
      orderBy: {
        currentPeriodEnd: 'desc',
      },
      select: {
        plan: true,
        source: true,
        externalId: true,
        currentPeriodStart: true,
        currentPeriodEnd: true,
      },
    });
    if (!subscription) {
      return null;
    }
    let amount: number | null = null;
    let currency: string | null = null;
    let interval: string | null = null;
    let intervalCount: number | null = null;
    if (
      subscription.source === SubscriptionSource.STRIPE &&
      subscription.externalId
    ) {
      try {
        const stripeSubscription =
          await this.stripeService.retrieveSubscription(
            subscription.externalId,
          );
        const stripePrice = stripeSubscription.items.data[0]?.price;
        amount =
          typeof stripePrice?.unit_amount === 'number'
            ? stripePrice.unit_amount / 100
            : null;
        currency = stripePrice?.currency
          ? stripePrice.currency.toUpperCase()
          : null;
        interval = stripePrice?.recurring?.interval ?? null;
        intervalCount = stripePrice?.recurring?.interval_count ?? null;
      } catch (error: unknown) {
        this.logger.warn(
          `Unable to read Stripe subscription amount user=${userId}`,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    return {
      plan: subscription.plan,
      source: subscription.source,
      currentPeriodStart: subscription.currentPeriodStart,
      currentPeriodEnd: subscription.currentPeriodEnd,
      amount,
      currency,
      interval,
      intervalCount,
    };
  }

  public async findById(userId: string): Promise<ExistingUser | null> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    return user;
  }

  public async createUser(options: CreateUserOptions): Promise<ExistingUser> {
    return this.prisma.user.create({
      data: {
        email: options.email,
        password: options.password,
        name: options.name,
        emailVerified: options.emailVerified,
      },
    });
  }

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  public async expireManualSubscriptionsDaily(): Promise<void> {
    const now = new Date();
    const manualSubscriptions = await this.prisma.subscription.findMany({
      where: {
        source: SubscriptionSource.MANUAL,
        status: SubscriptionStatus.ACTIVE,
        currentPeriodEnd: {
          lte: now,
        },
      },
      select: {
        userId: true,
      },
      distinct: ['userId'],
    });
    if (manualSubscriptions.length === 0) {
      return;
    }
    await this.prisma.subscription.updateMany({
      where: {
        source: SubscriptionSource.MANUAL,
        status: SubscriptionStatus.ACTIVE,
        currentPeriodEnd: {
          lte: now,
        },
      },
      data: {
        status: SubscriptionStatus.EXPIRED,
      },
    });
    for (const manualSubscription of manualSubscriptions) {
      await this.syncUserSubscriptionActivity(manualSubscription.userId);
    }
    this.logger.log(
      `Expired manual subscriptions users=${manualSubscriptions.length}`,
    );
  }

  public async updatePassword(
    userId: string,
    password: string,
  ): Promise<ExistingUser> {
    return this.prisma.user.update({
      where: { id: userId },
      data: {
        password,
      },
    });
  }

  public async markEmailAsVerified(userId: string): Promise<ExistingUser> {
    return this.prisma.user.update({
      where: { id: userId },
      data: {
        emailVerified: true,
      },
    });
  }

  public async updateUser(
    userId: string,
    payload: UpdateUserDto,
  ): Promise<ExistingUser> {
    const existingUser = await this.findById(userId);
    if (!existingUser) {
      throw new UnauthorizedException(
        'No estás autorizado para editar este usuario',
      );
    }
    return this.prisma.user.update({
      where: { id: userId },
      data: {
        name: payload.username,
      },
    });
  }

  private buildAdminUsersWhereClause(
    query: AdminUsersQueryInput,
  ): Prisma.UserWhereInput {
    const trimmedSearch = query.search?.trim();
    const shouldFilterBySearch = Boolean(trimmedSearch);
    const whereClause: Prisma.UserWhereInput = {
      OR: shouldFilterBySearch
        ? [
            {
              email: {
                contains: trimmedSearch as string,
                mode: 'insensitive',
              },
            },
            {
              name: {
                contains: trimmedSearch as string,
                mode: 'insensitive',
              },
            },
          ]
        : undefined,
      subscriptions: query.subscriptionStatus
        ? {
            some: {
              status: query.subscriptionStatus,
            },
          }
        : undefined,
    };
    return whereClause;
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

  private async assertUserExists(userId: string): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: {
        id: userId,
      },
      select: {
        id: true,
      },
    });
    if (!user) {
      throw new NotFoundException('Usuario no encontrado');
    }
  }

  private async syncUserSubscriptionActivity(userId: string): Promise<void> {
    const now = new Date();
    const activeSubscription = await this.prisma.subscription.findFirst({
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
    await this.prisma.user.update({
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
