#!/usr/bin/env node
// Staking-rewards keeper.
//
// $SDOGE's 1% trade tax accumulates as native USDC at one known wallet (the
// same address the buy-bot excludes from buy alerts as "not a real buyer").
// Today a human manually swaps that SDOGE for USDC and moves it into the
// Treasury / buyback flow. This script does NOT touch that process — it has
// no visibility into it and shouldn't guess at it. All it does is watch the
// tax wallet's native balance and, whenever it goes UP (new tax revenue
// landed), skim the Staking contract's 20% cut off the increase and call
// notifyRewardAmount() with it, leaving the other 80% untouched for the
// existing Treasury/buyback process to handle as it already does.
//
// If the wallet's balance instead goes DOWN since we last looked (because
// that manual Treasury/buyback sweep just ran), we simply rebase our
// baseline to the new lower balance rather than erroring — we're not
// tracking or interfering with that flow, just riding on top of it.
//
// Required env vars (see treasury/README.md):
//   TAX_WALLET_PRIVATE_KEY - private key of TAX_WALLET_ADDRESS (below).
//                           Extremely sensitive - GitHub Secret only, never
//                           config.json, never logged. Not needed for
//                           DRY_RUN.
//
// Optional env vars:
//   ARC_RPC_URL           - default https://rpc.mainnet.arc.io
//   ARC_RPC_FALLBACK_URL  - last-resort paid RPC, only used if the primary
//                           fails. Same secret the buy-bot uses.
//   DRY_RUN               - "true" to log what would be sent without
//                           broadcasting or touching state.json
//
// Non-secret settings live in treasury/config.json:
//   TAX_WALLET_ADDRESS       - the 1% tax collector (public, already known)
//   STAKING_CONTRACT_ADDRESS - deployed SDOGEStaking address. Left blank
//                              until the contract is actually deployed with
//                              a real Treasury/multisig owner - this script
//                              is a no-op until that's filled in.
//   STAKING_BPS               - staking's share of new tax revenue, in basis
//                              points (2000 = 20%, matching the site).
//   MIN_STAKING_CUT_USDC      - skip sending until the accumulated cut is at
//                              least this much, so we're not paying gas to
//                              move dust or tripping the contract's own
//                              "reward rate would round to 0" guard.

import { readFile, writeFile } from 'node:fs/promises';
import { ethers } from 'ethers';

const STATE_PATH = new URL('./state.json', import.meta.url);
const CONFIG_PATH = new URL('./config.json', import.meta.url);

let fileConfig = {};
try {
  fileConfig = JSON.parse(await readFile(CONFIG_PATH, 'utf8'));
} catch {
  fileConfig = {};
}

function need(name) {
  const v = process.env[name];
  if (v && v.trim()) return v.trim();
  const fromFile = fileConfig[name];
  return fromFile && String(fromFile).trim() ? String(fromFile).trim() : null;
}

async function loadState() {
  try {
    return JSON.parse(await readFile(STATE_PATH, 'utf8'));
  } catch {
    return { lastKnownBalance: '0' };
  }
}

async function saveState(state) {
  await writeFile(STATE_PATH, JSON.stringify(state, null, 2) + '\n');
}

// Tries the primary RPC first, falls back to the paid one if configured.
// Never interpolate the URL itself into a thrown/logged message here -
// ARC_RPC_FALLBACK_URL can carry a paid provider's API key and this script's
// output is public in GitHub Actions logs.
async function getWorkingProvider() {
  const candidates = [
    { label: 'primary', url: need('ARC_RPC_URL') ?? 'https://rpc.mainnet.arc.io' },
    { label: 'paid-fallback', url: need('ARC_RPC_FALLBACK_URL') },
  ].filter((c) => c.url);

  let lastErr;
  for (const { label, url } of candidates) {
    const provider = new ethers.JsonRpcProvider(url, undefined, { staticNetwork: true });
    try {
      await provider.getBlockNumber();
      return provider;
    } catch (err) {
      lastErr = err;
      console.error(`RPC candidate '${label}' failed: ${err.message}`);
    }
  }
  throw lastErr ?? new Error('No RPC endpoint configured');
}

