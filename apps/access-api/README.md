
## Audit Logging & Retention

This service records audit events (access checks and membership changes) in the AuditEvent table.

Retention guidance:
- Audit events can grow quickly. We recommend a retention policy:
  - Keep detailed event records (Json before/after) for 90 days.
  - Archive older events to a cheaper storage (e.g., S3) every 30-90 days.
  - Delete archived records from the DB after successful backup.
- Implement a daily job (cron) to:
  - Export events older than N days to archive storage.
  - Delete exported rows from the database.
- Consider adding DB partitioning by createdAt or communityId for high-volume deployments.
- Ensure proper access controls on archived audit data and set up secure, immutable storage where necessary.

