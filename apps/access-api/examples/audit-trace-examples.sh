#!/bin/bash

# Audit Chain of Custody Examples
# Demonstrates querying complete audit trails

API_BASE="http://localhost:3000"

echo "=== Audit Chain of Custody Examples ==="
echo ""

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[0;33m'
NC='\033[0m' # No Color

# Example 1: Query audit trace by correlation ID
echo -e "${BLUE}Example 1: Query Audit Trace by Correlation ID${NC}"
echo -e "${YELLOW}Note: Replace CORRELATION_ID with actual ID from logs/database${NC}"
CORRELATION_ID="example-correlation-id"

curl -s -X GET "$API_BASE/admin/audit/trace/$CORRELATION_ID" | jq '{
  correlationId,
  summary,
  originatingOnChainEvent: .originatingOnChainEvent | {chainId, txHash, blockNumber, logIndex},
  databaseMutations: .databaseMutations | length,
  outboxEvents: .outboxEvents | length,
  accessDecisions: .accessDecisions | length
}'
echo ""

# Example 2: Query audit trace by transaction hash
echo -e "${BLUE}Example 2: Query Audit Traces by Transaction Hash${NC}"
echo -e "${YELLOW}Note: Replace TX_HASH with actual transaction hash${NC}"
TX_HASH="0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890"

curl -s -X GET "$API_BASE/admin/audit/trace/tx/$TX_HASH" | jq '{
  txHash,
  count,
  traces: .traces | map({
    correlationId,
    summary,
    hasOnChainOrigin: .summary.hasOnChainOrigin
  })
}'
echo ""

# Example 3: Query audit trace by wallet
echo -e "${BLUE}Example 3: Query Audit Traces by Wallet${NC}"
WALLET="0xalice"
COMMUNITY_ID="guild-dev"

curl -s -X GET "$API_BASE/admin/audit/trace/wallet/$WALLET?communityId=$COMMUNITY_ID&limit=10" | jq '{
  wallet,
  communityId,
  count,
  recentTraces: .traces | map({
    correlationId,
    eventTypes: .summary.eventTypes,
    totalEvents: .summary.totalEvents,
    hasOnChainOrigin: .summary.hasOnChainOrigin
  }) | .[0:3]
}'
echo ""

# Example 4: Detailed trace with on-chain origin
echo -e "${BLUE}Example 4: Detailed Trace Analysis${NC}"
echo -e "${YELLOW}This shows the complete chain from blockchain to access decision${NC}"

# Mock response structure
cat << 'EOF' | jq '.'
{
  "correlationId": "0xabc...def_5_1721189760000",
  "originatingOnChainEvent": {
    "chainId": 1,
    "txHash": "0xabc...def",
    "blockNumber": 12345678,
    "logIndex": 5
  },
  "databaseMutations": [
    {
      "id": "audit-uuid-1",
      "eventType": "MEMBERSHIP_CREATED",
      "walletId": "0xalice",
      "communityId": "guild-dev",
      "beforeState": null,
      "afterState": {
        "tokenId": 123,
        "state": "active",
        "expiresAt": "2026-08-17T00:00:00.000Z"
      },
      "onChainEvent": {
        "chainId": 1,
        "txHash": "0xabc...def",
        "blockNumber": 12345678,
        "logIndex": 5
      },
      "createdAt": "2026-07-17T12:00:00.000Z"
    }
  ],
  "outboxEvents": [
    {
      "id": "outbox-uuid-1",
      "eventType": "MEMBERSHIP_CREATED",
      "entityId": "membership-uuid",
      "entityType": "Membership",
      "communityId": "guild-dev",
      "payload": {
        "memberId": "member-uuid",
        "tokenId": 123,
        "wallet": "0xalice",
        "expiresAt": "2026-08-17T00:00:00.000Z"
      },
      "status": "delivered",
      "onChainEvent": {
        "chainId": 1,
        "txHash": "0xabc...def",
        "blockNumber": 12345678,
        "logIndex": 5
      },
      "createdAt": "2026-07-17T12:00:00.000Z"
    }
  ],
  "accessDecisions": [
    {
      "decision": "ALLOW",
      "resource": "dashboard",
      "policyRule": "MEMBERS_ONLY",
      "reasonCode": "HAS_ACTIVE_MEMBERSHIP",
      "membershipState": {
        "id": "membership-uuid",
        "tokenId": 123,
        "state": "active",
        "expiresAt": "2026-08-17T00:00:00.000Z",
        "effectiveState": "active"
      },
      "roleState": [
        {
          "id": "role-uuid",
          "role": "member",
          "source": "auto",
          "active": true,
          "expiresAt": null
        }
      ],
      "auditEvent": {
        "id": "audit-uuid-2",
        "eventType": "ACCESS_CHECK",
        "createdAt": "2026-07-17T12:05:00.000Z"
      }
    }
  ],
  "summary": {
    "totalEvents": 3,
    "hasOnChainOrigin": true,
    "eventTypes": ["MEMBERSHIP_CREATED", "ACCESS_CHECK"]
  }
}
EOF

