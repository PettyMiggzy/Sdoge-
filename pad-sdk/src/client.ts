import {
  createPublicClient, createWalletClient, http, maxUint256, parseEventLogs,
  type Account, type Address, type Chain, type Hash, type Hex, type HttpTransport, type PublicClient, type TransactionReceipt, type Transport, type WalletClient,
} from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { erc20Abi, hookAbi, lockerAbi, permit2Abi, portalAbi, splitterAbi, universalRouterAbi } from './abis.js';
import { ARC_MAINNET, DEFAULT_GAS_RESERVE_USDC, arc, type PadConfig } from './config.js';
import { getLaunches, parseLaunchLog, watchLaunches, type Launch } from './launches.js';
import { poolIdOf, poolKeyFor, priceFromSqrt, readSlot0, type PoolKey } from './pool.js';
import { buildExactInSwap, quoteExactIn, withSlippage } from './swap.js';

const MAX_UINT160 = (1n << 160n) - 1n;
const PERMIT2_EXPIRY_SEC = 60 * 60 * 24 * 30;

export type PadClientOptions = {
  publicClient: PublicClient<Transport, Chain | undefined>;
  /** Needed only for transactions (buy, sell, launch, claim, flush). */
  walletClient?: WalletClient<Transport, Chain | undefined, Account | undefined>;
  /** Override any part of the deployment config (defaults to SDOGE Pad on Arc mainnet). */
  config?: Partial<PadConfig>;
  /** USDC (6 decimals) a buy always leaves behind for gas. Default $0.10. */
  gasReserveUsdc?: bigint;
};

export type TradeResult = { hash: Hash; receipt: TransactionReceipt; quotedOut: bigint; amountOutMin: bigint };

export type TokenState = {
  token: Address;
  poolKey: PoolKey;
  poolId: Hex;
  tokenIsToken0: boolean;
  splitter: Address;
  locker: Address;
  buyTaxBps: number;
  sellTaxBps: number;
  sqrtPriceX96: bigint;
  tick: number;
  /** USD per token (USDC = $1). */
  priceUsd: number;
  marketCapUsd: number;
};

export type ArcClients = {
  account: PrivateKeyAccount;
  publicClient: PublicClient<HttpTransport, typeof arc>;
  walletClient: WalletClient<HttpTransport, typeof arc, PrivateKeyAccount>;
};

/** Handy for bots: public + wallet clients for Arc from a private key. */
export function createArcClients(privateKey: Hex, rpcUrl = ARC_MAINNET.rpcUrl): ArcClients {
  const account = privateKeyToAccount(privateKey);
  return {
    account,
    publicClient: createPublicClient({ chain: arc, transport: http(rpcUrl) }),
    walletClient: createWalletClient({ account, chain: arc, transport: http(rpcUrl) }),
  };
}

