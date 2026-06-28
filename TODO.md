# TODO

## Access API: Atomic access-affecting writes (Prisma transactions)

- [ ] Implement transaction-aware audit logging in `apps/access-api/src/services/auditService.ts` (add tx-scoped helper while preserving existing `logEvent`).
- [ ] Wrap multi-table contract event writes in Prisma transactions in `apps/access-api/src/services/contractEventHelpers.ts`.
- [ ] Add rollback tests that simulate transaction failure and verify rollback (new Jest test).
- [ ] Run `pnpm -C apps/access-api test` and fix any failures.
- [ ] Sanity-check types/TS compilation.

