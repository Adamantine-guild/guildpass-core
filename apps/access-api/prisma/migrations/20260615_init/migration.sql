-- Initial schema: base tables as they existed before incremental migrations.

CREATE TYPE "MembershipState" AS ENUM ('invited', 'active', 'expired', 'suspended');
CREATE TYPE "Role" AS ENUM ('admin', 'member', 'contributor');
CREATE TYPE "RoleSource" AS ENUM ('manual', 'auto');

CREATE TABLE "Community" (
  "id"        TEXT PRIMARY KEY,
  "name"      TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE "Wallet" (
  "id"        TEXT PRIMARY KEY,
  "address"   TEXT NOT NULL UNIQUE,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE "Profile" (
  "id"          TEXT PRIMARY KEY,
  "displayName" TEXT NOT NULL,
  "bio"         TEXT
);

CREATE TABLE "Member" (
  "id"          TEXT PRIMARY KEY,
  "communityId" TEXT NOT NULL REFERENCES "Community"("id"),
  "walletId"    TEXT NOT NULL REFERENCES "Wallet"("id"),
  "profileId"   TEXT REFERENCES "Profile"("id"),
  UNIQUE ("communityId", "walletId")
);

CREATE TABLE "Membership" (
  "id"        TEXT PRIMARY KEY,
  "memberId"  TEXT NOT NULL UNIQUE REFERENCES "Member"("id"),
  "state"     "MembershipState" NOT NULL,
  "expiresAt" TIMESTAMPTZ,
  "renewedAt" TIMESTAMPTZ,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE "RoleAssignment" (
  "id"        TEXT PRIMARY KEY,
  "memberId"  TEXT NOT NULL REFERENCES "Member"("id"),
  "role"      "Role" NOT NULL,
  "source"    "RoleSource" NOT NULL,
  "active"    BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE "Badge" (
  "id"       TEXT PRIMARY KEY,
  "memberId" TEXT NOT NULL REFERENCES "Member"("id"),
  "label"    TEXT NOT NULL,
  "issuedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX "Badge_memberId_idx" ON "Badge" ("memberId");

-- AccessPolicy with original "rule" column (ruleType/params added in next migration)
CREATE TABLE "AccessPolicy" (
  "id"          TEXT PRIMARY KEY,
  "communityId" TEXT NOT NULL REFERENCES "Community"("id"),
  "resource"    TEXT NOT NULL,
  "rule"        TEXT NOT NULL DEFAULT 'MEMBERS_ONLY',
  UNIQUE ("communityId", "resource")
);
