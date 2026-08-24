export const MEMBERSHIP_STATES = [
  "active",
  "expired",
  "suspended"
] as const;

export type MembershipState =
  (typeof MEMBERSHIP_STATES)[number];

export interface Membership {
  id: string;
  memberId: string;
  state: MembershipState;
  expiresAt: Date | null;
  createdAt: Date;
}
