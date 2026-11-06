// Checks the engine inside SKILL.md against the research backtest on the same CSV and news.
// Usage: node verify_engine.js <SKILL.md> <M15.csv> <news.txt>
// Expected: afternoon 43 trades (19/20/4) +425.98, evening 20 trades (9/7/4) +506.68.
const fs = require('fs');
const [, , skillPath, m15Path, newsPath] = process.argv;
const text = fs.readFileSync(skillPath, 'utf8');
const start = text.indexOf('window.StradeEngine = (function(){');
const end = text.indexOf('\n```', start);
if (start < 0 || end < 0) throw new Error('engine block not found');
global.window = {};
global.TradingViewApi = {};
// eslint-disable-next-line no-eval
(0, eval)(text.slice(start, end));
const E = global.window.StradeEngine;

const LA = 7 * 3600;
const laDate = t => new Date((t + LA) * 1000).toISOString().slice(0, 10);
const laMin = t => Math.floor(((t + LA) % 86400) / 60);
const ny = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
const B = [];
for (const line of fs.readFileSync(m15Path, 'utf8').split(/\r?\n/)) {
  if (!line) continue;
  const [ts, o, h, l, c] = line.split(',');
  const t = Date.parse(ts.replace(' ', 'T') + ':00Z') / 1000;
  B.push({ t, o: +o, h: +h, l: +l, c: +c, td: ny.format(new Date((t + LA) * 1000)), ld: laDate(t), lm: laMin(t) });
}
const news = {};
for (const tok of fs.readFileSync(newsPath, 'utf8').split(/\s+/)) {
  if (tok.length !== 10) continue;
  const t = Date.UTC(2000 + +tok.slice(0, 2), +tok.slice(2, 4) - 1, +tok.slice(4, 6), +tok.slice(6, 8), +tok.slice(8, 10)) / 1000;
  const d = laDate(t);
  (news[d] = news[d] || []).push(laMin(t));
}
const dates = [...new Set(B.map(x => x.ld))];
const lastLE = x => { let lo = 0, hi = B.length - 1, a = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (B[m].t <= x) { a = m; lo = m + 1; } else hi = m - 1; } return a; };
const laToUtc = (d, hh, mm) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10), hh, mm) / 1000 - LA;

function run(session) {
  const o = { session }, pl = E.SESSIONS[session].planLA;
  let W = 0, L = 0, C = 0, pnl = 0; const trades = {};
  for (const d of dates) {
    // Same 6,400-bar depth as the research script, about what the live chart loads.
    const li = lastLE(laToUtc(d, pl[0], pl[1]) - 900);
    const hist = li < 0 ? [] : B.slice(Math.max(0, li - 6400), li + 1);
    const p = E.plan(hist, d, o, 0);
    if (!p.ok || !p.setup || !p.setup.pass) continue;
    const r = E.simulate(B, d, p.setup, o, news[d] || []);
    if (!['win', 'loss', 'closedEnd'].includes(r.res)) continue;
    if (r.res === 'win') W++; else if (r.res === 'loss') L++; else C++;
    pnl += r.pnl; trades[d] = r;
  }
  return { n: W + L + C, W, L, C, pnl: Math.round(pnl * 100) / 100, trades };
}
const a = run('afternoon'), e = run('evening');
let both = a.pnl; let bothN = a.n; for (const d in e.trades) if (!a.trades[d]) { both += e.trades[d].pnl; bothN++; }
console.log('afternoon', a.n, `${a.W}/${a.L}/${a.C}`, a.pnl);
console.log('evening  ', e.n, `${e.W}/${e.L}/${e.C}`, e.pnl);
console.log('one a day', bothN, Math.round(both * 100) / 100);
console.log('window sample evening, NFP 20:30:', JSON.stringify(E.orderWindow({ session: 'evening' }, [1230])));
console.log('window sample evening, no news:', JSON.stringify(E.orderWindow({ session: 'evening' }, [])));
console.log('window sample afternoon:', JSON.stringify(E.orderWindow({ session: 'afternoon' }, [])));
