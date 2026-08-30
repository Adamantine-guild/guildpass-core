import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateSnapshot,
  ValidationError,
  VotingPowerSource
} from './index.js';

describe('calculateSnapshot', () => {
  it('should aggregate voting power correctly per participant', () => {
    const sources: VotingPowerSource[] = [
      { participantId: 'alice', sourceId: 's1', power: 100n },
      { participantId: 'bob', sourceId: 's2', power: 50n },
      { participantId: 'alice', sourceId: 's3', power: 200n },
    ];

    const result = calculateSnapshot(sources);
    assert.equal(result.totalVotingPower, 350n);
    assert.equal(result.participants.length, 2);
    
    assert.equal(result.participants[0].participantId, 'alice');
    assert.equal(result.participants[0].power, 300n);
    
    assert.equal(result.participants[1].participantId, 'bob');
    assert.equal(result.participants[1].power, 50n);
  });

  it('should reject duplicate source records', () => {
    const sources: VotingPowerSource[] = [
      { participantId: 'alice', sourceId: 's1', power: 100n },
      { participantId: 'alice', sourceId: 's1', power: 100n },
    ];

    assert.throws(() => calculateSnapshot(sources), (err: any) => {
      return err instanceof ValidationError && err.code === 'DUPLICATE_SOURCE_ID';
    });
  });

  it('should reject negative power values', () => {
    const sources: VotingPowerSource[] = [
      { participantId: 'alice', sourceId: 's1', power: -10n },
    ];

    assert.throws(() => calculateSnapshot(sources), (err: any) => {
      return err instanceof ValidationError && err.code === 'NEGATIVE_POWER';
    });
  });

  it('should handle zero-power entries correctly (include them)', () => {
    const sources: VotingPowerSource[] = [
      { participantId: 'alice', sourceId: 's1', power: 0n },
      { participantId: 'bob', sourceId: 's2', power: 50n },
    ];

    const result = calculateSnapshot(sources);
    assert.equal(result.totalVotingPower, 50n);
    assert.equal(result.participants.length, 2);
    assert.equal(result.participants[0].participantId, 'alice');
    assert.equal(result.participants[0].power, 0n);
  });

  it('should sort output deterministically regardless of input order', () => {
    const sources1: VotingPowerSource[] = [
      { participantId: 'charlie', sourceId: 's1', power: 10n },
      { participantId: 'alice', sourceId: 's2', power: 20n },
      { participantId: 'bob', sourceId: 's3', power: 30n },
    ];

    const sources2: VotingPowerSource[] = [
      { participantId: 'bob', sourceId: 's3', power: 30n },
      { participantId: 'charlie', sourceId: 's1', power: 10n },
      { participantId: 'alice', sourceId: 's2', power: 20n },
    ];

    const res1 = calculateSnapshot(sources1, { computeFingerprint: true });
    const res2 = calculateSnapshot(sources2, { computeFingerprint: true });

    assert.deepEqual(res1.participants, res2.participants);
    assert.equal(res1.fingerprint, res2.fingerprint);

    assert.equal(res1.participants[0].participantId, 'alice');
    assert.equal(res1.participants[1].participantId, 'bob');
    assert.equal(res1.participants[2].participantId, 'charlie');
  });

  it('should support very large bigint values', () => {
    const veryLarge = 123456789012345678901234567890n;
    const sources: VotingPowerSource[] = [
      { participantId: 'alice', sourceId: 's1', power: veryLarge },
      { participantId: 'alice', sourceId: 's2', power: veryLarge },
    ];

    const result = calculateSnapshot(sources);
    assert.equal(result.totalVotingPower, veryLarge * 2n);
    assert.equal(result.participants[0].power, veryLarge * 2n);
  });

  it('should not mutate the input array', () => {
    const sources = Object.freeze([
      Object.freeze({ participantId: 'bob', sourceId: 's1', power: 10n }),
      Object.freeze({ participantId: 'alice', sourceId: 's2', power: 20n }),
    ]);

    const result = calculateSnapshot(sources as readonly VotingPowerSource[]);
    assert.equal(result.participants.length, 2);
  });
});
