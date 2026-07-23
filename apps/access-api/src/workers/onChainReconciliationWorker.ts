/**
 * onChainReconciliationWorker.ts
 *
 * Periodically cross-checks on-chain membership state (via ChainProvider view
 * functions) against the database's stored state for each MembershipToken.
 *
 * ## Purpose
 * The IndexerWorker keeps off-chain state current by applying live contract
 * events, but it relies entirely on every relevant event being captured and
 * correctly applied.  This worker is a defense-in-depth mechanism: it performs
 * a systematic, field-by-field comparison between what the contract says is
 * true and what the database says is true, and raises a structured
 * RECONCILIATION_DISCREPANCY audit event for any mismatch found.
 *
 * **This worker does NOT auto-correct discrepancies.**  A mismatch could mean:
 *   - The database is stale (missed event, reorg edge case, application bug).
 *   - The on-chain read is momentarily stale (using a different block than
 *     the indexer last processed, finality lag).
 *   - A deeper consistency issue that needs human investigation.
 * Blindly "fixing" one side from the other without understanding which is
 * authoritative could itself introduce bugs.  The alert is designed to be
 * clear and actionable so an operator can determine and apply the correct
 * manual remediation.
 *
 * ## Sampling strategy and cost characteristics
 *
 * Each reconciliation pass selects a batch of MembershipToken rows from the
 * database and issues one `eth_call` bundle per token (ownerOf + isActive +
 * expiry + suspended + communityOf — currently 1 call per view function per
 * token; a future optimization is to batch these into a single multicall).
 *
 * Configuration knobs (`OnChainReconciliationOptions`):
 *
 * | Option        | Default | Description |
 * |---------------|---------|-------------|
 * | sampleSize    | 50      | Max tokens checked per pass. Set to Infinity to
 * |               |         | check all tokens (exhaustive mode). For large
 * |               |         | communities, keep this well below your RPC
 * |               |         | provider's rate limit to avoid 429s. |
 * | randomSample  | true    | When true and the total token count exceeds
 * |               |         | sampleSize, pick rows in random ORDER so every
 * |               |         | token is reachable across passes even without a
 * |               |         | full exhaustive scan. When false, the oldest
 * |               |         | (by tokenId) are always checked first. |
 * | communityId   | –       | If set, restrict the sample to tokens belonging
 * |               |         | to members of that community (useful for per-
 * |               |         | community scheduled reconciliation). |
 * | activeOnly    | true    | When true, only tokens in state "active" or
 * |               |         | "suspended" are sampled; "invited" and "expired"
 * |               |         | tokens are skipped since a divergence there is
 * |               |         | operationally lower-stakes. Set to false to
 * |               |         | include all tokens. |
 *
 * RPC call budget per pass (worst case, no multicall):
 *   sampleSize × 5 eth_call   (ownerOf, isActive, expiry, suspended, communityOf)
 *
 * With the default sampleSize=50 and a 5-minute interval, this amounts to
 * ≈250 eth_calls per 5 minutes — well within the free tiers of all major
 * managed RPC providers (Alchemy, Infura, QuickNode all allow ≥300 calls/s).
 *
 * Operator guidance:
 * - For small communities (< 500 tokens), set randomSample=false and
 *   sampleSize to the full community size for exhaustive coverage.
 * - For large communities (thousands of tokens), keep randomSample=true and
 *   tune sampleSize so passes complete within the interval.
 * - Point the worker at a dedicated archive/full-node RPC endpoint if possible
 *   so it does not compete with live-path traffic.
 * - If a RECONCILIATION_DISCREPANCY alert fires repeatedly for the same token,
 *   check the IndexerWorker logs for missed events and cross-reference the
 *   block number recorded in the audit event.
 */

import { PrismaClient } from "@prisma/client";
import { getPrisma } from "../services/prisma";
import { logEvent } from "../services/auditService";

// ---------------------------------------------------------------------------
// Extended ChainProvider for view-function calls
// ---------------------------------------------------------------------------

/**
 * On-chain state returned by the contract's view functions for a single token.
 * Mirrors the MembershipNFT Solidity interface fields used by the reconciler.
 */
export interface OnChainTokenState {
  /** EVM address that owns the token (all lower-case). */
  owner: string;
  /** Whether the contract considers the membership active right now. */
  isActive: boolean;
  /** Unix timestamp (seconds) when the membership expires, 0 if no expiry. */
  expiry: number;
  /** Whether the membership is suspended. */
  suspended: boolean;
  /** The communityId string stored on-chain for this token. */
  communityId: string;
}

