#!/usr/bin/env bash
# Verifies a SDOGE Pad deployment's source on Arc's Blockscout explorer
# (testnet or mainnet). Needs no private key: verification only registers
# source against addresses that already have bytecode.
#
# Verified source is also what token scanners (GoPlus etc.) read as "open
# source"; an unverified contract is itself a red flag. Every launch token
# has identical runtime bytecode (plain ERC-20, no immutables), so once
# one is verified here Blockscout can match the rest.
#
# Usage (addresses from DeploySdogePad.s.sol's output):
#   NETWORK=mainnet TREASURY=0x.. HOOK=0x.. PORTAL=0x.. DEPLOYER=0x.. \
#   TREASURY_OWNER=0x.. PAD_ADMIN=0x.. FACTORY=0x.. FACTORY_OWNER=0x.. \
#   PAD_SETUP_FEE=100000000 LAUNCH_TOKEN=0x.. bash script/verify.sh
# TREASURY_OWNER and PAD_ADMIN default to DEPLOYER, as in the deploy script
# (PAD_ADMIN falls back to TREASURY_OWNER). FACTORY, FACTORY_OWNER and
# LAUNCH_TOKEN are optional. If the explorer's indexer lags the chain tip
# ("Address is not a smart-contract"), just re-run later.
#
# VERIFIER=sourcify sends it all to Sourcify instead, which supports 5042 and
# 5042002. Use it where explorer.arc.io's API is behind its Cloudflare bot
# check.
set -euo pipefail
cd "$(dirname "$0")/.."

case "${NETWORK:-}" in
  mainnet) CHAIN_ID=5042; VERIFIER_URL="https://explorer.arc.io/api/"; RPC="${RPC_URL:-https://rpc.mainnet.arc.io}" ;;
  testnet) CHAIN_ID=5042002; VERIFIER_URL="https://explorer.testnet.arc.io/api/"; RPC="${RPC_URL:-https://rpc.testnet.arc.network}" ;;
  *) echo "set NETWORK=mainnet or NETWORK=testnet" >&2; exit 1 ;;
esac
: "${TREASURY:?}" "${HOOK:?}" "${PORTAL:?}" "${DEPLOYER:?}"
TREASURY_OWNER="${TREASURY_OWNER:-$DEPLOYER}"
PAD_ADMIN="${PAD_ADMIN:-$TREASURY_OWNER}"
POOL_MANAGER=0x8366a39CC670B4001A1121B8F6A443A643e40951
USDC=0x3600000000000000000000000000000000000000

verify() { # address, contract, constructor-args
  echo "== $2 at $1 =="
  if [ "${VERIFIER:-blockscout}" = sourcify ]; then
    forge verify-contract "$1" "$2" --chain-id "$CHAIN_ID" --verifier sourcify --constructor-args "$3"
  else
    forge verify-contract "$1" "$2" --chain-id "$CHAIN_ID" --verifier blockscout --verifier-url "$VERIFIER_URL" --constructor-args "$3"
  fi
}

verify "$TREASURY" src/SdogePadTreasury.sol:SdogePadTreasury "$(cast abi-encode 'constructor(address)' "$TREASURY_OWNER")"
verify "$HOOK" src/SdogePadHook.sol:SdogePadHook "$(cast abi-encode 'constructor(address,address)' "$POOL_MANAGER" "$PAD_ADMIN")"
verify "$PORTAL" src/SdogePadPortal.sol:SdogePadPortal \
  "$(cast abi-encode 'constructor(address,address,address,address,bool)' "$POOL_MANAGER" "$HOOK" "$TREASURY" "$USDC" true)"
if [ -n "${FACTORY:-}" ]; then
  # The factory's owner as deployed (TREASURY_OWNER when the deploy script made it).
  verify "$FACTORY" src/SdogePadFactory.sol:SdogePadFactory \
    "$(cast abi-encode 'constructor(address,address,address,address,uint256,address)' "$POOL_MANAGER" "$HOOK" "$TREASURY" "$USDC" "${PAD_SETUP_FEE:-100000000}" "${FACTORY_OWNER:-$TREASURY_OWNER}")"
fi
if [ -n "${LAUNCH_TOKEN:-}" ]; then
  # Constructor args read back from the token itself: name, symbol, 1B supply, minted to the portal.
  NAME=$(cast call "$LAUNCH_TOKEN" 'name()(string)' --rpc-url "$RPC")
  SYMBOL=$(cast call "$LAUNCH_TOKEN" 'symbol()(string)' --rpc-url "$RPC")
  verify "$LAUNCH_TOKEN" src/SdogePadLaunchToken.sol:SdogePadLaunchToken \
    "$(cast abi-encode 'constructor(string,string,uint256,address)' "$NAME" "$SYMBOL" 1000000000000000000000000000 "$PORTAL")"
fi
