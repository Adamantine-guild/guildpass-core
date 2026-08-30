import { createHash } from 'node:crypto';

export interface VotingPowerSource {
  participantId: string;
  sourceId: string;
  power: bigint;
}

export interface ParticipantSnapshot {
  participantId: string;
  power: bigint;
}

export interface SnapshotResult {
  participants: ParticipantSnapshot[];
  totalVotingPower: bigint;
  fingerprint?: string;
}

export interface SnapshotOptions {
  computeFingerprint?: boolean;
}

export class ValidationError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

export function calculateSnapshot(
  sources: readonly VotingPowerSource[],
  options?: SnapshotOptions
): SnapshotResult {
  const sourceIds = new Set<string>();
  const participantMap = new Map<string, bigint>();
  let totalVotingPower = 0n;

  for (const source of sources) {
    if (source.power < 0n) {
      throw new ValidationError(
        'NEGATIVE_POWER',
        `Negative power for source ${source.sourceId}`
      );
    }

    if (sourceIds.has(source.sourceId)) {
      throw new ValidationError(
        'DUPLICATE_SOURCE_ID',
        `Duplicate source ID: ${source.sourceId}`
      );
    }
    sourceIds.add(source.sourceId);

    const currentPower = participantMap.get(source.participantId) ?? 0n;
    participantMap.set(source.participantId, currentPower + source.power);
    totalVotingPower += source.power;
  }

  const participants: ParticipantSnapshot[] = Array.from(participantMap.entries())
    .map(([participantId, power]) => ({ participantId, power }))
    .sort((a, b) => {
      if (a.participantId < b.participantId) return -1;
      if (a.participantId > b.participantId) return 1;
      return 0;
    });

  let fingerprint: string | undefined;

  if (options?.computeFingerprint) {
    const hash = createHash('sha256');
    for (const p of participants) {
      hash.update(`${p.participantId}:${p.power.toString()}\n`);
    }
    hash.update(`total:${totalVotingPower.toString()}\n`);
    fingerprint = hash.digest('hex');
  }

  const result: SnapshotResult = {
    participants,
    totalVotingPower,
  };

  if (fingerprint !== undefined) {
    result.fingerprint = fingerprint;
  }

  return result;
}
