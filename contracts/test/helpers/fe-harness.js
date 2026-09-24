// Runs the site's real scripts (assets/js/*.js) like a browser page would: one shared global
// scope across the <script> tags, a stub DOM, alert/confirm/prompt, and an injected wallet
// (window.ethereum) wired to Hardhat's in-process chain. Arc's chain id and RPC are swapped for
// the local chain's, and SDOGE_CONTRACTS for the addresses under test.
const fs = require("fs");
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

/**
 * files:      e.g. ['arc.js', 'wallet.js', 'nft.js', 'marketplace.js'], loaded in order
 * contracts:  SDOGE_CONTRACTS overrides, e.g. { collectibles: '0x...' }
 * account:    the address the injected wallet exposes
 * search:     location.search (for studio.html?drop=0x...)
 */
async function loadPage({ files, contracts = {}, hreProvider, account, search = "" }) {
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
  sandbox.window = sandbox;
  sandbox.ethereum = wallet;
  const ctx = vm.createContext(sandbox);

  for (const f of files) {
    let src = fs.readFileSync(path.join(SITE_JS, f), "utf8");
    if (f === "arc.js") {
      src = src
        .replace("const ARC_CHAIN_ID = 5042n;", `const ARC_CHAIN_ID = ${chainId}n;`)
        .replace(/const arcReadProvider = new ethers\.JsonRpcProvider\([^;]*\);/, "const arcReadProvider = __testReadProvider;");
      for (const [key, value] of Object.entries(contracts)) {
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
    async ready() {
      for (const fn of domListeners.DOMContentLoaded || []) await fn();
    },
  };
  return page;
}

module.exports = { loadPage };
