export interface VotingTally {
  for: bigint;
  against: bigint;
  abstain: bigint;
}

export interface QuorumConfiguration {
  totalEligibleVotingPower: bigint;
  quorumThresholdBasisPoints: number; // 0 to 10000 (100.00%)
  approvalThresholdBasisPoints: number; // 0 to 10000
  abstentionsCountTowardQuorum: boolean;
  abstentionsCountTowardApprovalDenominator: boolean;
  allowExcessiveVotingPower?: boolean;
}

export interface QuorumResult {
  quorumPassed: boolean;
  approvalPassed: boolean;
  totalVotesCast: bigint;
  quorumVotesCast: bigint;
  approvalVotesNumerator: bigint;
  approvalVotesDenominator: bigint;
  requiredQuorum: bigint;
  requiredApproval: bigint;
  reason?: string;
}

export function evaluateQuorum(
  tally: VotingTally,
  config: QuorumConfiguration
): QuorumResult {
  if (tally.for < 0n || tally.against < 0n || tally.abstain < 0n) {
    throw new Error("Voting tally values cannot be negative.");
  }

  if (config.totalEligibleVotingPower < 0n) {
    throw new Error("Total eligible voting power cannot be negative.");
  }

  if (
    config.quorumThresholdBasisPoints < 0 ||
    config.quorumThresholdBasisPoints > 10000 ||
    !Number.isInteger(config.quorumThresholdBasisPoints)
  ) {
    throw new Error("Quorum threshold basis points must be an integer between 0 and 10000.");
  }

  if (
    config.approvalThresholdBasisPoints < 0 ||
    config.approvalThresholdBasisPoints > 10000 ||
    !Number.isInteger(config.approvalThresholdBasisPoints)
  ) {
    throw new Error("Approval threshold basis points must be an integer between 0 and 10000.");
  }

  const totalVotesCast = tally.for + tally.against + tally.abstain;

  if (
    !config.allowExcessiveVotingPower &&
    totalVotesCast > config.totalEligibleVotingPower
  ) {
    throw new Error("Total votes cast exceed total eligible voting power.");
  }

  const quorumVotesCast =
    tally.for +
    tally.against +
    (config.abstentionsCountTowardQuorum ? tally.abstain : 0n);

  const approvalVotesNumerator = tally.for;
  const approvalVotesDenominator =
    tally.for +
    tally.against +
    (config.abstentionsCountTowardApprovalDenominator ? tally.abstain : 0n);

  const requiredQuorumVotesTimes10000 =
    config.totalEligibleVotingPower * BigInt(config.quorumThresholdBasisPoints);
  
  const quorumPassed =
    quorumVotesCast * 10000n >= requiredQuorumVotesTimes10000;

  // Compute required threshold purely for informational return values
  // We represent the exact required value as (RequiredValue * BasisPoints) / 10000, 
  // but to keep it exact without decimal loss we return the integer ceiling or similar if requested.
  // Actually, we can return the minimum whole number of votes needed.
  // req = ceil((total * bp) / 10000) -> (total * bp + 9999) / 10000
  const requiredQuorum = (requiredQuorumVotesTimes10000 + 9999n) / 10000n;
  
  const requiredApprovalVotesTimes10000 =
    approvalVotesDenominator * BigInt(config.approvalThresholdBasisPoints);

  const requiredApproval = (requiredApprovalVotesTimes10000 + 9999n) / 10000n;

  let approvalPassed = false;
  if (approvalVotesDenominator > 0n) {
    approvalPassed =
      approvalVotesNumerator * 10000n >= requiredApprovalVotesTimes10000;
  }

  return {
    quorumPassed,
    approvalPassed,
    totalVotesCast,
    quorumVotesCast,
    approvalVotesNumerator,
    approvalVotesDenominator,
    requiredQuorum,
    requiredApproval,
  };
}
