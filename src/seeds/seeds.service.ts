import { Injectable } from '@nestjs/common';
import { hash } from 'bcrypt';

import {
  Role,
  SubscriptionPlan,
  SubscriptionStatus,
} from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';

const GENRE_NAMES: readonly string[] = [
  'House',
  'Tech House',
  'Techno',
  'Afro House',
  'Hip Hop',
  'Latin',
  'Drum & Bass',
  'Open Format',
] as const;

const SEED_USERS_PASSWORD = '123456789';
const PASSWORD_SALT_ROUNDS = 12;
const DEFAULT_SUBSCRIPTION_DURATION_MONTHS = 1;
const DEFAULT_SUBSCRIPTION_PLAN: SubscriptionPlan = SubscriptionPlan.PREMIUM;
const SCENARIO_SUBSCRIPTION_START = new Date('2026-01-10T00:00:00.000Z');
const SCENARIO_SUBSCRIPTION_MONTHS = 3;
const SCENARIO_VIDEO_IDS: readonly string[] = [
  '13be70d7-4cee-408b-816c-07032c527c71',
  '5d6270e6-49f9-473e-b6a4-5ab06d140245',
  'bb2c76be-9352-4716-aac5-9a2954c8abf1',
  'da4ade6c-294a-4159-a564-4e385c27bb44',
] as const;

interface SeedUserConfig {
  readonly email: string;
  readonly name: string;
  readonly role?: Role;
  readonly hasActiveSubscription?: boolean;
  readonly subscriptionStartAt?: Date;
  readonly subscriptionDurationMonths?: number;
  readonly seedMonthlyDownloadScenario?: boolean;
}

const SEED_USERS: readonly SeedUserConfig[] = [
  {
    email: 'alejandro.admin@djonly.test',
    name: 'Alejandro Admin',
    role: Role.ADMIN,
    hasActiveSubscription: true,
  },
  {
    email: 'maria.premium@djonly.test',
    name: 'María Premium',
    hasActiveSubscription: true,
    subscriptionStartAt: SCENARIO_SUBSCRIPTION_START,
    subscriptionDurationMonths: SCENARIO_SUBSCRIPTION_MONTHS,
    seedMonthlyDownloadScenario: true,
  },
  {
    email: 'carlos.premium@djonly.test',
    name: 'Carlos Premium',
    hasActiveSubscription: true,
  },
  {
    email: 'lucia.free@djonly.test',
    name: 'Lucía Free',
  },
  {
    email: 'juan.free@djonly.test',
    name: 'Juan Free',
  },
] as const;

export interface SeedGenresResponse {
  readonly inserted: number;
}

export interface SeedUsersResponse {
  readonly inserted: number;
  readonly subscriptionsCreated: number;
}

interface SubscriptionPeriodInput {
  readonly startAt: Date;
  readonly durationMonths: number;
}

/**
 * SeedsService centralizes DB seeding routines backed by Prisma.
 */
@Injectable()
export class SeedsService {
  constructor(private readonly prismaService: PrismaService) {}

  /**
   * Insert default genres ensuring idempotency.
   */
  async seedGenres(): Promise<SeedGenresResponse> {
    const result = await this.prismaService.genre.createMany({
      data: GENRE_NAMES.map((name) => ({ name })),
      skipDuplicates: true,
    });
    return { inserted: result.count };
  }

  async seedUsers(): Promise<SeedUsersResponse> {
    const hashPassword: HashPasswordFn = hash as HashPasswordFn;
    const hashedPassword = await hashPassword(
      SEED_USERS_PASSWORD,
      PASSWORD_SALT_ROUNDS,
    );
    let inserted = 0;
    let subscriptionsCreated = 0;
    for (const seedUser of SEED_USERS) {
      const existingUser = await this.prismaService.user.findUnique({
        where: { email: seedUser.email },
      });
      const userRecord = existingUser
        ? existingUser
        : await this.prismaService.user.create({
            data: {
              email: seedUser.email,
              password: hashedPassword,
              name: seedUser.name,
              role: seedUser.role ?? Role.USER,
              emailVerified: true,
            },
          });
      if (!existingUser) {
        inserted += 1;
      }
      if (!seedUser.hasActiveSubscription) {
        continue;
      }
      const createdSubscription = await this.ensureActiveSubscription(
        userRecord.id,
        seedUser,
      );
      if (createdSubscription) {
        subscriptionsCreated += 1;
      }
      if (seedUser.seedMonthlyDownloadScenario) {
        await this.seedMonthlyDownloadScenario(userRecord.id, seedUser);
      }
    }
    return { inserted, subscriptionsCreated };
  }

