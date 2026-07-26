import type {
  DecisionTraceNode,
  RuleExprNode,
  Role,
} from "@guildpass/shared-types";
import type { EvaluationContext } from "./types";

/**
 * Deterministically evaluates a rule tree AST against an EvaluationContext
 * and returns a recursive DecisionTraceNode showing pass/fail state and explanations.
 */
export function evaluateRuleTree(
  node: RuleExprNode,
  context: EvaluationContext,
  now: Date = new Date()
): DecisionTraceNode {
  switch (node.type) {
    case "AND": {
      const children = node.rules.map((rule) => evaluateRuleTree(rule, context, now));
      const passed = children.every((child) => child.passed);
      return {
        type: "AND",
        passed,
        explanation: passed
          ? "All sub-conditions passed for AND"
          : "One or more sub-conditions failed for AND",
        code: passed ? "AND_PASSED" : "AND_FAILED",
        children,
      };
    }

    case "OR": {
      const children = node.rules.map((rule) => evaluateRuleTree(rule, context, now));
      const passed = children.some((child) => child.passed);
      return {
        type: "OR",
        passed,
        explanation: passed
          ? "At least one sub-condition passed for OR"
          : "All sub-conditions failed for OR",
        code: passed ? "OR_PASSED" : "OR_FAILED",
        children,
      };
    }

    case "NOT": {
      const child = evaluateRuleTree(node.rule, context, now);
      const passed = !child.passed;
      return {
        type: "NOT",
        passed,
        explanation: passed
          ? "NOT condition passed (negated condition failed)"
          : "NOT condition failed (negated condition passed)",
        code: passed ? "NOT_PASSED" : "NOT_FAILED",
        children: [child],
      };
    }

    case "HAS_ROLE": {
      const passed = context.effectiveRoles.includes(node.role as Role);
      return {
        type: "HAS_ROLE",
        passed,
        explanation: passed
          ? `User has required role '${node.role}'`
          : `User lacks required role '${node.role}'`,
        code: passed ? `HAS_ROLE_${node.role.toUpperCase()}` : `NEEDS_ROLE_${node.role.toUpperCase()}`,
        metadata: { role: node.role },
      };
    }

    case "HAS_ANY_ROLE": {
      const matchingRoles = node.roles.filter((r) => context.effectiveRoles.includes(r as Role));
      const passed = matchingRoles.length > 0;
      return {
        type: "HAS_ANY_ROLE",
        passed,
        explanation: passed
          ? `User has role(s) [${matchingRoles.join(", ")}] out of required [${node.roles.join(", ")}]`
          : `User lacks any of required roles [${node.roles.join(", ")}]`,
        code: passed ? "HAS_ANY_ROLE_MATCH" : "NEEDS_ANY_ROLE",
        metadata: { requiredRoles: node.roles, matchingRoles },
      };
    }

    case "HAS_MIN_ROLES": {
      const matchingRoles = node.roles.filter((r) => context.effectiveRoles.includes(r as Role));
      const count = matchingRoles.length;
      const passed = count >= node.minCount;
      return {
        type: "HAS_MIN_ROLES",
        passed,
        explanation: passed
          ? `User has ${count} of minimum ${node.minCount} required roles [${node.roles.join(", ")}]`
          : `User has only ${count} of minimum ${node.minCount} required roles [${node.roles.join(", ")}]`,
        code: passed ? "HAS_MIN_ROLES_MATCH" : "NEEDS_MIN_ROLES",
        metadata: { requiredRoles: node.roles, minCount: node.minCount, matchedCount: count },
      };
    }

    case "ACTIVE_MEMBERSHIP": {
      const passed = context.roleContext.membershipState === "active";
      return {
        type: "ACTIVE_MEMBERSHIP",
        passed,
        explanation: passed
          ? "Membership state is active"
          : `Membership state is '${context.roleContext.membershipState}' (requires active)`,
        code: passed ? "HAS_ACTIVE_MEMBERSHIP" : "NEEDS_ACTIVE_MEMBERSHIP",
        metadata: { membershipState: context.roleContext.membershipState },
      };
    }

    case "MEMBERSHIP_DURATION": {
      const memberSince = context.roleContext.memberSince;
      if (!memberSince) {
        return {
          type: "MEMBERSHIP_DURATION",
          passed: false,
          explanation: "No membership creation date provided to verify duration",
          code: "MISSING_MEMBERSHIP_DATE",
        };
      }

      const sinceDate = typeof memberSince === "string" ? new Date(memberSince) : memberSince;
      const durationMs = Math.max(0, now.getTime() - sinceDate.getTime());
      const durationDays = durationMs / (1000 * 60 * 60 * 24);

      let requiredMs = 0;
      if (node.minDays) requiredMs += node.minDays * 86400 * 1000;
      if (node.minHours) requiredMs += node.minHours * 3600 * 1000;
      if (node.minSeconds) requiredMs += node.minSeconds * 1000;

      const passed = durationMs >= requiredMs;

      return {
        type: "MEMBERSHIP_DURATION",
        passed,
        explanation: passed
          ? `Membership duration of ${durationDays.toFixed(1)} days meets required threshold`
          : `Membership duration of ${durationDays.toFixed(1)} days is less than required threshold`,
        code: passed ? "MEMBERSHIP_DURATION_MET" : "MEMBERSHIP_DURATION_INSUFFICIENT",
        metadata: { durationDays, requiredMs, actualMs: durationMs },
      };
    }

    case "HAS_OVERRIDE": {
      const targetEffect = node.effect ?? "ALLOW";
      const overrides = context.roleContext.overrides ?? [];
      const hasMatchingOverride = overrides.some((ov) => {
        if (ov.effect !== targetEffect) return false;
        if (ov.expiresAt && new Date(ov.expiresAt) < now) return false;
        return true;
      });

      return {
        type: "HAS_OVERRIDE",
        passed: hasMatchingOverride,
        explanation: hasMatchingOverride
          ? `Matching active '${targetEffect}' override present`
          : `No active '${targetEffect}' override found`,
        code: hasMatchingOverride ? `HAS_${targetEffect}_OVERRIDE` : `LACKS_${targetEffect}_OVERRIDE`,
      };
    }

    case "TIME_WINDOW": {
      let passed = true;
      const reasons: string[] = [];

      if (node.daysOfWeek && node.daysOfWeek.length > 0) {
        const currentDay = now.getUTCDay();
        if (!node.daysOfWeek.includes(currentDay)) {
          passed = false;
          reasons.push(`Day of week ${currentDay} not in allowed days [${node.daysOfWeek.join(", ")}]`);
        }
      }

      if (node.startTime && node.endTime) {
        if (node.startTime.includes("T") || node.startTime.includes("-")) {
          // ISO Date comparison
          const start = new Date(node.startTime);
          const end = new Date(node.endTime);
          if (now < start || now > end) {
            passed = false;
            reasons.push(`Current time ${now.toISOString()} outside window [${node.startTime} to ${node.endTime}]`);
          }
        } else {
          // HH:mm comparison (UTC)
          const currentHours = now.getUTCHours();
          const currentMins = now.getUTCMinutes();
          const currentTotalMins = currentHours * 60 + currentMins;

          const [startH, startM] = node.startTime.split(":").map(Number);
          const [endH, endM] = node.endTime.split(":").map(Number);

          const startTotal = startH * 60 + startM;
          const endTotal = endH * 60 + endM;

          if (currentTotalMins < startTotal || currentTotalMins > endTotal) {
            passed = false;
            reasons.push(`Current time ${now.getUTCHours()}:${now.getUTCMinutes()} UTC outside time-of-day window [${node.startTime} - ${node.endTime}]`);
          }
        }
      }

      return {
        type: "TIME_WINDOW",
        passed,
        explanation: passed
          ? "Access requested within allowed time window"
          : `Time window restriction failed: ${reasons.join("; ")}`,
        code: passed ? "TIME_WINDOW_VALID" : "TIME_WINDOW_INVALID",
      };
    }

    case "ALWAYS_ALLOW": {
      return {
        type: "ALWAYS_ALLOW",
        passed: true,
        explanation: "Public / unrestricted access granted",
        code: "ALWAYS_ALLOW",
      };
    }

    case "ALWAYS_DENY": {
      return {
        type: "ALWAYS_DENY",
        passed: false,
        explanation: "Explicit deny rule applied",
        code: "ALWAYS_DENY",
      };
    }
  }
}
