// Runs the site's real scripts (assets/js/*.js) like a browser page would: one shared global
// scope across the <script> tags, a stub DOM, alert/confirm/prompt, and an injected wallet
// (window.ethereum) wired to Hardhat's in-process chain. Arc's chain id and RPC are swapped for
// the local chain's, and SDOGE_CONTRACTS for the addresses under test.
//
// Reads normally go through an unbatched provider on the local chain. With { rpc: "limited" } the
// page's own ArcRpcProvider is used instead, pointed at a local relay that behaves like Arc's
// public RPC under load: about 20 calls per second per client, over-limit items inside a batch
// answered with -32005 in an HTTP 200, and a lone over-limit request answered with HTTP 429.
const fs = require("fs");
const http = require("http");
const path = require("path");
const vm = require("vm");
const ethersLib = require("ethers");

const SITE_JS = path.join(__dirname, "..", "..", "..", "assets", "js");

class El {
  constructor(id) {
    this.id = id;
    this.textContent = "";
    this.innerHTML = "";
    this.value = "";
    this.checked = false;
    this.disabled = false;
    this.src = "";
    this.style = {};
    this.dataset = {};
    this.classList = { add() {}, remove() {}, toggle: () => false, contains: () => false };
    this.listeners = {};
  }
  addEventListener(type, fn) {
    (this.listeners[type] ||= []).push(fn);
  }
  querySelectorAll() {
    return [];
  }
  querySelector() {
    return null;
  }
  setAttribute() {}
  scrollIntoView() {}
}

// An EIP-1193 wallet: the given account, everything else forwarded to the local chain.
function makeWallet(hreProvider, state) {
  const listeners = {};
  return {
    async request({ method, params }) {
      if (method === "eth_requestAccounts" || method === "eth_accounts") return [state.account];
      if (method === "wallet_switchEthereumChain" || method === "wallet_addEthereumChain") {
        state.switchRequests.push(method);
        return null;
      }
      if (method === "eth_sendTransaction") state.sent.push(params[0]);
      return hreProvider.request({ method, params: params ?? [] });
    },
    on(type, fn) {
      (listeners[type] ||= []).push(fn);
    },
    emit(type, arg) {
      (listeners[type] || []).forEach((fn) => fn(arg));
    },
    removeListener() {},
  };
}

// A JSON-RPC relay to the local chain with Arc's public-RPC rate limit.
async function startLimitedRpc(hreProvider, { perSecond = 20 } = {}) {
  const recent = []; // { t, cost } of calls in the last second
  const stats = { requests: 0, batchSizes: [], limitedInBatch: 0, http429: 0 };
  const cost = (method) => (method === "eth_chainId" ? 0 : method === "eth_getCode" || method === "eth_getBalance" ? 2 / 3 : 1);
  const take = (method) => {
    const now = Date.now();
    while (recent.length && now - recent[0].t >= 1000) recent.shift();
    const used = recent.reduce((sum, w) => sum + w.cost, 0);
    if (used + cost(method) > perSecond) return false;
    recent.push({ t: now, cost: cost(method) });
    return true;
  };
  const limited = (id) => ({ jsonrpc: "2.0", id, error: { code: -32005, message: "rate limit exceeded" } });
  const answer = async ({ id, method, params }) => {
    try {
      return { jsonrpc: "2.0", id, result: await hreProvider.request({ method, params: params ?? [] }) };
    } catch (e) {
      return { jsonrpc: "2.0", id, error: { code: e.code ?? -32000, message: e.message, data: e.data } };
    }
  };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", async () => {
      const payload = JSON.parse(body);
      stats.requests += 1;
      const reply = (status, json) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(json));
      };
      if (Array.isArray(payload)) {
        stats.batchSizes.push(payload.length);
        const out = [];
        for (const item of payload) {
          if (take(item.method)) out.push(await answer(item));
          else {
            stats.limitedInBatch += 1;
            out.push(limited(item.id));
          }
        }
        return reply(200, out);
      }
      stats.batchSizes.push(1);
      if (!take(payload.method)) {
        stats.http429 += 1;
        return reply(429, limited(payload.id));
      }
      return reply(200, await answer(payload));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    stats,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/**
 * files:      e.g. ['arc.js', 'wallet.js', 'nft.js', 'marketplace.js'], loaded in order
 * contracts:  SDOGE_CONTRACTS overrides, e.g. { collectibles: '0x...' }
 * account:    the address the injected wallet exposes
 * search:     location.search (for studio.html?drop=0x...)
 * rpc:        "limited" to read through the page's own provider and a rate-limited relay
 * globals:    extra browser globals for the page (e.g. fetch, localStorage)
 */
