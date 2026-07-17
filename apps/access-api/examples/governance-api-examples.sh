#!/bin/bash

# Governance API Examples
# Demonstrates complete governance workflow via REST API

API_BASE="http://localhost:3000"
COMMUNITY_ID="guild-dev"

echo "=== Governance API Examples ==="
echo ""

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Example 1: Create a simple governance rule
echo -e "${BLUE}Example 1: Create Admin-Only Rule${NC}"
RULE_1=$(curl -s -X POST "$API_BASE/v1/governance/rules" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Admin Only Access",
    "description": "Only administrators can access this resource",
    "communityId": "'$COMMUNITY_ID'",
    "resource": "admin-panel",
    "ast": {
      "type": "HasRole",
      "role": "admin"
    }
  }')

RULE_1_ID=$(echo $RULE_1 | jq -r '.id')
echo -e "${GREEN}Created rule:${NC} $RULE_1_ID"
echo ""

# Example 2: Create a complex governance rule
echo -e "${BLUE}Example 2: Create Admin OR High Contributor Rule${NC}"
RULE_2=$(curl -s -X POST "$API_BASE/v1/governance/rules" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Admin or High Contributor",
    "description": "Admins or contributors with score >= 100",
    "communityId": "'$COMMUNITY_ID'",
    "resource": "proposal-voting",
    "ast": {
      "type": "OR",
      "rules": [
        { "type": "HasRole", "role": "admin" },
        {
          "type": "AND",
          "rules": [
            { "type": "HasRole", "role": "contributor" },
            { "type": "MinContributionScore", "score": 100 }
          ]
        }
      ]
    }
  }')

RULE_2_ID=$(echo $RULE_2 | jq -r '.id')
echo -e "${GREEN}Created rule:${NC} $RULE_2_ID"
echo ""

# Example 3: List all governance rules
echo -e "${BLUE}Example 3: List All Rules for Community${NC}"
curl -s -X GET "$API_BASE/v1/governance/communities/$COMMUNITY_ID/rules" | jq '.rules[] | {id, name, description}'
echo ""

# Example 4: Get a specific rule
echo -e "${BLUE}Example 4: Get Rule Details${NC}"
curl -s -X GET "$API_BASE/v1/governance/rules/$RULE_1_ID" | jq '{id, name, description, ast}'
echo ""

# Example 5: Update contribution score
echo -e "${BLUE}Example 5: Update Contribution Score${NC}"
curl -s -X PUT "$API_BASE/v1/governance/contribution-scores/0xalice" \
  -H "Content-Type: application/json" \
  -d '{
    "communityId": "'$COMMUNITY_ID'",
    "totalScore": 150,
    "breakdown": {
      "commits": 100,
      "reviews": 30,
      "proposals": 20
    }
  }' | jq '{walletId, communityId, totalScore, breakdown}'
echo ""

# Example 6: Get contribution score
echo -e "${BLUE}Example 6: Get Contribution Score${NC}"
curl -s -X GET "$API_BASE/v1/governance/contribution-scores/0xalice?communityId=$COMMUNITY_ID" | jq '.score'
echo ""

# Example 7: Evaluate a simple rule
echo -e "${BLUE}Example 7: Evaluate Admin-Only Rule (as admin)${NC}"
curl -s -X POST "$API_BASE/v1/governance/rules/$RULE_1_ID/evaluate" \
  -H "Content-Type: application/json" \
  -d '{
    "wallet": "0xadmin",
    "communityId": "'$COMMUNITY_ID'"
  }' | jq '{allowed, trace: .trace.details}'
echo ""

# Example 8: Evaluate a complex rule
echo -e "${BLUE}Example 8: Evaluate Admin OR Contributor Rule (as contributor)${NC}"
curl -s -X POST "$API_BASE/v1/governance/rules/$RULE_2_ID/evaluate" \
  -H "Content-Type: application/json" \
  -d '{
    "wallet": "0xalice",
    "communityId": "'$COMMUNITY_ID'"
  }' | jq '{allowed, formattedTrace}'
echo ""