echo ""

# Example 5: Integration with Governance
echo -e "${BLUE}Example 5: Audit Trail for Governance Decisions${NC}"
echo -e "${YELLOW}Shows how governance rule evaluations are audited${NC}"

cat << 'EOF' | jq '.'
{
  "correlationId": "access_guild-dev_0xalice_proposal-voting_1721189860000",
  "originatingOnChainEvent": null,
  "databaseMutations": [
    {
      "id": "audit-uuid-3",
      "eventType": "ACCESS_CHECK",
      "walletId": "0xalice",
      "communityId": "guild-dev",
      "resource": "proposal-voting",
      "policyRule": "GOVERNANCE_RULE",
      "decision": "ALLOW",
      "reasonCode": "CONTRIBUTOR_HIGH_SCORE",
      "membershipStateVersion": "{\"id\":\"mem-123\",\"state\":\"active\",\"tokenId\":456}",
      "roleStateVersion": "[{\"role\":\"contributor\",\"active\":true}]",
      "afterState": {
        "evaluation": {
          "ruleType": "OR",
          "evaluated": true,
          "details": "1 of 2 conditions passed",
          "children": [
            {"ruleType": "HasRole", "evaluated": false},
            {
              "ruleType": "AND",
              "evaluated": true,
              "children": [
                {"ruleType": "HasRole", "evaluated": true},
                {"ruleType": "MinContributionScore", "evaluated": true}
              ]
            }
          ]
        }
      },
      "createdAt": "2026-07-17T12:10:00.000Z"
    }
  ],
  "outboxEvents": [
    {
      "id": "outbox-uuid-2",
      "eventType": "ACCESS_DECISION",
      "entityId": "0xalice",
      "entityType": "AccessDecision",
      "communityId": "guild-dev",
      "payload": {
        "walletId": "0xalice",
        "resource": "proposal-voting",
        "decision": "ALLOW",
        "governanceRuleId": "rule-uuid",
        "membershipStateVersion": "{...}",
        "roleStateVersion": "[...]"
      },
      "status": "pending",
      "createdAt": "2026-07-17T12:10:00.000Z"
    }
  ],
  "accessDecisions": [
    {
      "decision": "ALLOW",
      "resource": "proposal-voting",
      "policyRule": "GOVERNANCE_RULE",
      "membershipState": {
        "id": "mem-123",
        "state": "active",
        "tokenId": 456
      },
      "roleState": [
        {"role": "contributor", "active": true}
      ]
    }
  ],
  "summary": {
    "totalEvents": 2,
    "hasOnChainOrigin": false,
    "eventTypes": ["ACCESS_CHECK"]
  }
}
EOF

echo ""

# Example 6: Tracing approval workflow
echo -e "${BLUE}Example 6: Audit Trail for Multi-Party Approval${NC}"
echo -e "${YELLOW}Demonstrates traceability of approval decisions${NC}"

cat << 'EOF' | jq '.'
{
  "approvalRequest": {
    "id": "request-uuid",
    "ruleId": "rule-uuid",
    "requesterWallet": "0xproposer",
    "status": "approved",
    "createdAt": "2026-07-17T10:00:00.000Z"
  },
  "approvals": [
    {
      "id": "approval-1",
      "approverWallet": "0xadmin1",
      "approverRole": "admin",
      "approved": true,
      "timestamp": "2026-07-17T10:05:00.000Z",
      "auditTraceCorrelationId": "approval_admin1_request-uuid_timestamp"
    },
    {
      "id": "approval-2",
      "approverWallet": "0xadmin2",
      "approverRole": "admin",
      "approved": true,
      "timestamp": "2026-07-17T10:10:00.000Z",
      "auditTraceCorrelationId": "approval_admin2_request-uuid_timestamp"
    }
  ],
  "finalEvaluation": {
    "correlationId": "eval_request-uuid_1721189900000",
    "allowed": true,
    "trace": {
      "ruleType": "RequiresApprovals",
      "evaluated": true,
      "details": "Has 2 of 2 required approvals from role 'admin'",
      "metadata": {
        "requiredThreshold": 2,
        "approvalCount": 2,
        "approverWallets": ["0xadmin1", "0xadmin2"]
      }
    }
  }
}
EOF

echo ""

echo -e "${GREEN}=== All audit trace examples completed ===${NC}"
echo ""
echo -e "${YELLOW}Tips:${NC}"
echo "1. Replace placeholder IDs with actual values from your database"
echo "2. Use correlation IDs to trace complete event chains"
echo "3. Query by transaction hash to see all events from a blockchain transaction"
echo "4. Query by wallet to see a user's activity history"
echo "5. Combine audit trails with governance evaluations for complete transparency"
