import {
  Contract, FetchRequest, Interface, JsonRpcProvider, Network, ZeroAddress, getAddress,
  keccak256, solidityPacked, toBeHex, zeroPadValue,
} from 'ethers';
import { ERC20_ABI, FACTORY_ABI, HOOK_ABI, ROUTER_ABI, VAULT_ABI } from './abi.js';

const erc20Iface = new Interface(ERC20_ABI);
const factoryIface = new Interface(FACTORY_ABI);
const TRANSFER_TOPIC = erc20Iface.getEvent('Transfer').topicHash;
export const LAUNCHED_TOPIC = factoryIface.getEvent('Launched').topicHash;

export function makeProvider(cfg) {
  const network = new Network('arc', cfg.chainId);
  const req = new FetchRequest(cfg.rpcUrl);
  req.timeout = 20000;
  return new JsonRpcProvider(req, network, { staticNetwork: network, batchMaxCount: 1 });
}

// Sum of ERC-20 Transfers of `token` to `to` inside one receipt. Used instead
// of balance deltas, which would also pick up gas and unrelated transfers.
function received(receipt, token, to) {
  const t = token.toLowerCase();
  const toTopic = '0x' + to.toLowerCase().slice(2).padStart(64, '0');
  let sum = 0n;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== t || log.topics[0] !== TRANSFER_TOPIC || log.topics[2] !== toTopic) continue;
    sum += BigInt(log.data);
  }
  return sum;
}

// Everything the bot does on-chain goes through here, so tests can swap in a fake.
export class Chain {
  constructor(cfg, provider) {
    this.cfg = cfg;
    this.provider = provider;
    this.usdc = new Contract(cfg.usdc, ERC20_ABI, provider);
    this.poolManager = new Contract(cfg.poolManager, ['function extsload(bytes32) view returns (bytes32)'], provider);
    this.factory = cfg.factory ? new Contract(cfg.factory, FACTORY_ABI, provider) : null;
    this.hook = cfg.hook ? new Contract(cfg.hook, HOOK_ABI, provider) : null;
    this.router = cfg.router ? new Contract(cfg.router, ROUTER_ABI, provider) : null;
  }

  get canLaunch() { return Boolean(this.factory); }
  get canTrade() { return Boolean(this.router); }
  get canClaim() { return Boolean(this.hook); }

  // PoolManager slot0 via extsload (StateLibrary layout: pools mapping at slot
  // 6). Verified against a live SDOGE-pool Swap event's sqrtPriceX96.
  async poolSqrtPrice(poolId) {
    const slot = keccak256(solidityPacked(['bytes32', 'bytes32'], [poolId, zeroPadValue(toBeHex(6), 32)]));
    const word = BigInt(await this.poolManager.extsload(slot));
    return word & ((1n << 160n) - 1n);
  }

  blockNumber() { return this.provider.getBlockNumber(); }
  nativeBalance(addr) { return this.provider.getBalance(addr); }
  tokenBalance(token, addr) { return new Contract(token, ERC20_ABI, this.provider).balanceOf(addr); }
  async isContract(addr) { return (await this.provider.getCode(addr)) !== '0x'; }
  getLogs(filter) { return this.provider.getLogs(filter); }

