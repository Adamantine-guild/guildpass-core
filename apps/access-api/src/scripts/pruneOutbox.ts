import { disconnectPrisma, getPrisma } from "../services/prisma";
import {
  DEFAULT_OUTBOX_RETENTION_MS,
  pruneOutboxEvents,
} from "../services/outboxService";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DEFAULT_RETENTION_DAYS = DEFAULT_OUTBOX_RETENTION_MS / MS_PER_DAY;

export function parseRetentionDays(
  argv: string[],
  envValue: string | undefined = process.env.OUTBOX_RETENTION_DAYS,
): number {
  let rawValue = envValue;

  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--days") {
      rawValue = argv[index + 1];
      if (rawValue === undefined) {
        throw new Error("--days requires a value");
      }
      index++;
      continue;
    }
    if (argument.startsWith("--days=")) {
      rawValue = argument.slice("--days=".length);
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }

  if (rawValue === undefined || rawValue.trim() === "") {
    return DEFAULT_RETENTION_DAYS;
  }

  const days = Number(rawValue);
  if (!Number.isFinite(days) || days <= 0) {
    throw new Error("Retention days must be a number greater than zero");
  }
  return days;
}

export async function runPruneOutbox(
  argv: string[] = process.argv.slice(2),
): Promise<number> {
  const days = parseRetentionDays(argv);
  const retentionMs = days * MS_PER_DAY;
  const deleted = await pruneOutboxEvents(getPrisma(), retentionMs);

  console.log(
    `[outbox:prune] Deleted ${deleted} delivered event(s) older than ${days} day(s).`,
  );
  return deleted;
}

if (require.main === module) {
  runPruneOutbox()
    .catch((error) => {
      console.error(
        "[outbox:prune] Pruning failed:",
        error instanceof Error ? error.message : error,
      );
      process.exitCode = 1;
    })
    .finally(disconnectPrisma);
}
