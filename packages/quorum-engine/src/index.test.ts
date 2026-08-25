import { describe, it } from "node:test";
import * as assert from "node:assert";
import { evaluateQuorum, VotingTally, QuorumConfiguration } from "./index.js";

describe("evaluateQuorum", () => {
  it("passes quorum and approval with simple majority", () => {
    const tally: VotingTally = { for: 60n, against: 40n, abstain: 0n };
    const config: QuorumConfiguration = {
      totalEligibleVotingPower: 1000n,
      quorumThresholdBasisPoints: 1000, // 10%
      approvalThresholdBasisPoints: 5001, // > 50%
      abstentionsCountTowardQuorum: false,
      abstentionsCountTowardApprovalDenominator: false,
    };

    const result = evaluateQuorum(tally, config);
    assert.strictEqual(result.quorumPassed, true);
    assert.strictEqual(result.approvalPassed, true);
    assert.strictEqual(result.quorumVotesCast, 100n);
    assert.strictEqual(result.approvalVotesDenominator, 100n);
    assert.strictEqual(result.requiredQuorum, 100n);
    assert.strictEqual(result.requiredApproval, 51n);
  });

  it("fails approval if for is exact 50% and threshold is 5001 (50.01%)", () => {
    const tally: VotingTally = { for: 50n, against: 50n, abstain: 0n };
    const config: QuorumConfiguration = {
      totalEligibleVotingPower: 1000n,
      quorumThresholdBasisPoints: 1000,
      approvalThresholdBasisPoints: 5001,
      abstentionsCountTowardQuorum: false,
      abstentionsCountTowardApprovalDenominator: false,
    };

    const result = evaluateQuorum(tally, config);
    assert.strictEqual(result.approvalPassed, false);
    assert.strictEqual(result.requiredApproval, 51n);
  });

  it("passes approval if for is exact 50% and threshold is 5000 (50.00%)", () => {
    const tally: VotingTally = { for: 50n, against: 50n, abstain: 0n };
    const config: QuorumConfiguration = {
      totalEligibleVotingPower: 1000n,
      quorumThresholdBasisPoints: 1000,
      approvalThresholdBasisPoints: 5000,
      abstentionsCountTowardQuorum: false,
      abstentionsCountTowardApprovalDenominator: false,
    };

    const result = evaluateQuorum(tally, config);
    assert.strictEqual(result.approvalPassed, true);
    assert.strictEqual(result.requiredApproval, 50n);
  });

  it("fails quorum if below threshold", () => {
    const tally: VotingTally = { for: 9n, against: 0n, abstain: 0n };
    const config: QuorumConfiguration = {
      totalEligibleVotingPower: 100n,
      quorumThresholdBasisPoints: 1000, // 10% requires 10 votes
      approvalThresholdBasisPoints: 5000,
      abstentionsCountTowardQuorum: false,
      abstentionsCountTowardApprovalDenominator: false,
    };

    const result = evaluateQuorum(tally, config);
    assert.strictEqual(result.quorumPassed, false);
    assert.strictEqual(result.requiredQuorum, 10n);
  });

  it("abstentions count toward quorum when enabled", () => {
    const tally: VotingTally = { for: 0n, against: 0n, abstain: 10n };
    const config: QuorumConfiguration = {
      totalEligibleVotingPower: 100n,
      quorumThresholdBasisPoints: 1000,
      approvalThresholdBasisPoints: 5000,
      abstentionsCountTowardQuorum: true,
      abstentionsCountTowardApprovalDenominator: false,
    };

    const result = evaluateQuorum(tally, config);
    assert.strictEqual(result.quorumPassed, true);
    assert.strictEqual(result.quorumVotesCast, 10n);
  });

  it("abstentions do not count toward quorum when disabled", () => {
    const tally: VotingTally = { for: 0n, against: 0n, abstain: 10n };
    const config: QuorumConfiguration = {
      totalEligibleVotingPower: 100n,
      quorumThresholdBasisPoints: 1000,
      approvalThresholdBasisPoints: 5000,
      abstentionsCountTowardQuorum: false,
      abstentionsCountTowardApprovalDenominator: false,
    };

    const result = evaluateQuorum(tally, config);
    assert.strictEqual(result.quorumPassed, false);
    assert.strictEqual(result.quorumVotesCast, 0n);
  });

  it("abstentions count toward approval denominator when enabled", () => {
    const tally: VotingTally = { for: 50n, against: 0n, abstain: 50n };
    const config: QuorumConfiguration = {
      totalEligibleVotingPower: 100n,
      quorumThresholdBasisPoints: 1000,
      approvalThresholdBasisPoints: 5001,
      abstentionsCountTowardQuorum: true,
      abstentionsCountTowardApprovalDenominator: true,
    };

    const result = evaluateQuorum(tally, config);
    // Denominator is 100, requires 51, got 50, so fails
    assert.strictEqual(result.approvalPassed, false);
    assert.strictEqual(result.approvalVotesDenominator, 100n);
    assert.strictEqual(result.requiredApproval, 51n);
  });

  it("abstentions do not count toward approval denominator when disabled", () => {
    const tally: VotingTally = { for: 50n, against: 0n, abstain: 50n };
    const config: QuorumConfiguration = {
      totalEligibleVotingPower: 100n,
      quorumThresholdBasisPoints: 1000,
      approvalThresholdBasisPoints: 5001,
      abstentionsCountTowardQuorum: true,
      abstentionsCountTowardApprovalDenominator: false,
    };

    const result = evaluateQuorum(tally, config);
    // Denominator is 50, requires 26, got 50, so passes
    assert.strictEqual(result.approvalPassed, true);
    assert.strictEqual(result.approvalVotesDenominator, 50n);
    assert.strictEqual(result.requiredApproval, 26n);
  });

  it("handles zero eligible voting power safely", () => {
    const tally: VotingTally = { for: 0n, against: 0n, abstain: 0n };
    const config: QuorumConfiguration = {
      totalEligibleVotingPower: 0n,
      quorumThresholdBasisPoints: 1000,
      approvalThresholdBasisPoints: 5000,
      abstentionsCountTowardQuorum: false,
      abstentionsCountTowardApprovalDenominator: false,
    };

    const result = evaluateQuorum(tally, config);
    assert.strictEqual(result.quorumPassed, true);
    assert.strictEqual(result.approvalPassed, false);
    assert.strictEqual(result.requiredQuorum, 0n);
    assert.strictEqual(result.requiredApproval, 0n);
  });

  it("fails if cast votes exceed eligible without allowExcessiveVotingPower", () => {
    const tally: VotingTally = { for: 100n, against: 10n, abstain: 0n };
    const config: QuorumConfiguration = {
      totalEligibleVotingPower: 100n,
      quorumThresholdBasisPoints: 1000,
      approvalThresholdBasisPoints: 5000,
      abstentionsCountTowardQuorum: false,
      abstentionsCountTowardApprovalDenominator: false,
    };

    assert.throws(() => evaluateQuorum(tally, config), /Total votes cast exceed total eligible/);
  });

  it("passes if cast votes exceed eligible with allowExcessiveVotingPower", () => {
    const tally: VotingTally = { for: 100n, against: 10n, abstain: 0n };
    const config: QuorumConfiguration = {
      totalEligibleVotingPower: 100n,
      quorumThresholdBasisPoints: 1000,
      approvalThresholdBasisPoints: 5000,
      abstentionsCountTowardQuorum: false,
      abstentionsCountTowardApprovalDenominator: false,
      allowExcessiveVotingPower: true,
    };

    const result = evaluateQuorum(tally, config);
    assert.strictEqual(result.quorumPassed, true);
    assert.strictEqual(result.approvalPassed, true);
  });

  it("throws on negative tally values", () => {
    const tally: VotingTally = { for: -1n, against: 0n, abstain: 0n };
    const config: QuorumConfiguration = {
      totalEligibleVotingPower: 100n,
      quorumThresholdBasisPoints: 1000,
      approvalThresholdBasisPoints: 5000,
      abstentionsCountTowardQuorum: false,
      abstentionsCountTowardApprovalDenominator: false,
    };

    assert.throws(() => evaluateQuorum(tally, config), /cannot be negative/);
  });

  it("throws on invalid basis points", () => {
    const tally: VotingTally = { for: 10n, against: 0n, abstain: 0n };
    assert.throws(() => evaluateQuorum(tally, {
      totalEligibleVotingPower: 100n,
      quorumThresholdBasisPoints: 10001,
      approvalThresholdBasisPoints: 5000,
      abstentionsCountTowardQuorum: false,
      abstentionsCountTowardApprovalDenominator: false,
    }), /between 0 and 10000/);

    assert.throws(() => evaluateQuorum(tally, {
      totalEligibleVotingPower: 100n,
      quorumThresholdBasisPoints: 1000,
      approvalThresholdBasisPoints: 100.5,
      abstentionsCountTowardQuorum: false,
      abstentionsCountTowardApprovalDenominator: false,
    }), /must be an integer/);
  });

  it("handles very large bigint values safely", () => {
    const billion = 1000000000n;
    const veryLarge = billion * billion * billion; // 10^27
    const tally: VotingTally = { for: veryLarge, against: veryLarge, abstain: 0n };
    const config: QuorumConfiguration = {
      totalEligibleVotingPower: veryLarge * 2n,
      quorumThresholdBasisPoints: 1000,
      approvalThresholdBasisPoints: 5000,
      abstentionsCountTowardQuorum: false,
      abstentionsCountTowardApprovalDenominator: false,
    };

    const result = evaluateQuorum(tally, config);
    assert.strictEqual(result.quorumPassed, true);
    assert.strictEqual(result.approvalPassed, true);
  });
});