const STAKING_ABI = ['function notifyRewardAmount() external payable'];

async function main() {
  const taxWalletAddress = need('TAX_WALLET_ADDRESS');
  if (!taxWalletAddress) throw new Error('TAX_WALLET_ADDRESS is not set in treasury/config.json');

  const stakingAddress = need('STAKING_CONTRACT_ADDRESS');
  if (!stakingAddress) {
    console.log(
      'STAKING_CONTRACT_ADDRESS is not set yet - SDOGEStaking has not been deployed. ' +
        'Nothing to do. Set it in treasury/config.json once contracts/scripts/deploy.js has run.'
    );
    return;
  }

  const stakingBps = BigInt(need('STAKING_BPS') ?? '2000');
  const minStakingCutWei = ethers.parseUnits(need('MIN_STAKING_CUT_USDC') ?? '5', 18);
  const dryRun = need('DRY_RUN') === 'true';

  const provider = await getWorkingProvider();
  const state = await loadState();
  const lastKnownBalance = BigInt(state.lastKnownBalance ?? '0');
  const walletBalance = await provider.getBalance(taxWalletAddress);

  if (walletBalance <= lastKnownBalance) {
    console.log(
      `Tax wallet balance is at or below our last checkpoint (now ${ethers.formatUnits(walletBalance, 18)} USDC, ` +
        `was ${ethers.formatUnits(lastKnownBalance, 18)} USDC) - likely swept for Treasury/buyback since we last ` +
        'checked. Rebasing, nothing to send this run.'
    );
    await saveState({ lastKnownBalance: walletBalance.toString() });
    return;
  }

  const unswept = walletBalance - lastKnownBalance;
  const stakingCut = (unswept * stakingBps) / 10000n;

  if (stakingCut < minStakingCutWei) {
    console.log(
      `New tax revenue since last check: ${ethers.formatUnits(unswept, 18)} USDC. Staking's 20% cut ` +
        `(${ethers.formatUnits(stakingCut, 18)} USDC) is below the ${ethers.formatUnits(minStakingCutWei, 18)} USDC ` +
        'minimum - waiting for more to accumulate before sending. State left unchanged so it keeps accumulating.'
    );
    return;
  }

  console.log(
    `New tax revenue since last check: ${ethers.formatUnits(unswept, 18)} USDC. Staking's cut: ` +
      `${ethers.formatUnits(stakingCut, 18)} USDC.`
  );

  if (dryRun) {
    console.log(`DRY_RUN=true - would call notifyRewardAmount() on ${stakingAddress} with that amount. Not sending.`);
    return;
  }

  const privateKey = need('TAX_WALLET_PRIVATE_KEY');
  if (!privateKey) throw new Error('TAX_WALLET_PRIVATE_KEY is not set (required unless DRY_RUN=true)');

  const wallet = new ethers.Wallet(privateKey, provider);
  if (wallet.address.toLowerCase() !== taxWalletAddress.toLowerCase()) {
    throw new Error(
      `TAX_WALLET_PRIVATE_KEY does not match TAX_WALLET_ADDRESS (got ${wallet.address}, expected ${taxWalletAddress}) - ` +
        'refusing to send from the wrong wallet.'
    );
  }

  const staking = new ethers.Contract(stakingAddress, STAKING_ABI, wallet);
  const tx = await staking.notifyRewardAmount({ value: stakingCut });
  console.log(`Sent notifyRewardAmount(), tx: ${tx.hash}`);
  await tx.wait();
  console.log('Confirmed.');

  await saveState({ lastKnownBalance: (walletBalance - stakingCut).toString() });
}

main().catch((err) => {
  console.error('Staking funding run failed:', err);
  process.exit(1);
});