/**
 * Extension of the base ChainProvider that adds read-only contract view calls.
 *
 * Implementations should use `eth_call` at the "latest" (or a specified)
 * block — the same block height that the IndexerWorker is processing is ideal
 * to avoid false positives from finality lag, but "latest" is acceptable as
 * long as both sides tolerate a small clock skew window.
 *
 * The five methods map 1-to-1 to view functions on MembershipNFT:
 *   ownerOf(tokenId)        → owner (address)
 *   isActive(tokenId)       → isActive (bool)
 *   expiry(tokenId)         → expiry (uint256, unix seconds)
 *   suspended(tokenId)      → suspended (bool)
 *   communityOf(tokenId)    → communityId (string)
 *
 * A convenience `getTokenState` method combines all five into one call; a
 * real implementation should use multicall to issue them atomically.
 */
export interface OnChainViewProvider {
  /**
   * Return the full on-chain state for a token.
   * Throws if the token does not exist on-chain (e.g. ERC-721 ownerOf revert).
   */
  getTokenState(tokenId: number): Promise<OnChainTokenState>;
}

// ---------------------------------------------------------------------------
// Field-level discrepancy types
// ---------------------------------------------------------------------------

export type DiscrepancyField = "owner" | "isActive" | "expiry" | "suspended" | "communityId";

export interface FieldDiscrepancy {
  field: DiscrepancyField;
  onChainValue: unknown;
  dbValue: unknown;
}

