// Studio AI on the Studio page: the page's real script (assets/js/studio-ai.js) against the real
// /api/ai handlers (api/ai/*.mjs), with payments checked on the in-process chain, an in-memory
// image store and a stand-in for the image service.
const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const { loadPage, startLimitedRpc } = require("./helpers/fe-harness");

const E = (n) => ethers.parseEther(String(n));
const hex = (n) => ethers.toQuantity(n);
const STUDIO_AI_PAGE = ["arc.js", "wallet.js", "studio.js", "studio-ai.js"];

describe("Studio AI (studio-ai.js + api/ai)", function () {
  let relay;
  let api;
  let config;

  before(async function () {
    relay = await startLimitedRpc(network.provider, { perSecond: 10_000 });
    Object.assign(process.env, {
      ARC_RPC_URL: relay.url,
      AI_CHAIN_ID: String((await ethers.provider.getNetwork()).chainId),
      AI_STORE: "memory",
      AI_FAKE_VENICE: "1",
      VENICE_API_KEY: "test-key",
    });
    config = await import("../../api/_lib/config.mjs");
    api = {
      quote: (await import("../../api/ai/quote.mjs")).default,
      credits: (await import("../../api/ai/credits.mjs")).default,
      generate: (await import("../../api/ai/generate.mjs")).default,
      history: (await import("../../api/ai/history.mjs")).default,
    };
  });
  after(async () => relay?.close());

  // What the page's fetch reaches: the handlers themselves, called the way Vercel calls them.
  function siteFetch(calls) {
    return async (url, init = {}) => {
      const m = /^\/api\/ai\/(\w+)$/.exec(url);
      const handler = m && api[m[1]];
      if (!handler) return { status: 404, ok: false, json: async () => ({}) };
      const req = { method: init.method || "GET", body: init.body ? JSON.parse(init.body) : undefined };
      calls.push({ path: m[1], body: req.body });
      const out = { status: 0, body: "" };
      const res = {
        set statusCode(v) {
          out.status = v;
        },
        setHeader() {},
        end(b) {
          out.body = b;
        },
      };
      await handler(req, res);
      return { status: out.status, ok: out.status >= 200 && out.status < 300, json: async () => JSON.parse(out.body) };
    };
  }

  function memoryStorage() {
    const m = new Map();
    return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
  }

  async function aiPage(who) {
    const calls = [];
    const p = await loadPage({
      files: STUDIO_AI_PAGE,
      hreProvider: network.provider,
      account: who.address,
      globals: { fetch: siteFetch(calls), localStorage: memoryStorage() },
    });
    await p.ready();
    p.run("confirmAdult()"); // the 18+ button
    await p.run("loadAiQuote()");
    expect(await p.run("connectWallet()")).to.equal(true);
    await p.run("refreshAiCredits()");
    return { p, calls };
  }

  it("stays closed until the visitor confirms they're 18 or older", async function () {
    const erin = (await ethers.getSigners())[5];
    const calls = [];
    const storage = memoryStorage();
    const open = async () => {
      const p = await loadPage({
        files: STUDIO_AI_PAGE,
        hreProvider: network.provider,
        account: erin.address,
        globals: { fetch: siteFetch(calls), localStorage: storage },
      });
      await p.ready();
      await p.run("loadAiQuote()");
      return p;
    };
    const p = await open();
    expect(p.el("aiAgeGate").hidden).to.equal(false);
    expect(p.el("aiTools").hidden).to.equal(true);
    expect(await p.run("connectWallet()")).to.equal(true);
    await p.run("buyAiPack(0)");
    p.el("aiPrompt").value = "a doge astronaut";
    await p.run("createAiImage()");
    expect(p.sent.length).to.equal(0);
    expect(calls.some((c) => c.path === "generate")).to.equal(false);

    p.run("confirmAdult()");
    expect(p.el("aiAgeGate").hidden).to.equal(true);
    expect(p.el("aiTools").hidden).to.equal(false);
    await p.run("buyAiPack(0)");
    expect(p.sent.length).to.equal(1);
    // remembered in this browser
    const again = await open();
    expect(again.el("aiAgeGate").hidden).to.equal(true);
  });

  it("buys credits with one plain USDC payment to the payee, marked as a Studio AI payment", async function () {
    const [, alice] = await ethers.getSigners();
    const { p } = await aiPage(alice);
    expect(p.run("aiQuote.available")).to.equal(true);
    const before = await ethers.provider.getBalance(config.PAYEE);
    await p.run("buyAiPack(1)"); // 10 credits for 2 USDC
    expect(p.confirms.at(-1)).to.include("Buy 10 AI credits for 2 USDC?");
    const tx = p.sent.at(-1);
    expect(tx.to.toLowerCase()).to.equal(config.PAYEE);
    expect(tx.value).to.equal(hex(E("2")));
    expect(tx.data).to.equal(config.MEMO);
    expect(tx.chainId).to.equal(hex(31337));
    expect((await ethers.provider.getBalance(config.PAYEE)) - before).to.equal(E("2"));
    expect(p.run("aiCreditsLeft")).to.equal(10);
    expect(p.el("aiCredits").textContent).to.equal("10 credits");
    expect(p.el("aiStatus").textContent).to.match(/Payment received/);
  });

  it("makes an image after one signature, and hands it to the 1-of-1 form", async function () {
    const [, , bob] = await ethers.getSigners();
    const { p, calls } = await aiPage(bob);
    await p.run("buyAiPack(0)"); // 1 credit
    p.el("aiPrompt").value = "a doge astronaut on the moon";
    await p.run("createAiImage()");
    const made = calls.find((c) => c.path === "generate");
    // the page signed exactly the message the server checks
    expect(ethers.verifyMessage(config.sessionMessage(bob.address, made.body.expires), made.body.signature)).to.equal(bob.address);
    const url = p.el("aiImage").src;
    expect(url).to.match(/\/ai\/images\/[0-9a-f]{64}\.webp$/);
    expect(p.run("aiCreditsLeft")).to.equal(0);
    p.run(`useAiImage(${JSON.stringify(url)})`);
    expect(p.el("cmImage").value).to.equal(url);

    // no credits left: it says so and asks for nothing
    const sent = p.sent.length;
    await p.run("createAiImage()");
    expect(p.alerts.at(-1)).to.match(/Buy a pack below/);
    expect(p.sent.length).to.equal(sent);
  });

  it("a refused prompt costs nothing", async function () {
    const [, , , carol] = await ethers.getSigners();
    const { p } = await aiPage(carol);
    await p.run("buyAiPack(0)");
    p.el("aiPrompt").value = "sexy teen girl";
    await p.run("createAiImage()");
    expect(p.alerts.at(-1)).to.match(/isn't allowed/);
    await p.run("refreshAiCredits()");
    expect(p.run("aiCreditsLeft")).to.equal(1);
  });

  it("counts a payment made on another device from its transaction hash", async function () {
    const [, , , , dave] = await ethers.getSigners();
    const tx = await dave.sendTransaction({ to: config.PAYEE, value: E("0.25"), data: config.MEMO });
    await tx.wait();
    const { p } = await aiPage(dave);
    p.el("aiTxInput").value = tx.hash;
    await p.run("addAiPayment()");
    expect(p.run("aiCreditsLeft")).to.equal(1);
    expect(p.el("aiStatus").textContent).to.match(/Added/);
  });
});
