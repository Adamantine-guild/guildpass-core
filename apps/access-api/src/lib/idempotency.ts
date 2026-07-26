/**
 * idempotency.ts
 *
 * Client-facing request idempotency for mutating /v1 routes (issue #184).
 *
 * The outbox pattern (see services/outboxService.ts) already guarantees no
 * *outbound* integration event is lost. It says nothing about the *inbound*
 * HTTP request: a client that retries a POST/PATCH/DELETE after a
 * successful-but-unacknowledged response (a very common pattern for
 * webhook-driven integrations, e.g. Discord bots reacting to a timeout)
 * would otherwise re-execute the mutation and emit a second outbox event.
 *
 * Usage: attach both hooks to a route's options —
 *
 *   app.post(
 *     '/v1/communities/:communityId/members/:wallet/roles',
 *     {
 *       schema: assignMemberRoleSchema,
 *       preHandler: [authenticateApiKey, idempotencyPreHandler],
 *       onSend: [idempotencyOnSend],
 *     },
 *     handler,
 *   );
 *
 * Design:
 *   - The Idempotency-Key header is optional. Requests without it behave
 *     exactly as before — this is additive, not a breaking change.
 *   - When present, the (key, route) pair is looked up in the IdempotencyKey
 *     table. A hit with a matching requestHash short-circuits straight to
 *     the cached response. A hit with a different requestHash is a 409 —
 *     the same key was reused for a different logical request. A miss
 *     inserts a "pending" row (unique on (key, route)) and lets the handler
 *     run; onSend then fills in the response and flips it to "completed".
 *   - The unique constraint on (key, route) is what resolves the race
 *     between two truly concurrent retries that both miss the initial
 *     SELECT: the loser's INSERT fails with P2002 and is told the request
 *     is already in flight (409) instead of double-executing the mutation.
 *   - This does not wrap the domain mutation's own Prisma $transaction —
 *     service methods each manage their own transaction internally (see
 *     memberService.ts, resourceService.ts). Instead the *pending* row is
 *     written before the handler runs and the *completed* row is written
 *     in onSend, once the mutation (and its outbox write) has already
 *     committed. A crash between those two points simply leaves a stale
 *     "pending" row, which cleanupExpiredIdempotencyKeys reaps via TTL —
 *     the retried request then re-executes exactly once, which is safe
 *     because the original attempt never committed a response either.
 */
import crypto from "crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { conflict } from "../errors";

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24h

declare module "fastify" {
  interface FastifyRequest {
    idempotencyRecordId?: string;
  }
}

/** Deterministic stringify so key ordering in the body never changes the hash. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value ?? null);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys
    .map(
      (k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`,
    )
    .join(",")}}`;
}

export function hashRequestBody(body: unknown): string {
  return crypto.createHash("sha256").update(stableStringify(body ?? {})).digest("hex");
}

/** "<METHOD> <route pattern>", e.g. "POST /v1/communities/:communityId/members/:wallet/roles" */
export function routeIdentifier(request: FastifyRequest): string {
  const pattern =
    (request as any).routeOptions?.url ??
    (request as any).routerPath ??
    request.url.split("?")[0];
  return `${request.method} ${pattern}`;
}

function getIdempotencyKeyHeader(request: FastifyRequest): string | undefined {
  const header = request.headers["idempotency-key"];
  const value = Array.isArray(header) ? header[0] : header;
  return value && value.trim() ? value.trim() : undefined;
}

/**
 * preHandler: resolves an Idempotency-Key header against prior outcomes for
 * this route before the mutation runs.
 */
export function createIdempotencyPreHandler(prisma: PrismaClient) {
  return async function idempotencyPreHandler(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const key = getIdempotencyKeyHeader(request);
    if (!key) return; // Idempotency-Key is opt-in; no header means no dedup.

    const route = routeIdentifier(request);
    const requestHash = hashRequestBody(request.body);

    const existing = await (prisma as any).idempotencyKey.findUnique({
      where: { key_route: { key, route } },
    });

    if (existing) {
      if (existing.requestHash !== requestHash) {
        await reply
          .status(409)
          .send(
            conflict(
              "This Idempotency-Key was already used with a different request payload",
            ),
          );
        return;
      }

      if (existing.status === "completed") {
        await reply.status(existing.responseStatus ?? 200).send(existing.responseBody ?? {});
        return;
      }

      // Same key, same payload, but the original request hasn't finished
      // (still "pending") — this is a genuinely concurrent retry racing the
      // first attempt, not the "retry after timeout" case. Tell the caller
      // to back off rather than let two copies of the mutation run at once.
      await reply
        .status(409)
        .send(conflict("A request with this Idempotency-Key is already in progress"));
      return;
    }

    try {
      const created = await (prisma as any).idempotencyKey.create({
        data: {
          key,
          route,
          requestHash,
          status: "pending",
          expiresAt: new Date(Date.now() + DEFAULT_TTL_MS),
        },
      });
      request.idempotencyRecordId = created.id;
    } catch (err: any) {
      // Unique constraint race: another concurrent request won the insert.
      if (err?.code === "P2002") {
        await reply
          .status(409)
          .send(conflict("A request with this Idempotency-Key is already in progress"));
        return;
      }
      throw err;
    }
  };
}

/**
 * onSend: records the mutation's outcome against the pending row created by
 * idempotencyPreHandler, so subsequent replays of the same key return the
 * identical response instead of re-executing.
 */
export function createIdempotencyOnSend(prisma: PrismaClient) {
  return async function idempotencyOnSend(
    request: FastifyRequest,
    reply: FastifyReply,
    payload: unknown,
  ): Promise<unknown> {
    const recordId = request.idempotencyRecordId;
    if (!recordId) return payload;

    // 5xx responses mean the mutation may not have committed at all (or
    // failed for a transient reason) — drop the pending row so a retry with
    // the same key is free to actually re-attempt the mutation instead of
    // being stuck behind a dead "pending" record until it expires.
    if (reply.statusCode >= 500) {
      await (prisma as any).idempotencyKey.delete({ where: { id: recordId } }).catch(() => {});
      return payload;
    }

    let responseBody: unknown = payload;
    if (typeof payload === "string") {
      try {
        responseBody = JSON.parse(payload);
      } catch {
        responseBody = payload;
      }
    }

    await (prisma as any).idempotencyKey
      .update({
        where: { id: recordId },
        data: {
          status: "completed",
          responseStatus: reply.statusCode,
          responseBody: responseBody as any,
        },
      })
      .catch(() => {});

    return payload;
  };
}

/**
 * Deletes expired IdempotencyKey rows. Intended to be run on a schedule
 * alongside the existing background workers (see src/workers/) — e.g. a
 * periodic call from the same process that runs outboxWorker, or a small
 * standalone cron entrypoint.
 */
export async function cleanupExpiredIdempotencyKeys(prisma: PrismaClient): Promise<number> {
  const result = await (prisma as any).idempotencyKey.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  });
  return result.count;
}
