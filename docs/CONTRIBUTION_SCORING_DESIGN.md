# Contribution Scoring Engine

Issue #270 — Design and Implementation

## Overview

The contribution scoring engine provides a pluggable, event-driven system for
computing and persisting per-member, per-community contribution scores. Scores
are derived from weighted "signal" sources and recomputed incrementally in
response to domain events via the outbox event stream.

The system is designed as a foundation for future features including role
eligibility thresholds, badge awards, and reward distribution.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                      Outbox Event Stream                        │
│  (ROLE_ASSIGNED, BADGE_ASSIGNED, MEMBER_ATTENDED, ...)          │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                    ┌──────▼──────┐
                    │  Outbox     │
                    │  Worker     │
                    └──────┬──────┘
                           │
                ┌──────────▼──────────┐
                │ ContributionScore   │
                │ Handler             │
                │ (outboxHandler)     │
                └──────────┬──────────┘
                           │
                ┌──────────▼──────────┐
                │ ContributionService │
                │ (recomputeAndPersist)│
                └──────────┬──────────┘
                           │
         ┌─────────────────▼─────────────────┐
         │     ContributionEngine             │
         │  ┌─────────┐ ┌──────────┐ ┌─────┐ │
         │  │ Tenure  │ │  Badge   │ │ ... │ │
         │  │ Signal  │ │  Signal  │ │     │ │
         │  └─────────┘ └──────────┘ └─────┘ │
         └─────────────────┬─────────────────┘
                           │
                ┌──────────▼──────────┐
                │  Prisma / Postgres  │
                │  ContributionScore  │
                │  ContributionEvent  │
                └─────────────────────┘
```

## Package: `@guildpass/contribution-engine`

Location: `packages/contribution-engine/`

### Scoring Strategy Interface

The core abstraction is `ContributionSignal`:

```typescript
interface ContributionSignal {
  readonly type: string;       // unique identifier
  readonly weight: number;     // multiplier (default 1.0)
  compute(ctx: SignalContext): SignalResult;
}

interface SignalResult {
  type: string;
  points: number;
  explanation: string;
}

interface SignalContext {
  wallet: string;
  communityId: string;
  joinedAt: Date;
  badgeCount: number;
  attendanceCount: number;
  roles: string[];
  metadata?: Record<string, unknown>;
}
```

Adding a new signal requires:
1. Create a class implementing `ContributionSignal`
2. Register it with `engine.register(new MySignal())`

No existing code needs modification — the engine is fully open for extension.

### Built-in Signals

| Signal | Type Key | Default | Description |
|--------|----------|---------|-------------|
| Tenure | `tenure` | 1 pt/week, 52-week cap | Points for membership duration |
| Badge Count | `badge_count` | 5 pts/badge | Points per badge held |
| Activity | `activity` | 10 pts/event, 30d half-life | Decay-weighted attendance score |

### Activity Signal — Time-Decay Model

The activity signal uses exponential decay to weight recent attendance more
heavily than distant participation:

```
score = attendanceCount × pointsPerEvent × avgDecayFactor
avgDecayFactor = (H × ln2 / T) × (1 − 2^(−T/H))
```

Where:
- `H` = half-life (default 30 days)
- `T` = member tenure in days

This ensures that a member who attended 10 events last month scores higher
than one who attended 10 events two years ago, without requiring per-event
timestamp storage.

### Engine

`ContributionEngine` is a registry + aggregator:

```typescript
const engine = new ContributionEngine();
engine.register(new TenureSignal());
engine.register(new BadgeSignal());
engine.register(new ActivitySignal());

const result = engine.computeScore(ctx);
// result = { total: 42, breakdown: { tenure: 10, badge_count: 15, activity: 17 }, ... }
```

`createDefaultEngine()` returns an engine with all three built-in signals.

## Data Model

### `ContributionScore` (running totals)

```prisma
model ContributionScore {
  id          String   @id @default(uuid())
  walletId    String
  communityId String
  totalScore  Int      @default(0)
  breakdown   Json?    // { tenure: 10, badge_count: 15, activity: 17 }
  updatedAt   DateTime @updatedAt

  @@unique([walletId, communityId])
}
```

### `ContributionEvent` (audit log)

```prisma
model ContributionEvent {
  id          String   @id @default(uuid())
  walletId    String
  communityId String
  totalScore  Int
  breakdown   Json
  explanations Json?
  triggerEventId String?  // links to OutboxEvent that triggered this recompute
  createdAt   DateTime @default(now())

  @@index([walletId, communityId])
  @@index([createdAt])
}
```

Each `recomputeAndPersist` call creates an append-only `ContributionEvent`
row. The most recent row for a `(walletId, communityId)` pair is the current
score; older rows form an auditable history.

## Event-Driven Recomputation

Scores are recomputed automatically when relevant outbox events arrive:

| Event Type | Trigger |
|------------|---------|
| `ROLE_ASSIGNED` | Role change affects score context |
| `ROLE_REMOVED` | Role removal affects score context |
| `BADGE_ASSIGNED` | New badge increases badge count |
| `BADGE_REVOKED` | Badge removal decreases badge count |
| `MEMBER_ATTENDED` | New attendance record |
| `MEMBERSHIP_CREATED` | New member joins |
| `MEMBERSHIP_UPDATED` | Membership state change |

The handler (`contributionScoreHandler.ts`) extracts `wallet` and
`communityId` from the event payload and calls `recomputeAndPersist`.
Errors are logged but do NOT cause the outbox event to fail — scores
will be recomputed on the next relevant event.

## API

### `GET /v1/communities/:communityId/members/:wallet/score`

Returns the current contribution score and recent recomputation history.

**Response:**
```json
{
  "wallet": "0xabc...",
  "communityId": "community-1",
  "totalScore": 42,
  "breakdown": {
    "tenure": 10,
    "badge_count": 15,
    "activity": 17
  },
  "history": [
    {
      "totalScore": 42,
      "breakdown": { "tenure": 10, "badge_count": 15, "activity": 17 },
      "explanations": { "tenure": "10 week(s) of membership", ... },
      "triggerEventId": "evt-abc-123",
      "createdAt": "2026-07-28T12:00:00.000Z"
    }
  ]
}
```

## Extension Points

### Adding a Custom Signal

```typescript
import { ContributionSignal, SignalContext, SignalResult } from '@guildpass/contribution-engine';

class CustomSignal implements ContributionSignal {
  readonly type = 'custom_metric';
  readonly weight = 1.5;

  compute(ctx: SignalContext): SignalResult {
    const points = /* your logic */;
    return { type: this.type, points, explanation: `Custom: ${points} pts` };
  }
}

engine.register(new CustomSignal());
```

### Custom Strategies (Alternative)

For fundamentally different scoring models (e.g. ML-based, time-series),
implement the `ContributionSignal` interface with external data access
via `SignalContext.metadata` and register the signal on a separate engine
instance.

## Future Directions

- **Per-event scoring**: Extend `SignalContext` with individual event
  timestamps for more precise decay calculations.
- **Score thresholds**: Use contribution scores as governance rule
  inputs (e.g. `MinContributionScore` rule node — already implemented
  in governance engine).
- **Rewards integration**: Trigger reward distribution when scores
  cross configurable thresholds.
- **Decay strategy configuration**: Allow communities to configure
  half-life, weight, and cap per signal.
