// Market bar: a stock-ticker strip of live SDOGE Pad launches.
//
// Data comes from the pad's public API (GET /api/v1/market) and, for $SDOGE
// itself, from DexScreener. Every number shown is live; until the pad has
// launches the strip fills out with plain pad facts instead of sample data.
// If both sources are down it still shows the facts, so it never looks broken.
(() => {
  // The pad site. Change this one line if the pad ever moves.
  const PAD_URL = 'https://pad.stabledoge.site';
  const SDOGE = '0xf8df98fda14cabb2e8b6efe920081ffcbb0bb405';
  const REFRESH_MS = 30_000;
  const MIN_ITEMS = 8; // below this the strip is padded with pad facts

  const bar = document.getElementById('marketBar');
  const track = document.getElementById('marketBarTrack');
  const label = document.getElementById('marketBarLabel');
  if (!bar || !track) return;

  document.querySelectorAll('[data-pad-link]').forEach((a) => { a.href = PAD_URL; });
  if (label) label.href = PAD_URL;

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // $0.0₅123 style for tiny prices, like exchange tickers.
  const SUB = '₀₁₂₃₄₅₆₇₈₉';
  function fmtPrice(p) {
    if (!Number.isFinite(p) || p <= 0) return '—';
    if (p >= 1) return '$' + p.toLocaleString('en-US', { maximumFractionDigits: 2 });
    if (p >= 0.0001) return '$' + p.toPrecision(3).replace(/0+$/, '');
    let zeros = Math.ceil(-Math.log10(p)) - 1; // zeros between the point and the first digit
    let digits = Math.round(p * 10 ** (zeros + 3));
    if (digits >= 1000) { zeros -= 1; digits = 100; } // 0.0000999… rounds up a place
    return '$0.0' + String(zeros).split('').map((d) => SUB[d]).join('') + String(digits).slice(0, 3);
  }
  function fmtUsd(v) {
    if (!Number.isFinite(v) || v <= 0) return null;
    if (v >= 1e9) return '$' + (v / 1e9).toFixed(2) + 'B';
    if (v >= 1e6) return '$' + (v / 1e6).toFixed(2) + 'M';
    if (v >= 1e3) return '$' + (v / 1e3).toFixed(1) + 'K';
    return '$' + v.toFixed(0);
  }
  function chg(pct) {
    if (!Number.isFinite(pct)) return '';
    const up = pct >= 0;
    const v = Math.abs(pct) >= 1000 ? Math.round(Math.abs(pct)).toLocaleString('en-US') : Math.abs(pct).toFixed(1);
    return `<span class="market-bar__chg market-bar__chg--${up ? 'up' : 'down'}">${up ? '▲' : '▼'} ${v}%</span>`;
  }
  function icon(t) {
    if (t.image) return `<img class="market-bar__icon" src="${esc(t.image)}" alt="" loading="lazy" />`;
    return `<span class="market-bar__icon market-bar__icon--letter">${esc((t.symbol || '?').slice(0, 1))}</span>`;
  }

  function tokenItem(t, href, extra = '') {
    return `<a class="market-bar__item" href="${esc(href)}">${icon(t)}<span class="market-bar__sym">$${esc(t.symbol)}</span>`
      + `<span class="market-bar__price">${fmtPrice(t.priceUsd)}</span>${extra}</a>`;
  }
  const info = (text, href) => href
    ? `<a class="market-bar__item market-bar__item--info" href="${esc(href)}">${esc(text)}</a>`
    : `<span class="market-bar__item market-bar__item--info">${esc(text)}</span>`;

  async function getJson(url, ms = 8000) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), ms);
    try {
      const r = await fetch(url, { signal: ctl.signal, headers: { accept: 'application/json' } });
      if (!r.ok) throw new Error(String(r.status));
      return await r.json();
    } finally { clearTimeout(timer); }
  }

  async function loadPad() {
    try { return await getJson(`${PAD_URL}/api/v1/market?limit=30`); } catch { return null; }
  }
  async function loadSdoge() {
    try {
      const d = await getJson(`https://api.dexscreener.com/latest/dex/tokens/${SDOGE}`);
      const pairs = (d.pairs || []).filter((p) => p.chainId === 'arc');
      pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
      const p = pairs[0];
      if (!p) return null;
      return { symbol: 'SDOGE', priceUsd: Number(p.priceUsd), change24h: Number(p.priceChange?.h24), image: 'assets/img/logo.jpg', url: p.url };
    } catch { return null; }
  }

  async function render() {
    const [pad, sdoge] = await Promise.all([loadPad(), loadSdoge()]);
    const live = pad?.live !== false && !!pad;
    bar.classList.toggle('market-bar--soon', !live);

    const items = [];
    if (sdoge) items.push(tokenItem(sdoge, sdoge.url || '#chart', chg(sdoge.change24h)));
    for (const t of pad?.tokens || []) {
      const isNew = t.createdAt && Date.now() / 1000 - t.createdAt < 86_400;
      const mc = fmtUsd(t.marketCapUsd);
      items.push(tokenItem(t, `${PAD_URL}/token/${t.address}`,
        chg(t.changeSinceLaunchPct) + (mc ? `<span class="market-bar__price">MC ${mc}</span>` : '') + (isNew ? '<span class="market-bar__new">NEW</span>' : '')));
    }
    const facts = [
      live ? info('SDOGE PAD IS LIVE: LAUNCH A TOKEN ON ARC', `${PAD_URL}/create`) : info('SDOGE PAD: OPENING SOON', PAD_URL),
      info('EVERY LAUNCH TRADES AGAINST USDC FROM THE FIRST BLOCK'),
      info('CREATORS KEEP 90% OF THEIR TOKEN\'S FEES'),
      info('BOTS AND TRADERS WELCOME: OPEN API + SDK', `${PAD_URL}/docs`),
      info('NO SNIPER LIMITS, NO MAX BUY, NO BLACKLISTS'),
    ];
    let i = 0;
    while (items.length < MIN_ITEMS && i < facts.length * 2) items.push(facts[i++ % facts.length]);

    // Two copies so the -50% scroll loops seamlessly; speed scales with length.
    track.innerHTML = items.join('') + items.join('');
    track.style.setProperty('--market-bar-speed', `${Math.max(30, items.length * 6)}s`);
  }

  render();
  setInterval(() => { if (!document.hidden) render(); }, REFRESH_MS);
})();