export function createPadClient(opts: PadClientOptions) {
  const config: PadConfig = { ...ARC_MAINNET, ...opts.config };
  const pc = opts.publicClient;
  const wc = opts.walletClient;
  const gasReserve = opts.gasReserveUsdc ?? DEFAULT_GAS_RESERVE_USDC;

  function signer(): Account {
    if (!wc?.account) throw new Error('This needs a walletClient with an account (see createArcClients)');
    return wc.account;
  }

  async function send(request: Parameters<WalletClient['writeContract']>[0]): Promise<{ hash: Hash; receipt: TransactionReceipt }> {
    const hash = await wc!.writeContract({ ...request, account: signer(), chain: wc!.chain ?? arc } as Parameters<WalletClient['writeContract']>[0]);
    const receipt = await pc.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error(`Transaction ${hash} reverted`);
    return { hash, receipt };
  }

  /** Pool key, taxes, splitter and live price of a launch. Throws for tokens that aren't pad launches. */
  async function getToken(token: Address): Promise<TokenState> {
    const { key, tokenIsToken0 } = poolKeyFor(config, token);
    const poolId = poolIdOf(key);
    const [cfg, slot0] = await Promise.all([
      pc.readContract({ address: config.hook, abi: hookAbi, functionName: 'poolConfigs', args: [poolId] }),
      readSlot0(pc, config, poolId),
    ]);
    const [splitter, , , buyTaxBps, sellTaxBps, active, locker] = cfg;
    if (!active) throw new Error(`${token} is not a SDOGE Pad launch`);
    const priceUsd = priceFromSqrt(slot0.sqrtPriceX96, tokenIsToken0, config.quoteDecimals, config.tokenDecimals);
    return {
      token, poolKey: key, poolId, tokenIsToken0, splitter, locker, buyTaxBps, sellTaxBps,
      sqrtPriceX96: slot0.sqrtPriceX96, tick: slot0.tick, priceUsd,
      marketCapUsd: priceUsd * Number(config.totalSupply / 10n ** BigInt(config.tokenDecimals)),
    };
  }

  function leg(token: Address, side: 'buy' | 'sell', amountIn: bigint) {
    const { key, tokenIsToken0 } = poolKeyFor(config, token);
    return side === 'buy'
      ? { key, amountIn, zeroForOne: !tokenIsToken0, currencyIn: config.usdc, currencyOut: token }
      : { key, amountIn, zeroForOne: tokenIsToken0, currencyIn: token, currencyOut: config.usdc };
  }

  /** Tokens out for `usdcIn` (6-decimal units), after tax, fee and price impact. */
  const quoteBuy = (token: Address, usdcIn: bigint) => quoteExactIn(pc, config.universalRouter, leg(token, 'buy', usdcIn));
  /** USDC out (6-decimal units) for `tokensIn` (18-decimal units), after tax, fee and price impact. */
  const quoteSell = (token: Address, tokensIn: bigint) => quoteExactIn(pc, config.universalRouter, leg(token, 'sell', tokensIn));

  /** ERC-20 approval to Permit2, then Permit2 approval to the router; each only when missing. */
  async function ensureAllowance(currency: Address, amount: bigint): Promise<void> {
    const owner = signer().address;
    const erc20Allow = await pc.readContract({ address: currency, abi: erc20Abi, functionName: 'allowance', args: [owner, config.permit2] });
    if (erc20Allow < amount) await send({ address: currency, abi: erc20Abi, functionName: 'approve', args: [config.permit2, maxUint256] } as never);
    const [allowed, expiration] = await pc.readContract({ address: config.permit2, abi: permit2Abi, functionName: 'allowance', args: [owner, currency, config.universalRouter] });
    const now = Math.floor(Date.now() / 1000);
    if (allowed < amount || expiration <= now + 60) {
      await send({ address: config.permit2, abi: permit2Abi, functionName: 'approve', args: [currency, config.universalRouter, MAX_UINT160, now + PERMIT2_EXPIRY_SEC] } as never);
    }
  }

  async function swap(token: Address, side: 'buy' | 'sell', amountIn: bigint, o: { slippageBps?: number; amountOutMin?: bigint; deadlineSec?: number }): Promise<TradeResult> {
    if (amountIn <= 0n) throw new Error('amountIn must be positive');
    const owner = signer().address;
    const l = leg(token, side, amountIn);
    const balance = await pc.readContract({ address: l.currencyIn, abi: erc20Abi, functionName: 'balanceOf', args: [owner] });
    const needed = side === 'buy' ? amountIn + gasReserve : amountIn;
    if (balance < needed) throw new Error(`Balance too low: have ${balance}, need ${needed}${side === 'buy' ? ' (including the USDC gas reserve)' : ''}`);
    const quotedOut = await quoteExactIn(pc, config.universalRouter, l);
    if (quotedOut === 0n) throw new Error('Nothing to fill against yet (the first trade on a launch has to be a buy)');
    const amountOutMin = o.amountOutMin ?? withSlippage(quotedOut, o.slippageBps ?? 300);
    await ensureAllowance(l.currencyIn, amountIn);
    const { args } = buildExactInSwap({ ...l, amountOutMin, deadlineSec: o.deadlineSec });
    const { hash, receipt } = await send({ address: config.universalRouter, abi: universalRouterAbi, functionName: 'execute', args } as never);
    return { hash, receipt, quotedOut, amountOutMin };
  }

  return {
    config,

    /** Every launch so far (or in a block range), oldest first. */
    getLaunches: (range?: { fromBlock?: bigint; toBlock?: bigint }) => getLaunches(pc, config, range),
    /** Calls back on each new launch as soon as it's mined. Returns a stop function. */
    watchLaunches: (onLaunch: (l: Launch) => void | Promise<void>, o?: { pollIntervalMs?: number; fromBlock?: bigint; onError?: (e: unknown) => void }) =>
      watchLaunches(pc, config, onLaunch, o),

    getToken,
    quoteBuy,
    quoteSell,

    /** Is the pad switched on (launches can open pools)? */
    isLive: () => pc.readContract({ address: config.hook, abi: hookAbi, functionName: 'isAuthorizedPortal', args: [config.portal] }),

    /** Buy with `usdcIn` USDC (6 decimals). Default slippage 3%. */
    buy: (p: { token: Address; usdcIn: bigint; slippageBps?: number; amountOutMin?: bigint; deadlineSec?: number }) => swap(p.token, 'buy', p.usdcIn, p),
    /** Sell `amountIn` tokens (18 decimals). Default slippage 3%. */
    sell: (p: { token: Address; amountIn: bigint; slippageBps?: number; amountOutMin?: bigint; deadlineSec?: number }) => swap(p.token, 'sell', p.amountIn, p),

    /**
     * Launch a token. Opening market cap in whole USD (min $100); taxes in
     * basis points, 0-1000 (0-10%) per side, fixed forever.
     */
    async launch(p: { name: string; symbol: string; startingMarketCapUsd?: number; buyTaxBps?: number; sellTaxBps?: number }) {
      const mc = BigInt(Math.round((p.startingMarketCapUsd ?? 1000) * 10 ** config.quoteDecimals));
      const { hash, receipt } = await send({
        address: config.portal, abi: portalAbi, functionName: 'createLaunch',
        args: [{ name: p.name, symbol: p.symbol, startingMarketCapQuote: mc, buyTaxBps: p.buyTaxBps ?? 0, sellTaxBps: p.sellTaxBps ?? 0 }],
      } as never);
      const ev = parseEventLogs({ abi: portalAbi, eventName: 'LaunchCreated', logs: receipt.logs })[0];
      if (!ev) throw new Error('Launch transaction had no LaunchCreated event');
      return { hash, receipt, launch: parseLaunchLog({ ...ev, args: ev.args } as never) };
    },

    /** USDC tax the hook holds for a launch until someone flushes it. */
    pendingTax: async (token: Address) =>
      pc.readContract({ address: config.hook, abi: hookAbi, functionName: 'pendingTax', args: [poolIdOf(poolKeyFor(config, token).key)] }),
    /** Moves a launch's held tax into its splitter (anyone can call). */
    flush: (token: Address) => send({ address: config.hook, abi: hookAbi, functionName: 'flush', args: [poolKeyFor(config, token).key] } as never),
    /** Collects the launch's LP fees into its splitter (anyone can call). */
    harvestFees: async (token: Address) => send({ address: (await getToken(token)).locker, abi: lockerAbi, functionName: 'harvestFees' } as never),

    /** USDC a launch's creator can claim now. */
    creatorBalance: async (token: Address) =>
      pc.readContract({ address: (await getToken(token)).splitter, abi: splitterAbi, functionName: 'creditedToCreator', args: [config.usdc] }),
    /** Creator only: send the creator's USDC to `to` (default: the signer). */
    claim: async (token: Address, to?: Address) =>
      send({ address: (await getToken(token)).splitter, abi: splitterAbi, functionName: 'claim', args: [to ?? signer().address, config.usdc] } as never),
  };
}

export type PadClient = ReturnType<typeof createPadClient>;
