-- Keep one row per Stripe external subscription id before enforcing uniqueness.
WITH ranked_subscriptions AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY "externalId"
      ORDER BY "updatedAt" DESC, "createdAt" DESC
    ) AS "rank"
  FROM "Subscription"
  WHERE "externalId" IS NOT NULL
)
UPDATE "Subscription" AS subscription
SET
  "externalId" = NULL,
  "status" = 'EXPIRED',
  "updatedAt" = CURRENT_TIMESTAMP
FROM ranked_subscriptions
WHERE subscription."id" = ranked_subscriptions."id"
  AND ranked_subscriptions."rank" > 1;

DROP INDEX IF EXISTS "Subscription_externalId_idx";
CREATE UNIQUE INDEX "Subscription_externalId_key" ON "Subscription"("externalId");
