# @guildpass/contribution-engine

Pluggable, signal-based contribution scoring engine for GuildPass communities.

## Overview

This package defines a minimal, extensible scoring model where pluggable "signal" sources each contribute weighted points to a per-wallet, per-community score. The score is designed to be consumed by a future rewards or governance system.

## Architecture

```
ContributionEngine
  ├── TenureSignal      (points for membership duration)
  ├── BadgeSignal       (points for badge count)
  └── [Custom signals]  (implement ContributionSignal interface)
```

Each signal implements the `ContributionSignal` interface:

```typescript
interface ContributionSignal {
  readonly type: string;     // unique identifier
  readonly weight: number;   // weight multiplier
  compute(ctx: SignalContext): SignalResult;
}
```

## Built-in Signals

| Signal | Type | Default Points | Description |
|--------|------|----------------|-------------|
| TenureSignal | `tenure` | 1 per week (max 52 weeks) | Points proportional to membership duration |
| BadgeSignal | `badge_count` | 5 per badge | Points for number of badges held |

## Usage

```typescript
import { createDefaultEngine } from '@guildpass/contribution-engine';

const engine = createDefaultEngine();

const score = engine.computeScore({
  wallet: '0xabc123',
  communityId: 'community-1',
  joinedAt: new Date('2024-01-01'),
  badgeCount: 3,
  attendanceCount: 5,
  roles: ['member', 'contributor'],
});

// { total: 22, breakdown: { tenure: 10, badge_count: 15 }, explanations: { ... } }
```

## Adding Custom Signals

```typescript
import { ContributionEngine, type ContributionSignal } from '@guildpass/contribution-engine';

class AttendanceSignal implements ContributionSignal {
  readonly type = 'attendance';
  readonly weight = 1.5;

  compute(ctx: SignalContext) {
    const points = ctx.attendanceCount * 3;
    return {
      type: this.type,
      points: points * this.weight,
      explanation: `${ctx.attendanceCount} event(s) attended`,
    };
  }
}

const engine = createDefaultEngine();
engine.register(new AttendanceSignal());
```

## Integration with Access API

The `apps/access-api` wires the contribution engine to the outbox event system. When relevant domain events arrive (ROLE_ASSIGNED, BADGE_ASSIGNED, MEMBER_ATTENDED, MEMBERSHIP_CREATED), the contribution score is automatically recomputed and persisted to the `ContributionScore` Prisma model.
