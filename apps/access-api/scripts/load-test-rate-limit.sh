#!/usr/bin/env bash
# ============================================================================
# Load Test: POST /v1/access/check rate limit enforcement
# ============================================================================
# Prerequisites:
#   - API running: pnpm dev  (or  DATABASE_URL=... pnpm dev)
#   - Redis running: docker-compose up -d redis
#   - curl installed
#
# Usage:
#   chmod +x scripts/load-test-rate-limit.sh
#   ./scripts/load-test-rate-limit.sh [API_URL]
#
# Verifies:
#   1. Burst of requests from one IP hits 429 with Retry-After
#   2. Burst of requests for one wallet (different IPs) hits 429 with Retry-After
# ============================================================================

set -euo pipefail

API_URL="${1:-http://localhost:3000}"
ENDPOINT="$API_URL/v1/access/check"
WALLET="0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
COMMUNITY="test-community-load"
RESOURCE="test-resource-load"

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
RESET='\033[0m'

echo ""
echo "========================================================"
echo "  GuildPass Access Check Rate Limit Load Test"
echo "  Target: $ENDPOINT"
echo "========================================================"

# -----------------------------------------------------------------------
# Test 1: IP-based burst — single IP fires many requests (distinct wallets)
# -----------------------------------------------------------------------
echo ""
echo -e "${YELLOW}TEST 1: IP burst (same IP, distinct wallets)${RESET}"
echo "Sending 120 requests from IP 10.10.10.10 (limit default: 100/min)..."

PASS_1=0
FAIL_429=0
FAIL_OTHER=0

for i in $(seq 1 120); do
  # Use zero-padded wallet to create distinct valid addresses
  ADDR=$(printf "0x%040x" $i)
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$ENDPOINT" \
    -H "Content-Type: application/json" \
    -H "X-Forwarded-For: 10.10.10.10" \
    -d "{\"wallet\":\"$ADDR\",\"communityId\":\"$COMMUNITY\",\"resource\":\"$RESOURCE\"}")
  if [ "$STATUS" = "200" ]; then
    PASS_1=$((PASS_1 + 1))
  elif [ "$STATUS" = "429" ]; then
    FAIL_429=$((FAIL_429 + 1))
  else
    FAIL_OTHER=$((FAIL_OTHER + 1))
    echo "  [!] Unexpected status $STATUS on request $i"
  fi
done

echo "  200 OK:             $PASS_1"
echo "  429 Too Many:       $FAIL_429"
echo "  Other errors:       $FAIL_OTHER"

if [ "$FAIL_429" -gt 0 ]; then
  echo -e "  ${GREEN}✓ IP rate limit enforced (got $FAIL_429 x 429 responses)${RESET}"
else
  echo -e "  ${RED}✗ IP rate limit NOT enforced (expected at least 1 x 429)${RESET}"
fi

# -----------------------------------------------------------------------
# Test 2: Wallet-based burst — same wallet from distinct IPs
# -----------------------------------------------------------------------
echo ""
echo -e "${YELLOW}TEST 2: Wallet burst (same wallet, distinct IPs)${RESET}"
echo "Sending 60 requests for $WALLET from different IPs (limit default: 50/min)..."

PASS_2=0
FAIL_429_2=0
FAIL_OTHER_2=0

for i in $(seq 1 60); do
  CLIENT_IP="172.16.$((i / 256)).$((i % 256))"
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$ENDPOINT" \
    -H "Content-Type: application/json" \
    -H "X-Forwarded-For: $CLIENT_IP" \
    -d "{\"wallet\":\"$WALLET\",\"communityId\":\"$COMMUNITY\",\"resource\":\"$RESOURCE\"}")
  if [ "$STATUS" = "200" ]; then
    PASS_2=$((PASS_2 + 1))
  elif [ "$STATUS" = "429" ]; then
    FAIL_429_2=$((FAIL_429_2 + 1))
  else
    FAIL_OTHER_2=$((FAIL_OTHER_2 + 1))
    echo "  [!] Unexpected status $STATUS on request $i"
  fi
done

echo "  200 OK:             $PASS_2"
echo "  429 Too Many:       $FAIL_429_2"
echo "  Other errors:       $FAIL_OTHER_2"

if [ "$FAIL_429_2" -gt 0 ]; then
  echo -e "  ${GREEN}✓ Wallet rate limit enforced (got $FAIL_429_2 x 429 responses)${RESET}"
else
  echo -e "  ${RED}✗ Wallet rate limit NOT enforced (expected at least 1 x 429)${RESET}"
fi

# -----------------------------------------------------------------------
# Test 3: Verify Retry-After header is present on 429
# -----------------------------------------------------------------------
echo ""
echo -e "${YELLOW}TEST 3: Verify Retry-After header on 429${RESET}"

RESPONSE=$(curl -s -i -X POST "$ENDPOINT" \
  -H "Content-Type: application/json" \
  -H "X-Forwarded-For: 10.10.10.10" \
  -d "{\"wallet\":\"$WALLET\",\"communityId\":\"$COMMUNITY\",\"resource\":\"$RESOURCE\"}" 2>&1)

HTTP_STATUS=$(echo "$RESPONSE" | grep "^HTTP/" | awk '{print $2}')
RETRY_AFTER=$(echo "$RESPONSE" | grep -i "^retry-after:" | head -1)

if [ "$HTTP_STATUS" = "429" ] && [ -n "$RETRY_AFTER" ]; then
  echo -e "  ${GREEN}✓ Got 429 with header: $RETRY_AFTER${RESET}"
elif [ "$HTTP_STATUS" = "200" ]; then
  echo -e "  ${YELLOW}⚠ Got 200 (rate window may have reset — re-run to re-trigger)${RESET}"
else
  echo -e "  ${RED}✗ Unexpected status: $HTTP_STATUS${RESET}"
fi

echo ""
echo "========================================================"
echo "  Load test complete."
echo "========================================================"
echo ""