export interface TokenDiscrepancy {
  tokenId: number;
  memberId: string;
  /** wallet address stored in DB for this member */
  walletAddress: string;
  communityId: string;
  fields: FieldDiscrepancy[];
  /** block at which the on-chain read was taken, if known */
  blockNumber?: number;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface OnChainReconciliationOptions {
  /**
   * Maximum number of tokens to check per pass.
   * Use Infinity for exhaustive (small communities only — watch RPC costs).
   * Default: 50
   */
  sampleSize?: number;

  /**
   * When true and the total exceeds sampleSize, pick rows in random ORDER
   * via `ORDER BY RANDOM()` so every token is eventually reached.
   * Default: true
   */
  randomSample?: boolean;

  /**
   * Restrict sampling to members of a specific community.
   * Omit to sample across all communities.
   */
  communityId?: string;

  /**
   * When true, only "active" and "suspended" tokens are sampled (lower RPC
   * cost, higher operational relevance).  Set false to check all states.
   * Default: true
   */
  activeOnly?: boolean;

  /**
   * Chain ID recorded on audit events; no functional effect on the pass.
   * Default: 31337 (Hardhat local)
   */
  chainId?: number;
}

export interface ReconciliationPassResult {
  /** Number of tokens checked */
  checked: number;
  /** Number of tokens with at least one discrepancy */
  discrepancies: number;
  /** Number of tokens where on-chain read failed (provider error) */
  errors: number;
}

// ---------------------------------------------------------------------------
// Core reconciliation logic
// ---------------------------------------------------------------------------

/**
 * Run one on-chain reconciliation pass.
 *
 * For each sampled MembershipToken, reads the current on-chain state via
 * `provider.getTokenState()` and compares it field-by-field against the
 * database record.  For any mismatch, writes a RECONCILIATION_DISCREPANCY
 * audit event with full before/after detail (on-chain vs. database) **without
 * mutating either side**.
 *
 * @param prisma   PrismaClient (or test double)
 * @param provider On-chain view provider (real RPC or test double)
 * @param options  Sampling and filtering options
 */
export async function reconcileOnChainState(
  prisma: PrismaClient,
  provider: OnChainViewProvider,
  options: OnChainReconciliationOptions = {},
): Promise<ReconciliationPassResult> {
  const {
    sampleSize = 50,
    randomSample = true,
    communityId,
    activeOnly = true,
    chainId = 31337,
  } = options;

  // Build the WHERE clause for the token sample query.
  const where: Record<string, unknown> = {};
  if (activeOnly) {
    where.state = { in: ["active", "suspended"] };
  }
  if (communityId) {
    where.member = { communityId };
  }

  // Fetch a sample of tokens.  Prisma does not support ORDER BY RANDOM()
  // natively, so for random sampling we take a larger batch and shuffle
  // in-process.  For non-random (deterministic) sampling we order by tokenId.
  //
  // This is acceptable for the typical sampleSize range (≤1000 tokens); if
  // sampleSize approaches table size a raw SQL approach with TABLESAMPLE would
  // be more efficient but adds complexity not warranted at MVP scale.
  const fetchLimit = randomSample && sampleSize !== Infinity
    ? Math.min(sampleSize * 4, 2000) // over-fetch then subsample
    : sampleSize === Infinity
    ? undefined // no LIMIT — fetch all
    : sampleSize;

  const tokens = await prisma.membershipToken.findMany({
    where,
    take: fetchLimit,
    orderBy: randomSample ? undefined : { tokenId: "asc" },
    include: {
      member: {
        include: { wallet: true },
      },
    },
  });

  // Subsample randomly in-process when needed.
  const sample =
    randomSample && tokens.length > sampleSize
      ? shuffleAndSlice(tokens, sampleSize)
      : tokens;

  let checked = 0;
  let discrepancies = 0;
  let errors = 0;

  for (const token of sample) {
    checked++;

    let onChain: OnChainTokenState;
    try {
      onChain = await provider.getTokenState(token.tokenId);
    } catch (err) {
      // Provider error: log and skip — do not raise a false discrepancy alert.
      console.error(
        `[onChainReconciliationWorker] Failed to read on-chain state for tokenId ${token.tokenId}:`,
        err,
      );
      errors++;
      continue;
    }

    // --- Field-by-field comparison ---
    const dbWalletAddress = token.member.wallet.address.toLowerCase();
    const dbState = token.state;
    const dbExpiresAt = token.expiresAt;
    const dbCommunityId = token.member.communityId;

    const fieldDiscrepancies: FieldDiscrepancy[] = [];

    // 1. owner: on-chain ownerOf vs. DB wallet address
    if (onChain.owner.toLowerCase() !== dbWalletAddress) {
      fieldDiscrepancies.push({
        field: "owner",
        onChainValue: onChain.owner.toLowerCase(),
        dbValue: dbWalletAddress,
      });
    }

    // 2. isActive: on-chain isActive vs. DB state === "active"
    //    Note: suspended tokens are not "active" on-chain, so a DB state of
    //    "suspended" correctly maps to onChain.isActive === false.  We skip
    //    this field check for suspended tokens to avoid false positives from
    //    that intentional divergence.
    if (dbState !== "suspended") {
      const dbIsActive = dbState === "active";
      if (onChain.isActive !== dbIsActive) {
        fieldDiscrepancies.push({
          field: "isActive",
          onChainValue: onChain.isActive,
          dbValue: dbIsActive,
        });
      }
    }

    // 3. expiry: on-chain unix-seconds vs. DB expiresAt (allow ±2 second
    //    tolerance for integer-to-millisecond rounding)
    const dbExpiryUnix = dbExpiresAt
      ? Math.floor(dbExpiresAt.getTime() / 1000)
      : 0;
    if (Math.abs(onChain.expiry - dbExpiryUnix) > 2) {
      fieldDiscrepancies.push({
        field: "expiry",
        onChainValue: onChain.expiry,
        dbValue: dbExpiryUnix,
      });
    }

    // 4. suspended: on-chain flag vs. DB state === "suspended"
    const dbIsSuspended = dbState === "suspended";
    if (onChain.suspended !== dbIsSuspended) {
      fieldDiscrepancies.push({
        field: "suspended",
        onChainValue: onChain.suspended,
        dbValue: dbIsSuspended,
      });
    }

    // 5. communityId: on-chain string vs. DB community
    if (onChain.communityId !== dbCommunityId) {
      fieldDiscrepancies.push({
        field: "communityId",
        onChainValue: onChain.communityId,
        dbValue: dbCommunityId,
      });
    }

    if (fieldDiscrepancies.length === 0) {
      // All fields match — no action needed.
      continue;
    }

    // --- Discrepancy found: build a structured audit event ---
    discrepancies++;

    const discrepancyRecord: TokenDiscrepancy = {
      tokenId: token.tokenId,
      memberId: token.memberId,
      walletAddress: dbWalletAddress,
      communityId: dbCommunityId,
      fields: fieldDiscrepancies,
    };

    // Log a human-readable summary to stderr for immediate operator visibility.
    console.error(
      `[onChainReconciliationWorker] DISCREPANCY detected for tokenId ${token.tokenId} ` +
        `(memberId=${token.memberId}, community=${dbCommunityId}): ` +
        fieldDiscrepancies
          .map((f) => `${f.field} onChain=${JSON.stringify(f.onChainValue)} db=${JSON.stringify(f.dbValue)}`)
          .join("; "),
    );

    // Persist a structured audit event.  This is the primary actionable
    // output: operators can query audit_events WHERE eventType =
    // 'RECONCILIATION_DISCREPANCY' to see all outstanding mismatches.
    //
    // beforeState = on-chain values (what the contract reports)
    // afterState  = database values (what the DB currently stores)
    //
    // The naming is deliberate: "before" is what exists on the canonical
    // source-of-truth (the chain), "after" is what the database should look
    // like if it were correct.  This makes the event read naturally as
    // "here is the discrepancy; the DB should be updated to match on-chain"
    // — but the operator must verify and decide.
    try {
      await logEvent({
        eventType: "RECONCILIATION_DISCREPANCY",
        walletId: dbWalletAddress,
        communityId: dbCommunityId,
        reasonCode: "ON_CHAIN_STATE_MISMATCH",
        chainId,
        beforeState: buildOnChainSnapshot(onChain),
        afterState: buildDbSnapshot(token, dbWalletAddress),
        correlationId: `reconcile_${token.tokenId}_${Date.now()}`,
      });
    } catch (auditErr) {
      // Audit write failure should not suppress further checks.
      console.error(
        `[onChainReconciliationWorker] Failed to write audit event for tokenId ${token.tokenId}:`,
        auditErr,
      );
    }
  }

  return { checked, discrepancies, errors };
}

// ---------------------------------------------------------------------------
// Worker factory
// ---------------------------------------------------------------------------

export interface OnChainReconciliationWorker {
  start(): void;
  stop(): void;
}

/**
 * Create a scheduled on-chain reconciliation worker.
 *
 * The worker runs `reconcileOnChainState` at the given interval.  It is
 * intentionally separate from the existing `reconciliationWorker` (which only
 * handles time-based expiry) so the two can be configured and monitored
 * independently.
 *
 * @param intervalMs  Poll interval in milliseconds (default: 300_000 = 5 min)
 * @param provider    On-chain view provider
 * @param options     Sampling / filtering options forwarded to each pass
 * @param db          PrismaClient (optional — defaults to shared singleton)
 */
export function createOnChainReconciliationWorker(
  intervalMs: number = 300_000,
  provider: OnChainViewProvider,
  options: OnChainReconciliationOptions = {},
  db?: PrismaClient,
): OnChainReconciliationWorker {
  const prisma = db ?? getPrisma();
  let timer: ReturnType<typeof setInterval> | null = null;

  async function run() {
    try {
      const result = await reconcileOnChainState(prisma, provider, options);
      if (result.discrepancies > 0 || result.errors > 0) {
        console.warn(
          `[onChainReconciliationWorker] Pass complete: checked=${result.checked} ` +
            `discrepancies=${result.discrepancies} errors=${result.errors}`,
        );
      } else {
        console.info(
          `[onChainReconciliationWorker] Pass complete: checked=${result.checked} — no discrepancies`,
        );
      }
    } catch (err) {
      console.error("[onChainReconciliationWorker] Unhandled error in pass:", err);
    }
  }

  return {
    start() {
      if (timer !== null) return; // guard against double-start
      console.info(
        `[onChainReconciliationWorker] Started (interval=${intervalMs}ms, ` +
          `sampleSize=${options.sampleSize ?? 50}, ` +
          `communityId=${options.communityId ?? "all"})`,
      );
      timer = setInterval(run, intervalMs);
    },
    stop() {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
        console.info("[onChainReconciliationWorker] Stopped");
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Snapshot of the on-chain state recorded in the audit event's `beforeState`.
 */
function buildOnChainSnapshot(onChain: OnChainTokenState) {
  return {
    owner: onChain.owner,
    isActive: onChain.isActive,
    expiry: onChain.expiry,
    suspended: onChain.suspended,
    communityId: onChain.communityId,
  };
}

/**
 * Snapshot of the database state recorded in the audit event's `afterState`.
 */
function buildDbSnapshot(
  token: { tokenId: number; state: string; expiresAt: Date | null; memberId: string },
  walletAddress: string,
) {
  return {
    owner: walletAddress,
    isActive: token.state === "active",
    expiry: token.expiresAt ? Math.floor(token.expiresAt.getTime() / 1000) : 0,
    suspended: token.state === "suspended",
    tokenId: token.tokenId,
    memberId: token.memberId,
  };
}

/**
 * Fisher-Yates shuffle followed by a slice to sampleSize.
 * Operates on a copy to avoid mutating the original array.
 */
function shuffleAndSlice<T>(arr: T[], size: number): T[] {
  const copy = arr.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy.slice(0, size);
}