async function loadPage({ files, contracts = {}, hreProvider, account, search = "", rpc = "direct", globals = {} }) {
  const elements = {};
  const alerts = [];
  const confirms = [];
  const errors = [];
  const domListeners = {};
  const state = { account, sent: [], switchRequests: [] };
  const answers = { confirm: [], prompt: [] }; // queued answers; default confirm = true
  let reloads = 0;

  const document = {
    getElementById: (id) => (elements[id] ||= new El(id)),
    querySelectorAll: () => [],
    querySelector: () => null,
    addEventListener: (type, fn) => (domListeners[type] ||= []).push(fn),
    dispatchEvent: (ev) => (domListeners[ev.type] || []).forEach((fn) => fn(ev)),
  };
  const wallet = makeWallet(hreProvider, state);
  const { chainId } = await new ethersLib.BrowserProvider(hreProvider).getNetwork();
  const relay = rpc === "limited" ? await startLimitedRpc(hreProvider) : null;

  const sandbox = {
    document,
    ethers: ethersLib,
    alert: (m) => alerts.push(String(m)),
    confirm: (m) => {
      confirms.push(String(m));
      return answers.confirm.length ? answers.confirm.shift() : true;
    },
    prompt: () => (answers.prompt.length ? answers.prompt.shift() : null),
    console: {
      log() {},
      warn() {},
      error: (...a) => errors.push(a.map((x) => (x && (x.shortMessage || x.message)) || String(x)).join(" ")),
    },
    location: {
      search,
      origin: "https://sdoge.test",
      pathname: "/studio.html",
      reload: () => {
        reloads += 1;
      },
    },
    navigator: { clipboard: { writeText: async () => {} } },
    CustomEvent: class {
      constructor(type, init) {
        this.type = type;
        this.detail = init?.detail;
      }
    },
    URLSearchParams,
    TextEncoder,
    btoa,
    atob,
    setTimeout,
    clearTimeout,
    // The page's read provider, pointed at the local chain.
    __testReadProvider: new ethersLib.BrowserProvider(hreProvider),
  };
  Object.assign(sandbox, globals);
  sandbox.window = sandbox;
  sandbox.ethereum = wallet;
  const ctx = vm.createContext(sandbox);

  for (const f of files) {
    let src = fs.readFileSync(path.join(SITE_JS, f), "utf8");
    if (f === "arc.js") {
      const swap = (from, to) => {
        const next = src.replace(from, to);
        if (next === src) throw new Error(`fe-harness: couldn't find ${from} in arc.js; update the harness`);
        src = next;
      };
      swap("const ARC_CHAIN_ID = 5042n;", `const ARC_CHAIN_ID = ${chainId}n;`);
      if (relay) swap("const ARC_RPC_URL = 'https://rpc.mainnet.arc.io';", `const ARC_RPC_URL = '${relay.url}';`);
      else swap(/const arcReadProvider = new ArcRpcProvider\([^;]*\);/, "const arcReadProvider = __testReadProvider;");
      // Every contract starts unset (preview mode), whatever arc.js has deployed; a test sets
      // the ones it deploys.
      const all = { staking: "", collectibles: "", studio: "", marketplace: "", ...contracts };
      for (const [key, value] of Object.entries(all)) {
        const re = new RegExp(`^(\\s*${key}: )'[^']*',$`, "m");
        if (!re.test(src)) throw new Error(`no ${key} in SDOGE_CONTRACTS`);
        src = src.replace(re, `$1'${value}',`);
      }
    }
    vm.runInContext(src, ctx, { filename: f });
  }

  const page = {
    ctx,
    alerts,
    confirms,
    errors,
    answers,
    sent: state.sent,
    el: (id) => document.getElementById(id),
    run: (code) => vm.runInContext(code, ctx),
    setAccount: (a) => (state.account = a),
    wallet,
    reloads: () => reloads,
    rpcStats: relay?.stats,
    close: async () => {
      if (relay) await relay.close();
    },
    async ready() {
      for (const fn of domListeners.DOMContentLoaded || []) await fn();
    },
  };
  return page;
}

module.exports = { loadPage, startLimitedRpc };