  async #ensureAllowance(signer, token, spender, amount) {
    const erc20 = new Contract(token, ERC20_ABI, signer);
    if ((await erc20.allowance(signer.address, spender)) >= amount) return;
    // Exact amount, not unlimited: a bug or compromise in the spender can
    // never reach more than the trade the user just confirmed.
    const tx = await erc20.approve(spender, amount);
    await this.#mined(tx);
  }

  async #mined(tx) {
    const receipt = await tx.wait(1, 120000);
    if (!receipt || receipt.status !== 1) throw new Error(`transaction reverted: ${tx.hash}`);
    return receipt;
  }

  launchFee() { return this.factory.launchFee(); }

  async estimateLaunch(signer, { name, symbol, uri }) {
    const fee = await this.factory.launchFee();
    const gas = await this.factory.connect(signer).launch.estimateGas(name, symbol, uri, { value: fee });
    const { maxFeePerGas, gasPrice } = await this.provider.getFeeData();
    return { fee, gasCost: gas * (maxFeePerGas ?? gasPrice ?? 0n) };
  }

  async launch(signer, { name, symbol, uri }) {
    const fee = await this.factory.launchFee();
    const tx = await this.factory.connect(signer).launch(name, symbol, uri, { value: fee });
    const receipt = await this.#mined(tx);
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== this.cfg.factory.toLowerCase()) continue;
      const parsed = factoryIface.parseLog(log);
      if (parsed?.name !== 'Launched') continue;
      return {
        txHash: tx.hash,
        index: Number(parsed.args.index),
        poolId: parsed.args.poolId,
        token: getAddress(parsed.args.token),
        vault: getAddress(parsed.args.vault),
        creator: getAddress(parsed.args.creator),
      };
    }
    throw new Error(`launch mined without a Launched event: ${tx.hash}`);
  }

  quoteBuy(token, usdcIn) { return this.router.quoteBuy.staticCall(token, usdcIn); }
  quoteSell(token, tokensIn) { return this.router.quoteSell.staticCall(token, tokensIn); }

  async buy(signer, token, usdcIn, minOut, deadline) {
    await this.#ensureAllowance(signer, this.cfg.usdc, this.cfg.router, usdcIn);
    const tx = await this.router.connect(signer).buy(token, usdcIn, minOut, signer.address, deadline);
    const receipt = await this.#mined(tx);
    return { txHash: tx.hash, received: received(receipt, token, signer.address) };
  }

  async sell(signer, token, tokensIn, minUsdcOut, deadline) {
    await this.#ensureAllowance(signer, token, this.cfg.router, tokensIn);
    const tx = await this.router.connect(signer).sell(token, tokensIn, minUsdcOut, signer.address, deadline);
    const receipt = await this.#mined(tx);
    return { txHash: tx.hash, received6: received(receipt, this.cfg.usdc, signer.address) };
  }

  owed(addr) { return this.hook.owed(addr); }

  async claim(signer) {
    const tx = await this.hook.connect(signer).claim(signer.address);
    const receipt = await this.#mined(tx);
    return { txHash: tx.hash, received6: received(receipt, this.cfg.usdc, signer.address) };
  }

  async vaultState(vault) {
    const v = new Contract(vault, VAULT_ABI, this.provider);
    const [usdc6, owed6, circulating] = await Promise.all([
      this.usdc.balanceOf(vault),
      this.hook ? this.hook.owed(vault) : 0n,
      v.circulating(),
    ]);
    return { usdc6, owed6, circulating };
  }

  async redeem(signer, { token, vault }, amount) {
    // Push the vault's accrued fee share in first so the redeemer is paid
    // against the full backing, not just what someone happened to claim.
    if (this.hook && (await this.hook.owed(vault)) > 0n) {
      await this.#mined(await this.hook.connect(signer).claim(vault));
    }
    await this.#ensureAllowance(signer, token, vault, amount);
    const tx = await new Contract(vault, VAULT_ABI, signer).redeem(amount);
    const receipt = await this.#mined(tx);
    return { txHash: tx.hash, received6: received(receipt, this.cfg.usdc, signer.address) };
  }

  async maxWithdrawable(signer, to) {
    const [balance, gas, { maxFeePerGas, gasPrice }] = await Promise.all([
      this.provider.getBalance(signer.address),
      this.provider.estimateGas({ from: signer.address, to, value: 1n }),
      this.provider.getFeeData(),
    ]);
    const cost = ((gas * 12n) / 10n) * (maxFeePerGas ?? gasPrice ?? 0n);
    return balance > cost ? balance - cost : 0n;
  }

  async withdraw(signer, to, value) {
    if (to === ZeroAddress) throw new Error('refusing to send to the zero address');
    const tx = await signer.sendTransaction({ to, value });
    await this.#mined(tx);
    return { txHash: tx.hash };
  }
}
