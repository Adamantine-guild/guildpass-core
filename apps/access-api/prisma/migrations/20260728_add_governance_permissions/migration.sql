CREATE TABLE "RoleDefinition" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "communityId" TEXT NOT NULL,
    "description" TEXT,
    "parentRoleId" TEXT,
    "builtInRole" "Role",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RoleDefinition_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RoleDefinition_communityId_name_key"
    ON "RoleDefinition"("communityId", "name");

CREATE INDEX "RoleDefinition_parentRoleId_idx"
    ON "RoleDefinition"("parentRoleId");

ALTER TABLE "RoleDefinition"
    ADD CONSTRAINT "RoleDefinition_communityId_fkey"
    FOREIGN KEY ("communityId")
    REFERENCES "Community"("id")
    ON DELETE RESTRICT
    ON UPDATE CASCADE;

ALTER TABLE "RoleDefinition"
    ADD CONSTRAINT "RoleDefinition_parentRoleId_fkey"
    FOREIGN KEY ("parentRoleId")
    REFERENCES "RoleDefinition"("id")
    ON DELETE SET NULL
    ON UPDATE CASCADE;

ALTER TABLE "RoleAssignment"
    ALTER COLUMN "role" DROP NOT NULL,
    ADD COLUMN "roleDefinitionId" TEXT,
    ADD COLUMN "expiresAt" TIMESTAMP(3);

ALTER TABLE "RoleAssignment"
    ADD CONSTRAINT "RoleAssignment_roleDefinitionId_fkey"
    FOREIGN KEY ("roleDefinitionId")
    REFERENCES "RoleDefinition"("id")
    ON DELETE SET NULL
    ON UPDATE CASCADE;

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
