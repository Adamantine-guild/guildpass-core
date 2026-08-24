export type AccessDecisionCode =
  | "ALLOW"
  | "NOT_MEMBER"
  | "MEMBERSHIP_EXPIRED"
  | "MEMBERSHIP_SUSPENDED"
  | "INSUFFICIENT_ROLE"
  | "DENY";

export interface AccessDecision {
  allowed: boolean;
  code: AccessDecisionCode;
  reasons: string[];
}
