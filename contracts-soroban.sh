#!/usr/bin/env bash
#
# GuildPass Soroban Contracts — Build/Test/Deploy Driver
#
# Mirrors the convenience of Foundry's `forge` commands for the new Rust stack:
#   ./contracts-soroban.sh build     => cargo build --target wasm32-unknown-unknown --release
#   ./contracts-soroban.sh test      => cargo test --all-targets
#   ./contracts-soroban.sh check     => fmt + clippy (CI gating)
#   ./contracts-soroban.sh size      => wasm size report
#   ./contracts-soroban.sh deploy    => prints deploy commands (requires `soroban` CLI + secret)
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
SOROBAN_DIR="$ROOT/contracts-soroban"
CONTRACT_DIR="$SOROBAN_DIR/membership-nft"
WASM_PATH="$CONTRACT_DIR/target/wasm32-unknown-unknown/release/guildpass_membership_nft.wasm"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
log()  { echo -e "${GREEN}[soroban]${NC} $*"; }
warn() { echo -e "${YELLOW}[soroban][warn]${NC} $*"; }
fail() { echo -e "${RED}[soroban][err]${NC} $*" >&2; exit 1; }

need_cmd() { command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"; }

cmd_ensure_toolchain() {
    need_cmd rustc
    need_cmd cargo
    local msrv="1.79.0"
    local current
    current="$(rustc --version | awk '{print $2}')"
    if [[ "$(printf '%s\n' "$msrv" "$current" | sort -V | head -n1)" != "$msrv" ]]; then
        fail "rustc >= $msrv required; found $current. Run: rustup update stable"
    fi
    if ! rustup target list --installed 2>/dev/null | grep -q wasm32-unknown-unknown; then
        log "adding wasm32-unknown-unknown target…"
        rustup target add wasm32-unknown-unknown
    fi
}

cmd_build() {
    cmd_ensure_toolchain
    log "building MembershipNFT WASM (release, size-optimized)…"
    (cd "$CONTRACT_DIR" && cargo build --target wasm32-unknown-unknown --release)
    if [[ -f "$WASM_PATH" ]]; then
        local size
        size=$(stat -f%z "$WASM_PATH" 2>/dev/null || stat --printf="%s" "$WASM_PATH" 2>/dev/null || wc -c < "$WASM_PATH" | tr -d ' ')
        log "WASM ready: $WASM_PATH (${size} bytes)"
    else
        warn "build succeeded but WASM not found at expected path: $WASM_PATH"
    fi
}

cmd_test() {
    cmd_ensure_toolchain
    log "running unit + integration tests (host sim)…"
    (cd "$CONTRACT_DIR" && cargo test --all-targets -- --nocapture)
    log "all tests passed ✓"
}

cmd_check() {
    cmd_ensure_toolchain
    need_cmd rustfmt
    log "cargo fmt --check …"
    (cd "$SOROBAN_DIR" && cargo fmt --all -- --check) || fail "fmt check failed: run (cd contracts-soroban && cargo fmt --all)"
    log "cargo clippy …"
    (cd "$CONTRACT_DIR" && cargo clippy --all-targets -- -D warnings) || fail "clippy found errors"
    log "checks passed ✓"
}

cmd_size() {
    [[ -f "$WASM_PATH" ]] || fail "WASM not built yet. Run: $0 build"
    local size kib
    size=$(stat -f%z "$WASM_PATH" 2>/dev/null || stat --printf="%s" "$WASM_PATH" 2>/dev/null || wc -c < "$WASM_PATH" | tr -d ' ')
    kib=$(( size / 1024 ))
    log "WASM size: ${size} bytes (~${kib} KiB)"
    if   (( size > 524288 )); then fail "EXCEEDS Soroban 512KB hard deploy limit"
    elif (( size > 409600 )); then warn "approaching Soroban size limit (>400KB)"
    fi
}

cmd_deploy() {
    [[ -f "$WASM_PATH" ]] || fail "WASM not built yet. Run: $0 build"
    need_cmd soroban
    local network="${NETWORK:-testnet}"
    log "== Deployment steps for network '$network' =="
    echo
    echo "  1. Deploy the optimized WASM:"
    echo "     soroban contract deploy \\"
    echo "       --wasm $WASM_PATH \\"
    echo "       --source <ADMIN_SECRET_KEY> \\"
    echo "       --network $network"
    echo
    echo "  2. Initialize (name/symbol params accepted for EVM-ABI parity, URI is stored on-chain):"
    echo "     soroban contract invoke \\"
    echo "       --id <CONTRACT_ID_FROM_STEP1> \\"
    echo "       --source <OWNER_SECRET_KEY> \\"
    echo "       --network $network \\"
    echo "       -- initialize \\"
    echo "         --name 'GuildPass Membership' \\"
    echo "         --symbol 'GPM' \\"
    echo "         --base_token_uri 'https://guildpass.example.com/metadata/'"
    echo
    echo "  3. Grant admin to an operational wallet:"
    echo "     soroban contract invoke \\"
    echo "       --id <CONTRACT_ID> \\"
    echo "       --source <OWNER_SECRET_KEY> \\"
    echo "       --network $network \\"
    echo "       -- set_admin --who <ADMIN_ADDRESS> --enabled true"
}

cmd_help() {
    cat <<EOF
Usage: $0 <command>

Commands:
  build     Compile WASM (release + size-optimized for on-chain)
  test      Run unit/integration tests in the Soroban host simulator
  check     fmt + clippy (CI gating; exits non-zero on failures)
  size      Report compiled WASM size vs. Soroban deploy limits
  deploy    Print step-by-step deploy/init commands (requires \`soroban\` CLI)
  help      This message

Environment:
  NETWORK   Stellar network for deploy (default: testnet). Options:
            testnet | futurenet | mainnet | pubnet | custom

Examples:
  $0 check && $0 test && $0 build && $0 size
  NETWORK=mainnet $0 deploy
EOF
}

main() {
    local cmd="${1:-help}"
    case "$cmd" in
        build)      cmd_build ;;
        test)       cmd_test ;;
        check)      cmd_check ;;
        size)       cmd_size ;;
        deploy)     cmd_deploy ;;
        help|-h|--help) cmd_help ;;
        *)          fail "unknown command '$cmd'. Try: $0 help" ;;
    esac
}

main "$@"
