-- Index to support efficient reconciliation queries:
-- WHERE state IN ('active', 'suspended') AND expiresAt < now()
CREATE INDEX "Membership_state_expiresAt_idx" ON "Membership" ("state", "expiresAt");
