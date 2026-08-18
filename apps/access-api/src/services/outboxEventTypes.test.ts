import fs from "node:fs";
import path from "node:path";

import {
  OUTBOX_EVENT_TYPES,
  OUTBOX_EVENT_TYPE_VALUES,
} from "@guildpass/shared-types";

describe("shared outbox event types", () => {
  it("exports unique event type values for outbox producers and consumers", () => {
    expect(OUTBOX_EVENT_TYPE_VALUES).toContain(OUTBOX_EVENT_TYPES.MEMBERSHIP_CREATED);
    expect(OUTBOX_EVENT_TYPE_VALUES).toContain(OUTBOX_EVENT_TYPES.ROLE_ASSIGNED);
    expect(OUTBOX_EVENT_TYPE_VALUES).toContain(OUTBOX_EVENT_TYPES.ACCESS_DECISION);
    expect(new Set(OUTBOX_EVENT_TYPE_VALUES).size).toBe(OUTBOX_EVENT_TYPE_VALUES.length);
  });

  it("keeps production outbox modules on the shared constants", () => {
    const repoRoot = path.resolve(__dirname, "../../../..");
    const checkedFiles = [
      "apps/access-api/src/services/outboxService.ts",
      "apps/access-api/src/services/memberService.ts",
      "apps/access-api/src/services/resourceService.ts",
      "apps/access-api/src/services/attendance/attendanceService.ts",
      "apps/access-api/src/services/rewardEngineService.ts",
      "apps/access-api/src/handlers/contributionScoreHandler.ts",
      "apps/access-api/src/workers/outboxWorker.ts",
    ];

    const rawOutboxEventLiteral =
      /eventType\s*:\s*["'](MEMBERSHIP|ROLE|RESOURCE|POLICY|ACCESS_OVERRIDE|MEMBER_ATTENDED|EVENT_|BADGE|CONTRIBUTION|CONSTITUTIONAL|CONTRACT)[A-Z0-9_]*["']/;
    const offenders = checkedFiles.filter((file) => {
      const source = fs.readFileSync(path.join(repoRoot, file), "utf8");
      return rawOutboxEventLiteral.test(source);
    });

    expect(offenders).toEqual([]);

    const contributionHandler = fs.readFileSync(
      path.join(repoRoot, "apps/access-api/src/handlers/contributionScoreHandler.ts"),
      "utf8",
    );
    const rewardService = fs.readFileSync(
      path.join(repoRoot, "apps/access-api/src/services/rewardEngineService.ts"),
      "utf8",
    );

    expect(contributionHandler).not.toMatch(
      /SCORE_RECOMPUTE_EVENTS[\s\S]*?new Set\(\[[\s\S]*?["'][A-Z][A-Z0-9_]*["']/,
    );
    expect(rewardService).not.toMatch(
      /REWARD_EVENTS[\s\S]*?new Set\(\[[\s\S]*?["'][A-Z][A-Z0-9_]*["']/,
    );
  });
});
