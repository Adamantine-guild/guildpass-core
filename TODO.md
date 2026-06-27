# TODO

## Cross-community scoping safeguards (acceptance: >=96%)

- [ ] Update `apps/access-api/src/services/auditService.ts` to require `communityId` for wallet reads; add `getEventsByCommunityAndWallet` and remove/guard old method.
- [ ] Update `apps/access-api/src/services/memberService.ts` to require `communityId` for wallet-scoped membership/profile reads (and update routes + tests accordingly).
- [ ] Update `apps/access-api/src/services/contractEventHelpers.ts` to scope renewal/suspension lookups by both `tokenId` and `communityId`.
- [ ] Add cross-community integration tests that create records in two communities and prove no leakage in responses.
- [ ] Ensure TypeScript/Jest pass.

