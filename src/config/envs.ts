import { z } from 'zod';
import 'dotenv/config';

function normalizeOptionalString(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value;
  }
  const trimmedValue = value.trim();
  if (!trimmedValue) {
    return undefined;
  }
  return trimmedValue;
}

const envSchema = z
  .object({
    PORT: z.coerce.number().int().min(1).max(65535).default(3002),
    DATABASE_URL: z.string().min(1),
    FRONTEND_URL: z.string().url().optional(),
    JWT_SECRET: z.string().min(32),
    JWT_EXPIRES_IN: z.string().min(1).default('15m'),
    RESEND_API_KEY: z.string(),
    RESEND_FROM_EMAIL: z.string(),
    EMAIL_SUPPORT: z.string(),
    STRIPE_SECRET_KEY: z.preprocess(
      normalizeOptionalString,
      z.string().min(1).optional(),
    ),
    STRIPE_WEBHOOK_SECRET: z.preprocess(
      normalizeOptionalString,
      z.string().min(1).optional(),
    ),
    STRIPE_SUCCESS_URL: z.preprocess(
      normalizeOptionalString,
      z.string().url().optional(),
    ),
    STRIPE_CANCEL_URL: z.preprocess(
      normalizeOptionalString,
      z.string().url().optional(),
    ),
    R2_ACCOUNT_ID: z.string(),
    R2_ACCESS_KEY_ID: z.string(),
    R2_SECRET_ACCESS_KEY: z.string(),
    R2_BUCKET: z.preprocess(normalizeOptionalString, z.string().optional()),
    R2_PRIVATE_BUCKET: z.preprocess(
      normalizeOptionalString,
      z.string().optional(),
    ),
    R2_PUBLIC_BUCKET: z.preprocess(
      normalizeOptionalString,
      z.string().optional(),
    ),
    R2_REGION: z.string().default('auto'),
    R2_PUBLIC_BASE_URL: z.string().url(),
    REDIS_HOST: z.preprocess(
      normalizeOptionalString,
      z.string().default('redis'),
    ),
    REDIS_PORT: z.preprocess((value: unknown) => {
      const normalizedValue = normalizeOptionalString(value);
      return normalizedValue ?? 6379;
    }, z.coerce.number().int().min(1).max(65535)),
    REDIS_PASSWORD: z.preprocess(
      normalizeOptionalString,
      z.string().optional(),
    ),
    VIDEO_PROCESSING_CONCURRENCY: z.preprocess((value: unknown) => {
      const normalizedValue = normalizeOptionalString(value);
      return normalizedValue ?? 2;
    }, z.coerce.number().int().min(1).max(8)),
  })
  .passthrough();

type EnvironmentVariables = z.output<typeof envSchema>;
const parseResult = envSchema.safeParse({ ...process.env });
if (!parseResult.success) {
  const issues = parseResult.error.issues
    .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
    .join('; ');
  throw new Error(`Environment validation error: ${issues}`);
}

const environmentVariables: EnvironmentVariables = parseResult.data;
const stripeSecretKey = environmentVariables.STRIPE_SECRET_KEY;
const stripeWebhookSecret = environmentVariables.STRIPE_WEBHOOK_SECRET;
const privateBucket =
  environmentVariables.R2_PRIVATE_BUCKET ?? environmentVariables.R2_BUCKET;
const publicBucket =
  environmentVariables.R2_PUBLIC_BUCKET ?? environmentVariables.R2_BUCKET;
if (!privateBucket || !publicBucket) {
  throw new Error(
    'Environment validation error: define R2_PRIVATE_BUCKET and R2_PUBLIC_BUCKET (or legacy R2_BUCKET)',
  );
}

export const envs = {
  PORT: environmentVariables.PORT,
  DATABASE_URL: environmentVariables.DATABASE_URL,
  FRONTEND_URL: environmentVariables.FRONTEND_URL,
  JWT_SECRET: environmentVariables.JWT_SECRET,
  JWT_EXPIRES_IN: environmentVariables.JWT_EXPIRES_IN,
  RESEND_API_KEY: environmentVariables.RESEND_API_KEY,
  RESEND_FROM_EMAIL: environmentVariables.RESEND_FROM_EMAIL,
  STRIPE_SECRET_KEY: stripeSecretKey,
  STRIPE_WEBHOOK_SECRET: stripeWebhookSecret,
  STRIPE_SUCCESS_URL: environmentVariables.STRIPE_SUCCESS_URL,
  STRIPE_CANCEL_URL: environmentVariables.STRIPE_CANCEL_URL,
  STRIPE_ENABLED: Boolean(stripeSecretKey),
  R2_ACCOUNT_ID: environmentVariables.R2_ACCOUNT_ID,
  R2_ACCESS_KEY_ID: environmentVariables.R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY: environmentVariables.R2_SECRET_ACCESS_KEY,
  R2_PRIVATE_BUCKET: privateBucket,
  R2_PUBLIC_BUCKET: publicBucket,
  R2_REGION: environmentVariables.R2_REGION,
  R2_PUBLIC_BASE_URL: environmentVariables.R2_PUBLIC_BASE_URL,
  REDIS_HOST: environmentVariables.REDIS_HOST,
  EMAIL_SUPPORT: environmentVariables.EMAIL_SUPPORT,
  REDIS_PORT: environmentVariables.REDIS_PORT,
  REDIS_PASSWORD: environmentVariables.REDIS_PASSWORD,
  VIDEO_PROCESSING_CONCURRENCY:
    environmentVariables.VIDEO_PROCESSING_CONCURRENCY,
} as const;
