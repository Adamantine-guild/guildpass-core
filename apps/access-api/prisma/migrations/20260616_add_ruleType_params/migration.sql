-- Add structured policy support with ruleType and params
ALTER TABLE "AccessPolicy"
  ADD COLUMN IF NOT EXISTS "ruleType" TEXT NOT NULL DEFAULT 'MEMBERS_ONLY';

ALTER TABLE "AccessPolicy"
  ADD COLUMN IF NOT EXISTS "params" JSONB;

-- Migrate legacy string rule values from the old "rule" column if present.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'AccessPolicy' AND column_name = 'rule'
  ) THEN
    UPDATE "AccessPolicy"
    SET "ruleType" = "rule"
    WHERE "ruleType" = 'MEMBERS_ONLY' AND "rule" IS NOT NULL;
  END IF;
END
$$;
