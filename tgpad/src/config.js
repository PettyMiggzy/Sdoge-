import fs from 'node:fs';
import { isAddress, getAddress } from 'ethers';

const CONFIG_URL = new URL('../config.json', import.meta.url);

const pick = (env, name, fallback) => {
  const v = env[name];
  return v && v.trim() ? v.trim() : fallback;
};

function addr(label, value) {
  if (!value) return '';
  if (!isAddress(value)) throw new Error(`${label} is not a valid address: ${value}`);
  return getAddress(value);
}

export function loadConfig({ env = process.env, file } = {}) {
  const f = file ?? JSON.parse(fs.readFileSync(CONFIG_URL, 'utf8'));

  const cfg = {
    chainId: Number(f.chainId ?? 5042),
    rpcUrl: pick(env, 'ARC_RPC_URL', f.rpcUrl),
    explorerUrl: String(f.explorerUrl ?? '').replace(/\/$/, ''),
    usdc: addr('usdc', f.usdc),
    poolManager: addr('poolManager', f.poolManager),
    factory: addr('FACTORY_ADDRESS', pick(env, 'FACTORY_ADDRESS', f.factory)),
    hook: addr('HOOK_ADDRESS', pick(env, 'HOOK_ADDRESS', f.hook)),
    router: addr('ROUTER_ADDRESS', pick(env, 'ROUTER_ADDRESS', f.router)),
    launchesChannel: pick(env, 'LAUNCHES_CHANNEL_ID', f.launchesChannel || ''),
    allowedGroups: new Set((f.allowedGroups ?? []).map(String)),
    admins: new Set(pick(env, 'ADMIN_TELEGRAM_IDS', '').split(',').map((s) => s.trim()).filter(Boolean)),
    telegramToken: pick(env, 'TELEGRAM_BOT_TOKEN', ''),
    walletSecret: pick(env, 'WALLET_MASTER_SECRET', ''),
    veniceKey: pick(env, 'VENICE_API_KEY', ''),
    dataDir: pick(env, 'TGPAD_DATA_DIR', new URL('../data/', import.meta.url).pathname),
    pollIntervalMs: Number(f.pollIntervalMs ?? 4000),
    limits: { ...f.limits },
    moderation: { ...f.moderation },
    alerts: { ...f.alerts },
  };

  if (!/^[0-9a-fA-F]{64,}$/.test(cfg.walletSecret)) {
    throw new Error('WALLET_MASTER_SECRET must be at least 32 random bytes as hex (64+ hex chars). See .env.example.');
  }
  if (!cfg.telegramToken) throw new Error('TELEGRAM_BOT_TOKEN is not set. See .env.example.');
  for (const id of cfg.admins) {
    if (!/^\d+$/.test(id)) throw new Error(`ADMIN_TELEGRAM_IDS must be numeric Telegram user IDs, got "${id}"`);
  }
  return Object.freeze(cfg);
}
