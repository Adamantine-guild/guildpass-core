CREATE TABLE "reward_ledger" (
    "id" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "communityId" TEXT NOT NULL,
    "rewardType" TEXT NOT NULL,
    "amount" INTEGER,
    "metadata" JSONB,
    "ruleId" TEXT,
    "sourceEventId" TEXT NOT NULL,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "reward_ledger_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "reward_streak_state" (
    "id" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "communityId" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "currentStreak" INTEGER NOT NULL DEFAULT 0,
    "longestStreak" INTEGER NOT NULL DEFAULT 0,
    "lastPeriodKey" TEXT,
    "lastActivityAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "reward_streak_state_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "reward_ledger_walletId_communityId_rewardType_sourceEventId_key"
    ON "reward_ledger"("walletId", "communityId", "rewardType", "sourceEventId");
CREATE INDEX "reward_ledger_walletId_communityId_grantedAt_idx"
    ON "reward_ledger"("walletId", "communityId", "grantedAt");
CREATE UNIQUE INDEX "reward_streak_state_walletId_communityId_period_key"
    ON "reward_streak_state"("walletId", "communityId", "period");
CREATE INDEX "reward_streak_state_walletId_communityId_idx"
    ON "reward_streak_state"("walletId", "communityId");

CREATE FUNCTION prevent_reward_ledger_mutation()
RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'reward_ledger is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER reward_ledger_append_only
BEFORE UPDATE OR DELETE ON "reward_ledger"
FOR EACH ROW EXECUTE FUNCTION prevent_reward_ledger_mutation();
