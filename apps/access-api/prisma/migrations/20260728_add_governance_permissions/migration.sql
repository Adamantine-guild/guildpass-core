CREATE TABLE "role_permissions" (
    "id" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "communityId" TEXT NOT NULL,
    "permission" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "role_permissions_roleId_permission_key"
    ON "role_permissions"("roleId", "permission");
CREATE INDEX "role_permissions_communityId_permission_idx"
    ON "role_permissions"("communityId", "permission");

ALTER TABLE "role_permissions"
    ADD CONSTRAINT "role_permissions_roleId_fkey"
    FOREIGN KEY ("roleId") REFERENCES "RoleDefinition"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "role_permissions"
    ADD CONSTRAINT "role_permissions_communityId_fkey"
    FOREIGN KEY ("communityId") REFERENCES "Community"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AccessPolicy"
    ADD COLUMN "requiredPermissions" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