# Example 9: Create multi-party approval rule
echo -e "${BLUE}Example 9: Create Multi-Party Approval Rule${NC}"
RULE_3=$(curl -s -X POST "$API_BASE/v1/governance/rules" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "2-of-3 Admin Approvals",
    "description": "High-value proposals require 2 admin approvals",
    "communityId": "'$COMMUNITY_ID'",
    "resource": "high-value-proposal",
    "ast": {
      "type": "RequiresApprovals",
      "threshold": 2,
      "approverRole": "admin"
    }
  }')

RULE_3_ID=$(echo $RULE_3 | jq -r '.id')
echo -e "${GREEN}Created rule:${NC} $RULE_3_ID"
echo ""

# Example 10: Create approval request
echo -e "${BLUE}Example 10: Create Approval Request${NC}"
APPROVAL_REQUEST=$(curl -s -X POST "$API_BASE/v1/governance/approvals/requests" \
  -H "Content-Type: application/json" \
  -H "X-Wallet: 0xproposer" \
  -d '{
    "communityId": "'$COMMUNITY_ID'",
    "resource": "high-value-proposal",
    "ruleId": "'$RULE_3_ID'",
    "expiresAt": "2026-08-01T00:00:00.000Z"
  }')

REQUEST_ID=$(echo $APPROVAL_REQUEST | jq -r '.id')
echo -e "${GREEN}Created approval request:${NC} $REQUEST_ID"
echo ""

# Example 11: Submit first approval
echo -e "${BLUE}Example 11: Admin 1 Approves${NC}"
curl -s -X POST "$API_BASE/v1/governance/approvals/requests/$REQUEST_ID/approvals" \
  -H "Content-Type: application/json" \
  -H "X-Wallet: 0xadmin1" \
  -d '{
    "approved": true
  }' | jq '{id, approverWallet, approved, timestamp}'
echo ""

# Example 12: Evaluate with 1 approval (should fail - need 2)
echo -e "${BLUE}Example 12: Evaluate with 1 Approval (should fail)${NC}"
curl -s -X POST "$API_BASE/v1/governance/rules/$RULE_3_ID/evaluate" \
  -H "Content-Type: application/json" \
  -d '{
    "wallet": "0xproposer",
    "communityId": "'$COMMUNITY_ID'",
    "requestId": "'$REQUEST_ID'"
  }' | jq '{allowed, trace: .trace.details}'
echo ""

# Example 13: Submit second approval
echo -e "${BLUE}Example 13: Admin 2 Approves${NC}"
curl -s -X POST "$API_BASE/v1/governance/approvals/requests/$REQUEST_ID/approvals" \
  -H "Content-Type: application/json" \
  -H "X-Wallet: 0xadmin2" \
  -d '{
    "approved": true
  }' | jq '{id, approverWallet, approved, timestamp}'
echo ""

# Example 14: Evaluate with 2 approvals (should pass!)
echo -e "${BLUE}Example 14: Evaluate with 2 Approvals (should pass!)${NC}"
curl -s -X POST "$API_BASE/v1/governance/rules/$RULE_3_ID/evaluate" \
  -H "Content-Type: application/json" \
  -d '{
    "wallet": "0xproposer",
    "communityId": "'$COMMUNITY_ID'",
    "requestId": "'$REQUEST_ID'"
  }' | jq '{allowed, trace: .trace.details}'
echo ""

# Example 15: Get approval request details
echo -e "${BLUE}Example 15: Get Approval Request Details${NC}"
curl -s -X GET "$API_BASE/v1/governance/approvals/requests/$REQUEST_ID" | jq '{id, status, approvals: .approvals | length}'
echo ""

# Example 16: Update rule (deactivate)
echo -e "${BLUE}Example 16: Deactivate Rule${NC}"
curl -s -X PUT "$API_BASE/v1/governance/rules/$RULE_1_ID" \
  -H "Content-Type: application/json" \
  -d '{
    "active": false
  }' | jq '{id, name, active}'
echo ""

# Example 17: Delete rule
echo -e "${BLUE}Example 17: Delete Rule${NC}"
curl -s -X DELETE "$API_BASE/v1/governance/rules/$RULE_1_ID"
echo -e "${GREEN}Rule deleted${NC}"
echo ""

echo -e "${GREEN}=== All examples completed ===${NC}"
