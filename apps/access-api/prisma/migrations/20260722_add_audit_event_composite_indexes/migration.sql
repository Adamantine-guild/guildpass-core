-- Create composite indexes on AuditEvent to optimize paginated and filtered audit event queries
CREATE INDEX "AuditEvent_communityId_createdAt_idx" ON "AuditEvent"("communityId", "createdAt");
CREATE INDEX "AuditEvent_communityId_walletId_idx" ON "AuditEvent"("communityId", "walletId");
CREATE INDEX "AuditEvent_communityId_eventType_idx" ON "AuditEvent"("communityId", "eventType");
CREATE INDEX "AuditEvent_communityId_resource_idx" ON "AuditEvent"("communityId", "resource");