  private buildSubscriptionPeriod(input: SubscriptionPeriodInput): {
    readonly start: Date;
    readonly end: Date;
  } {
    const start = new Date(input.startAt);
    const end = new Date(input.startAt);
    end.setMonth(end.getMonth() + input.durationMonths);
    return { start, end };
  }

  private async ensureActiveSubscription(
    userId: string,
    seedUser: SeedUserConfig,
  ): Promise<boolean> {
    const now = seedUser.subscriptionStartAt
      ? new Date(seedUser.subscriptionStartAt)
      : new Date();
    const durationMonths =
      seedUser.subscriptionDurationMonths ??
      DEFAULT_SUBSCRIPTION_DURATION_MONTHS;
    const { start, end } = this.buildSubscriptionPeriod({
      startAt: now,
      durationMonths,
    });
    const existingSubscription =
      await this.prismaService.subscription.findFirst({
        where: {
          userId,
          status: SubscriptionStatus.ACTIVE,
          currentPeriodEnd: { gte: start },
        },
        select: { id: true },
      });
    if (existingSubscription) {
      await this.prismaService.subscription.update({
        where: { id: existingSubscription.id },
        data: {
          plan: DEFAULT_SUBSCRIPTION_PLAN,
          currentPeriodStart: start,
          currentPeriodEnd: end,
          status: SubscriptionStatus.ACTIVE,
        },
      });
      await this.prismaService.user.update({
        where: { id: userId },
        data: {
          subscriptionActive: true,
          subscriptionEnd: end,
        },
      });
      return false;
    }
    await this.prismaService.subscription.create({
      data: {
        userId,
        plan: DEFAULT_SUBSCRIPTION_PLAN,
        status: SubscriptionStatus.ACTIVE,
        currentPeriodStart: start,
        currentPeriodEnd: end,
      },
    });
    await this.prismaService.user.update({
      where: { id: userId },
      data: {
        subscriptionActive: true,
        subscriptionEnd: end,
      },
    });
    return true;
  }

  private async seedMonthlyDownloadScenario(
    userId: string,
    seedUser: SeedUserConfig,
  ): Promise<void> {
    const scenarioStartAt = seedUser.subscriptionStartAt;
    if (!scenarioStartAt) {
      return;
    }
    const existingVideos = await this.prismaService.video.findMany({
      where: {
        id: {
          in: [...SCENARIO_VIDEO_IDS],
        },
      },
      select: {
        id: true,
      },
    });
    const existingVideoIds = new Set(existingVideos.map((video) => video.id));
    const primaryVideoId = SCENARIO_VIDEO_IDS[0];
    if (!existingVideoIds.has(primaryVideoId)) {
      return;
    }
    await this.prismaService.downloadHistory.deleteMany({
      where: {
        userId,
        videoId: {
          in: [...existingVideoIds],
        },
      },
    });
    const monthOneDate = this.addDaysToDate(scenarioStartAt, 5);
    const monthTwoStart = this.addMonthsToDate(scenarioStartAt, 1);
    const monthTwoDownloadA = this.addDaysToDate(monthTwoStart, 2);
    const monthTwoDownloadB = this.addDaysToDate(monthTwoStart, 7);
    const downloadEntries = [
      {
        userId,
        videoId: primaryVideoId,
        downloadedAt: monthOneDate,
      },
      {
        userId,
        videoId: primaryVideoId,
        downloadedAt: monthTwoDownloadA,
      },
      {
        userId,
        videoId: primaryVideoId,
        downloadedAt: monthTwoDownloadB,
      },
    ];
    await this.prismaService.downloadHistory.createMany({
      data: downloadEntries,
    });
  }

  private addMonthsToDate(date: Date, months: number): Date {
    const result = new Date(date);
    result.setMonth(result.getMonth() + months);
    return result;
  }

  private addDaysToDate(date: Date, days: number): Date {
    const result = new Date(date);
    result.setDate(result.getDate() + days);
    return result;
  }
}

type HashPasswordFn = (
  plainPassword: string,
  saltOrRounds: string | number,
) => Promise<string>;
