// Strade window backtest: runs the skill's engine logic on CSV history, so the
// afternoon window and candidate evening windows can be compared on the same days.
// Usage: node strade_window_backtest.js <M15.csv> <M5.csv> <news.txt>
const fs = require('fs');
const [, , m15Path, m5Path, newsPath] = process.argv;

const LA_OFF = 7 * 3600;
const r2 = x => Math.round(x * 100) / 100;
const nyDate = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
const nyHour = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', hour12: false });
const tdKey = t => nyDate.format(new Date((t + 7 * 3600) * 1000));
const laDate = t => new Date((t + LA_OFF) * 1000).toISOString().slice(0, 10);
const laMin = t => Math.floor(((t + LA_OFF) % 86400) / 60);
const laToUtc = (d, hh, mm) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10), hh, mm) / 1000 - LA_OFF;
const hm = m => [Math.floor(m / 60), m % 60];

function loadCsv(path, withKeys) {
  const out = [];
  for (const line of fs.readFileSync(path, 'utf8').split(/\r?\n/)) {
    if (!line) continue;
    const [ts, o, h, l, c] = line.split(',');
    const t = Date.parse(ts.replace(' ', 'T') + ':00Z') / 1000;
    if (!Number.isFinite(t)) continue;
    const b = { t, o: +o, h: +h, l: +l, c: +c };
    if (withKeys) { b.td = tdKey(t); b.ld = laDate(t); b.lm = laMin(t); }
    out.push(b);
  }
  return out;
}

// Index of the last bar with t <= x, or -1.
function lastLE(a, x) {
  let lo = 0, hi = a.length - 1, ans = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (a[m].t <= x) { ans = m; lo = m + 1; } else hi = m - 1; }
  return ans;
}

function agg(B, keyFn) { const out = []; let cur = null; for (const x of B) { const k = keyFn(x); if (!cur || cur.k !== k) { cur = { k, t: x.t, o: x.o, h: x.h, l: x.l, c: x.c }; out.push(cur); } else { if (x.h > cur.h) cur.h = x.h; if (x.l < cur.l) cur.l = x.l; cur.c = x.c; } } return out; }
function ema(a, p) { const k = 2 / (p + 1); let e = a[0]; return a.map(v => e = v * k + e * (1 - k)); }
function atr(bars, p = 14) { let a = 0; bars.forEach((b, i) => { const tr = i ? Math.max(b.h - b.l, Math.abs(b.h - bars[i - 1].c), Math.abs(b.l - bars[i - 1].c)) : b.h - b.l; a = i < p ? (a * i + tr) / (i + 1) : (a * (p - 1) + tr) / p; }); return a; }
function swings(bars, k = 2) { const H = [], L = []; for (let i = k; i < bars.length - k; i++) { let isH = true, isL = true; for (let j = i - k; j <= i + k; j++) { if (j === i) continue; if (bars[j].h > bars[i].h) isH = false; if (bars[j].l < bars[i].l) isL = false; } if (isH) H.push({ i, p: bars[i].h }); if (isL) L.push({ i, p: bars[i].l }); } return { H, L }; }

const DEF = { entryFib: 0.382, slFib: 0.786, legLookback: 30, minLegATR: 1.5, bufATR: 0.2, bufMin: 0.5, tp: 10, slMax: 15, slWarn: 10,
  atrMin: 3, atrMax: 10, atrFilter: true, exhaust: 1.2, trendScore: 3, minGrade: 6, rangeOffATR: 0, rangeSLATR: 1.2, rangeSLMin: 5,
  oz: 10, spread: 0.4, planLA: [13, 45], endLA: [18, 0], rangeFromMin: 420, norm: false, depth: 6400,
  // Trend-mode experiments. The defaults keep the skill's behaviour.
  trendMin: 0, legMaxAge: 0, slMinATR: 0.8, reqTpInLeg: false, reqFvg: false, maxStretch: 0, reqStruct: false, reqStack: false, reqD1: false,
  minStretch: 0, reqLondon: false, reqNoFvg: false, hardExhaust: 0, fillEndMin: 0 };

// Same logic as StradeEngine.plan in the skill. Two additions, both off by default:
// rangeFromMin (start of the range) and norm (scale every dollar constant to price/4000).
function plan(B, dateLA, opt = {}, macro = 0) {
  const P = { ...DEF, ...opt };
  const asOf = laToUtc(dateLA, P.planLA[0], P.planLA[1]);
  const li = lastLE(B, asOf - 900);
  if (li < 400) return { date: dateLA, ok: false, why: 'not enough data' };
  const hist = B.slice(Math.max(0, li - P.depth), li + 1);
  const last = hist[hist.length - 1]; if (asOf - (last.t + 900) > 3600) return { date: dateLA, ok: false, why: 'market closed' };
  const price = last.c;
  const K = P.norm ? price / 4000 : 1;
  const H1 = agg(hist, x => Math.floor(x.t / 3600)).filter(h => (h.k + 1) * 3600 <= asOf);
  const D = agg(hist, x => x.td); const today = D[D.length - 1]; const days = D.slice(0, -1);
  if (days.length < 15 || H1.length < 210) return { date: dateLA, ok: false, why: 'warmup' };
  const pd = days[days.length - 1];
  const c1 = H1.map(h => h.c), e20 = ema(c1, 20).pop(), e50 = ema(c1, 50).pop(), e200 = ema(c1, 200).pop();
  const atrH1 = atr(H1.slice(-200)), atrM15 = atr(hist.slice(-400));
  const dE10 = ema(days.map(d => d.c), 10).pop();
  const adr = days.slice(-14).reduce((a, d) => a + (d.h - d.l), 0) / 14, todayRange = today.h - today.l;
  const asia = hist.filter(x => x.ld === dateLA && x.lm >= P.rangeFromMin);
  const asH = asia.length ? Math.max(...asia.map(x => x.h)) : null, asL = asia.length ? Math.min(...asia.map(x => x.l)) : null;
  const sw = swings(H1.slice(-120), 2), sH = sw.H.slice(-2), sL = sw.L.slice(-2);
  let s1 = 0; if (sH.length === 2 && sL.length === 2) { if (sH[1].p > sH[0].p && sL[1].p > sL[0].p) s1 = 1; else if (sH[1].p < sH[0].p && sL[1].p < sL[0].p) s1 = -1; }
  const s2 = (e20 > e50 && e50 > e200) ? 1 : (e20 < e50 && e50 < e200) ? -1 : 0, s3 = price > e50 ? 1 : -1, s4 = pd.c > dE10 ? 1 : -1;
  const score = s1 + s2 + s3 + s4 + macro;
  const buf = Math.max(P.bufATR * atrM15, P.bufMin * K);
  const lv = [pd.h, pd.l, asH, asL].filter(v => v != null);
  const nearLevel = p => lv.some(L => Math.abs(L - p) <= 2 * K) || Math.abs(p - Math.round(p / 50) * 50) <= 2 * K;
  const atrOk = atrM15 >= P.atrMin * K && atrM15 <= P.atrMax * K;
  const tpD = P.tp * K;
  let s, mode, extraOk = true, feat = null;
  if (Math.abs(score) >= P.trendScore) {
    mode = 'trend'; const dir = score > 0 ? 1 : -1;
    const look = H1.slice(-P.legLookback);
    const extI = look.reduce((m, h, i) => dir > 0 ? (h.l < look[m].l ? i : m) : (h.h > look[m].h ? i : m), 0);
    const legBars = look.slice(extI);
    s = { dir, legA: dir > 0 ? look[extI].l : look[extI].h, legB: dir > 0 ? Math.max(...legBars.map(h => h.h)) : Math.min(...legBars.map(h => h.l)) };
    const range = Math.abs(s.legB - s.legA);
    if (range < P.minLegATR * atrH1) return { date: dateLA, ok: true, mode, setup: null, why: 'no impulse leg' };
    const fib = x => s.legB - dir * x * range;
    s.entry = fib(P.entryFib);
    const sw2 = swings(legBars.length >= 5 ? legBars : look, 1);
    const cands = (dir > 0 ? sw2.L.map(x => x.p).filter(p => p < s.entry) : sw2.H.map(x => x.p).filter(p => p > s.entry)).concat([fib(P.slFib), s.legA]);
    const dists = cands.map(p => dir > 0 ? s.entry - (p - buf) : (p + buf) - s.entry).filter(d => d >= P.slMinATR * atrM15).sort((a, b) => a - b);
    if (!dists.length) return { date: dateLA, ok: true, mode, setup: null, why: 'no SL structure' };
    s.slD = dists[0]; s.sl = s.entry - dir * s.slD; s.tp = s.entry + dir * tpD;
    let fvg = false; for (let i = 1; i < legBars.length - 1; i++) { const a = legBars[i - 1], c = legBars[i + 1];
      if (dir > 0 && c.l > a.h && s.entry >= a.h - K && s.entry <= c.l + K) fvg = true;
      if (dir < 0 && c.h < a.l && s.entry <= a.l + K && s.entry >= c.h - K) fvg = true; }
    s.pts = { bias: Math.abs(score) >= 4 ? 3 : 2, fvg: fvg ? 2 : 0, level: nearLevel(s.entry) ? 2 : 0, tpInLeg: (dir > 0 ? s.tp <= s.legB : s.tp >= s.legB) ? 1 : 0,
      atr: atrOk ? 1 : 0, fresh: todayRange <= P.exhaust * adr ? 1 : 0 };
    const bI = legBars.reduce((m, h, i) => dir > 0 ? (h.h > legBars[m].h ? i : m) : (h.l < legBars[m].l ? i : m), 0);
    const legAge = legBars.length - 1 - bI, stretch = Math.abs(price - s.entry) / atrH1, tpIn = s.pts.tpInLeg === 1;
    feat = { score: Math.abs(score), legAge, legATR: range / atrH1, slATR: s.slD / atrM15, stretch, fvg, tpIn, st: s1 === dir, stack: s2 === dir, d1: s4 === dir, fresh: s.pts.fresh === 1 };
    if (P.trendMin && Math.abs(score) < P.trendMin) extraOk = false;
    if (P.legMaxAge && legAge > P.legMaxAge) extraOk = false;
    if (P.maxStretch && stretch > P.maxStretch) extraOk = false;
    if (P.reqTpInLeg && !tpIn) extraOk = false;
    if (P.reqFvg && !fvg) extraOk = false;
    if (P.reqStruct && !feat.st) extraOk = false;
    if (P.reqStack && !feat.stack) extraOk = false;
    if (P.reqD1 && !feat.d1) extraOk = false;
    if (P.minStretch && stretch < P.minStretch) extraOk = false;
    if (P.reqNoFvg && fvg) extraOk = false;
    if (P.hardExhaust && todayRange > P.hardExhaust * adr) extraOk = false;
    if (P.reqLondon) { const lon = hist.filter(x => x.ld === dateLA && x.lm >= 840); if (!lon.length || (price - lon[0].o) * dir <= 0) extraOk = false; }
  } else if (score !== 0 && asH != null) {
    mode = 'range'; const dir = score > 0 ? 1 : -1;
    s = { dir, entry: dir > 0 ? asL - P.rangeOffATR * atrM15 : asH + P.rangeOffATR * atrM15 };
    s.slD = Math.max(P.rangeSLATR * atrM15, P.rangeSLMin * K); s.sl = s.entry - dir * s.slD; s.tp = s.entry + dir * tpD;
    s.pts = { bias: Math.abs(score), level: nearLevel(dir > 0 ? asL : asH) ? 2 : 0, tpInRange: (dir > 0 ? s.tp <= asH : s.tp >= asL) ? 1 : 0,
      atr: atrOk ? 1 : 0, fresh: todayRange <= P.exhaust * adr ? 1 : 0, width: (asH - asL) >= 12 * K ? 1 : 0 };
  } else return { date: dateLA, ok: true, mode: 'flat', setup: null, why: 'bias score 0' };
  s.grade = Object.values(s.pts).reduce((a, b) => a + b, 0);
  const wrongSide = (s.dir > 0 && s.entry >= price) || (s.dir < 0 && s.entry <= price);
  const pass = extraOk && s.slD <= P.slMax * K && !wrongSide && s.grade >= P.minGrade && (!P.atrFilter || atrOk);
  return { date: dateLA, ok: true, mode, K, setup: { dir: s.dir > 0 ? 'BUY' : 'SELL', entry: s.entry, sl: s.sl, tp: s.tp, slD: s.slD, grade: s.grade, pass, feat } };
}

// Same logic as StradeEngine.simulate. Same-bar SL after a fill counts as a loss.
function simulate(bars, dateLA, st, startMin, endMin, K, opt = {}) {
  const P = { ...DEF, ...opt };
  const [sh, sm] = hm(startMin), [eh, em] = hm(endMin);
  const t0 = laToUtc(dateLA, sh, sm), t1 = laToUtc(dateLA, eh, em);
  const i0 = lastLE(bars, t0 - 1) + 1; const w = [];
  for (let i = i0; i < bars.length && bars[i].t < t1; i++) w.push(bars[i]);
  if (!w.length) return { res: 'nodata' };
  const buy = st.dir === 'BUY', sp = P.spread * K;
  const fill = b => buy ? b.l <= st.entry - sp : b.h >= st.entry;
  const hitSL = b => buy ? b.l <= st.sl : b.h >= st.sl - sp;
  const hitTP = b => buy ? b.h >= st.tp : b.l <= st.tp - sp;
  const tpBeyond = buy ? st.tp > w[0].o : st.tp < w[0].o;
  let filled = false, ft = null;
  const tFill = P.fillEndMin ? laToUtc(dateLA, ...hm(P.fillEndMin)) : Infinity;
  for (const b of w) {
    if (!filled) {
      if (b.t >= tFill) return { res: 'nofill' };
      if (fill(b)) { filled = true; ft = b.t; if (hitSL(b)) return { res: 'loss', pnl: -st.slD * P.oz, ft, xt: b.t }; continue; }
      if (tpBeyond && hitTP(b)) return { res: 'missed' };
    } else {
      if (hitSL(b)) return { res: 'loss', pnl: -st.slD * P.oz, ft, xt: b.t };
      if (hitTP(b)) return { res: 'win', pnl: P.tp * K * P.oz, ft, xt: b.t };
    }
  }
  if (!filled) return { res: 'nofill' };
  const exit = w[w.length - 1].c;
  return { res: 'closed', pnl: (buy ? exit - st.entry : st.entry - exit - sp) * P.oz, ft, xt: w[w.length - 1].t };
}

const B = loadCsv(m15Path, true);
const B5 = loadCsv(m5Path, false);
const M5_FROM = '2025-06-10';
const NEWS = {};
for (const tok of fs.readFileSync(newsPath, 'utf8').split(/\s+/)) {
  if (tok.length !== 10) continue;
  const t = Date.UTC(2000 + +tok.slice(0, 2), +tok.slice(2, 4) - 1, +tok.slice(4, 6), +tok.slice(6, 8), +tok.slice(8, 10)) / 1000;
  const ld = laDate(t), lm = laMin(t);
  (NEWS[ld] = NEWS[ld] || []).push(lm);
}
for (const k in NEWS) NEWS[k].sort((a, b) => a - b);
const dates = [...new Set(B.map(x => x.ld))];
const seasonCache = {};
const season = d => seasonCache[d] || (seasonCache[d] = nyHour.format(new Date(Date.parse(d + 'T12:00:00Z'))) === '08' ? 'EDT' : 'EST');
const isTrade = r => r && ['win', 'loss', 'closed'].includes(r.res);

function run(cfg) {
  const rows = [];
  const opt = { ...(cfg.opt || {}), planLA: hm(cfg.p) };
  for (const d of dates) {
    const p = plan(B, d, opt);
    if (!p.ok) continue;
    const r = { date: d, mode: p.mode };
    if (!(p.setup && p.setup.pass)) { r.res = p.setup ? 'filtered' : 'nosetup'; rows.push(r); continue; }
    if (cfg.trendOnly && p.mode !== 'trend') { r.res = 'modeSkip'; rows.push(r); continue; }
    let s = cfg.s, e = cfg.e;
    if (cfg.news !== false) {
      const ev = (NEWS[d] || []).filter(m => m + 30 > s && m - 30 < e);
      if (ev.length) { if (ev[0] - 30 <= s) { r.res = 'newsSkip'; rows.push(r); continue; } e = ev[0] - 30; }
    }
    const bars = (cfg.m5 && d >= M5_FROM) ? B5 : B;
    const K = p.K;
    const x = simulate(bars, d, p.setup, s, e, K, cfg.opt || {});
    Object.assign(r, x, { dir: p.setup.dir, slD: p.setup.slD, K, grade: p.setup.grade, feat: p.setup.feat });
    if (x.pnl != null) r.val = x.pnl / K;
    rows.push(r);
  }
  return rows;
}

function stats(rows) {
  const tr = rows.filter(isTrade);
  const n = k => tr.filter(r => r.res === k).length;
  let eq = 0, peak = 0, dd = 0, st = 0, mx = 0;
  for (const r of tr) { eq += r.val; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); if (r.val < 0) { st++; mx = Math.max(mx, st); } else st = 0; }
  const by = (keyFn) => { const o = {}; for (const r of tr) { const k = keyFn(r); o[k] = o[k] || { n: 0, w: 0, pnl: 0 }; o[k].n++; if (r.res === 'win') o[k].w++; o[k].pnl += r.val; } for (const k in o) o[k].pnl = r2(o[k].pnl); return o; };
  return { n: tr.length, W: n('win'), L: n('loss'), C: n('closed'), wr: tr.length ? r2(100 * n('win') / tr.length) : 0, pnl: r2(eq), avg: tr.length ? r2(eq / tr.length) : 0, dd: r2(dd), streak: mx, ratio: dd ? r2(eq / dd) : 0,
    year: by(r => r.date.slice(0, 4)), season: by(r => season(r.date)), sameBar: tr.filter(r => r.res === 'loss' && r.ft === r.xt).length, nofill: rows.filter(r => r.res === 'nofill').length, skip: rows.filter(r => r.res === 'newsSkip').length };
}

function line(name, s) {
  const y = ['2022', '2023', '2024', '2025', '2026'].map(k => s.year[k] ? `${k.slice(2)}:${s.year[k].pnl}/${s.year[k].n}` : `${k.slice(2)}:-`).join(' ');
  const ss = ['EDT', 'EST'].map(k => s.season[k] ? `${k}:${s.season[k].pnl}/${s.season[k].n}` : `${k}:-`).join(' ');
  return `${name.padEnd(30)} n${s.n} W${s.W} L${s.L} C${s.C} wr${s.wr} pnl${s.pnl} avg${s.avg} DD${s.dd} str${s.streak} r${s.ratio} same${s.sameBar} | ${y} | ${ss}`;
}

function combo(aRows, nRows) {
  const mA = Object.fromEntries(aRows.map(r => [r.date, r])), mN = Object.fromEntries(nRows.map(r => [r.date, r]));
  const D = [...new Set([...aRows.map(r => r.date), ...nRows.map(r => r.date)])].sort();
  const go = rule => { const out = []; for (const d of D) { const A = mA[d], N = mN[d]; if (isTrade(A)) out.push(A); if (isTrade(N) && rule(A)) out.push(N); } return stats(out); };
  return { oneDay: go(A => !isTrade(A)), both: go(() => true) };
}

const A14 = { p: 825, s: 840, e: 1080 }, E18 = { p: 1080, s: 1095, e: 1320 }, N20 = { p: 1200, s: 1215, e: 1440 };
const R14 = { rangeFromMin: 840 }, R18 = { rangeFromMin: 1080 };
const base = [
  ['A 14:00-18:00', { ...A14 }],
  ['E 18:15-22 nonews', { ...E18, news: false }],
  ['E 18:15-22 r07', { ...E18 }],
  ['E 18:15-22 r14', { ...E18, opt: R14 }],
  ['E 18:15-22 r07 off.5', { ...E18, opt: { rangeOffATR: 0.5 } }],
  ['E 18:15-22 r07 off1', { ...E18, opt: { rangeOffATR: 1 } }],
  ['E 18:15-22 trendOnly', { ...E18, trendOnly: true }],
  ['N 20:15-24 nonews', { ...N20, news: false }],
  ['N 20:15-24 r07', { ...N20 }],
  ['N 20:15-24 r14', { ...N20, opt: R14 }],
  ['N 20:15-24 r18', { ...N20, opt: R18 }],
  ['N 20:15-24 r07 off.5', { ...N20, opt: { rangeOffATR: 0.5 } }],
  ['N 20:15-24 r07 off1', { ...N20, opt: { rangeOffATR: 1 } }],
  ['N 20:15-24 trendOnly', { ...N20, trendOnly: true }],
];
const withOpt = (cfg, extra) => ({ ...cfg, opt: { ...(cfg.opt || {}), ...extra } });

if (process.argv[5] === 'trend3') {
  const HOLD = '2026-01-01', T = { trendOnly: true };
  const short = rows => { const s = stats(rows); return `n${s.n} ${s.W}/${s.L}/${s.C} pnl${s.pnl} avg${s.avg} DD${s.dd}`; };
  const split = rows => `${short(rows.filter(r => r.date < HOLD))} || 26: ${short(rows.filter(r => r.date >= HOLD))}`;
  const tv = rows => { const v = rows.filter(isTrade).map(r => r.val); if (v.length < 3) return 'n/a'; const m = v.reduce((a, b) => a + b, 0) / v.length, sd = Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / (v.length - 1)); return `t ${r2(m / (sd / Math.sqrt(v.length)))}`; };
  const TP = { reqTpInLeg: true }, F = m => ({ fillEndMin: m });
  const grid = [['base', {}], ['F2030', F(1230)], ['F2030+TP', { ...F(1230), ...TP }], ['F2030+TP+X.8', { ...F(1230), ...TP, hardExhaust: 0.8 }], ['F2030+TP+X.7', { ...F(1230), ...TP, hardExhaust: 0.7 }], ['F2030+TP+X.6', { ...F(1230), ...TP, hardExhaust: 0.6 }],
    ['F2000+TP+X.8', { ...F(1200), ...TP, hardExhaust: 0.8 }], ['F2100+TP+X.8', { ...F(1260), ...TP, hardExhaust: 0.8 }], ['F2030+TP+L4', { ...F(1230), ...TP, minLegATR: 4 }], ['F2030+TP+X.8+L4', { ...F(1230), ...TP, hardExhaust: 0.8, minLegATR: 4 }], ['TP+X.8', { ...TP, hardExhaust: 0.8 }], ['TP+X.8+L4', { ...TP, hardExhaust: 0.8, minLegATR: 4 }]];
  console.log('== Combinations, E 18:15-22 trend mode. Up to 2025 || 2026');
  for (const [n, o] of grid) {
    console.log(`${n.padEnd(18)} FIX ${split(run({ ...E18, ...T, opt: o }))}`);
    console.log(`${''.padEnd(18)} NRM ${split(run({ ...E18, ...T, opt: { ...o, norm: true } }))}`);
    console.log(`${''.padEnd(18)} M5  ${short(run({ ...E18, ...T, opt: o, m5: true }).filter(r => r.date >= M5_FROM))}`);
  }
  for (const [n, o] of [['F2030+TP+X.8', { ...F(1230), ...TP, hardExhaust: 0.8 }], ['F2030+TP+X.8+L4', { ...F(1230), ...TP, hardExhaust: 0.8, minLegATR: 4 }]]) {
    console.log(`\n== Detail ${n}`);
    const sets = [['fixed', c => run(c)], ['m5', c => run({ ...c, m5: true }).filter(r => r.date >= M5_FROM)], ['norm', c => run(withOpt(c, { norm: true }))]];
    for (const [label, go] of sets) {
      const Et = go({ ...E18, ...T, opt: o });
      const A = go(A14), Ar = A.map(r => (r.mode === 'range' ? r : { date: r.date, mode: r.mode, res: 'modeSkip' }));
      console.log(line(`${label} evening new`, stats(Et)) + ' ' + tv(Et));
      console.log(line(`${label} A range + new 1/day`, combo(Ar, Et).oneDay));
      const noFill = { ...o }; delete noFill.fillEndMin;
      console.log(line(`${label} same on 20:15-24`, stats(go({ ...N20, ...T, opt: noFill }))));
      console.log(line(`${label} same on A 14-18`, stats(go({ ...A14, ...T, opt: noFill }))));
    }
    console.log('fixed trades: ' + run({ ...E18, ...T, opt: o }).filter(isTrade).map(r => `${r.date} ${r.dir} ${r.res} ${r2(r.val)}`).join(' | '));
  }
  process.exit(0);
}

if (process.argv[5] === 'trend') {
  const HOLD = '2026-01-01';
  const short = rows => { const s = stats(rows); return `n${s.n} ${s.W}/${s.L}/${s.C} pnl${s.pnl} avg${s.avg} DD${s.dd}`; };
  const split = rows => `${short(rows.filter(r => r.date < HOLD))} || 26: ${short(rows.filter(r => r.date >= HOLD))}`;
  const T = { trendOnly: true };
  const row = (name, cfg, o = {}) => console.log(`${name.padEnd(20)} FIX ${split(run({ ...cfg, ...T, opt: o }))}\n${''.padEnd(20)} NRM ${split(run({ ...cfg, ...T, opt: { ...o, norm: true } }))}`);

  console.log('== Diagnosis of the current trend trades, E 18:15-22 and A 14-18 (normalised, all years)');
  for (const [wName, cfg] of [['E', E18], ['A', A14], ['N', N20]]) {
    const rows = run({ ...cfg, ...T, opt: { norm: true } }).filter(isTrade);
    const group = (label, fn) => { const o = {}; for (const r of rows) { const k = fn(r); (o[k] = o[k] || []).push(r); } console.log(`${wName} ${label}: ` + Object.keys(o).sort().map(k => `${k}[${short(o[k])}]`).join('  ')); };
    console.log(`${wName} all ${short(rows)} sameBarLoss ${rows.filter(r => r.res === 'loss' && r.ft === r.xt).length}`);
    group('dir', r => r.dir);
    group('score', r => r.feat.score);
    group('legAge', r => r.feat.legAge <= 4 ? 'a<=4' : r.feat.legAge <= 12 ? 'b5-12' : 'c13+');
    group('legATR', r => r.feat.legATR < 3 ? 'a<3' : r.feat.legATR < 5 ? 'b3-5' : r.feat.legATR < 8 ? 'c5-8' : 'd8+');
    group('slATR', r => r.feat.slATR < 1 ? 'a<1' : r.feat.slATR < 1.5 ? 'b1-1.5' : 'c1.5+');
    group('stretch', r => r.feat.stretch < 1 ? 'a<1' : r.feat.stretch < 2 ? 'b1-2' : 'c2+');
    group('fvg', r => r.feat.fvg);
    group('tpInLeg', r => r.feat.tpIn);
    group('struct', r => r.feat.st);
    group('stack', r => r.feat.stack);
    group('d1', r => r.feat.d1);
    group('fresh', r => r.feat.fresh);
  }

  console.log('\n== One change at a time, E 18:15-22 trend mode. Left of || is up to 2025, right is 2026');
  const tests = [['base', {}], ['score>=4', { trendMin: 4 }], ['score>=5', { trendMin: 5 }], ['reqStruct', { reqStruct: true }], ['reqStack', { reqStack: true }], ['reqD1', { reqD1: true }],
    ['fib.236', { entryFib: 0.236 }], ['fib.5', { entryFib: 0.5 }], ['fib.618', { entryFib: 0.618 }],
    ['slMin1', { slMinATR: 1 }], ['slMin1.5', { slMinATR: 1.5 }], ['slMin2', { slMinATR: 2 }],
    ['legAge<=4', { legMaxAge: 4 }], ['legAge<=8', { legMaxAge: 8 }], ['legAge<=12', { legMaxAge: 12 }],
    ['minLeg2', { minLegATR: 2 }], ['minLeg3', { minLegATR: 3 }], ['look20', { legLookback: 20 }], ['look50', { legLookback: 50 }],
    ['reqTpInLeg', { reqTpInLeg: true }], ['reqFvg', { reqFvg: true }], ['stretch<=1', { maxStretch: 1 }], ['stretch<=2', { maxStretch: 2 }],
    ['grade5', { minGrade: 5 }], ['grade7', { minGrade: 7 }]];
  if (process.argv[6] !== 'batch2') for (const [n, o] of tests) row(n, E18, o);
  console.log('\n== Second batch, E 18:15-22 trend mode');
  const tests2 = [['base', {}], ['fillEnd19:30', { fillEndMin: 1170 }], ['fillEnd20:00', { fillEndMin: 1200 }], ['fillEnd20:30', { fillEndMin: 1230 }], ['fillEnd21:00', { fillEndMin: 1260 }],
    ['exhaust1.0', { hardExhaust: 1 }], ['exhaust0.8', { hardExhaust: 0.8 }], ['exhaust0.6', { hardExhaust: 0.6 }],
    ['slMax10', { slMax: 10 }], ['slMax12', { slMax: 12 }], ['atrMax8', { atrMax: 8 }], ['atrMax12', { atrMax: 12 }], ['atrMax15', { atrMax: 15 }],
    ['minStretch.5', { minStretch: 0.5 }], ['minStretch1', { minStretch: 1 }], ['minLeg4', { minLegATR: 4 }], ['minLeg5', { minLegATR: 5 }], ['reqLondon', { reqLondon: true }], ['noFvg', { reqNoFvg: true }]];
  for (const [n, o] of tests2) row(n, E18, o);
  process.exit(0);
}

if (process.argv[5] === 'best') {
  const sets = [
    ['fixed', c => run(c)],
    ['m5', c => run({ ...c, m5: true }).filter(r => r.date >= M5_FROM)],
    ['norm', c => run(withOpt(c, { norm: true }))],
  ];
  for (const [label, go] of sets) {
    console.log(`\n== ${label}: by mode`);
    for (const [n, c] of [['A', A14], ['E', E18], ['N', N20]]) {
      const rows = go(c);
      for (const m of ['trend', 'range']) console.log(line(`${n} ${m}`, stats(rows.filter(r => r.mode === m))));
    }
    const A = go(A14), At = go({ ...A14, trendOnly: true }), Et = go({ ...E18, trendOnly: true });
    console.log(`== ${label}: daily plans`);
    console.log(line('P0 afternoon as is', stats(A)));
    console.log(line('P1 evening trend alone', stats(Et)));
    console.log(line('P2 afternoon + E trend 1/day', combo(A, Et).oneDay));
    console.log(line('P3 A trend + E trend 1/day', combo(At, Et).oneDay));
    console.log(line('P4 A trend + E trend 1/window', combo(At, Et).both));
    console.log(line('P5 afternoon trend alone', stats(At)));
    const Ar = A.map(r => (r.mode === 'range' ? r : { date: r.date, mode: r.mode, res: 'modeSkip' }));
    console.log(line('P6 afternoon range alone', stats(Ar)));
    console.log(line('P7 A range + E trend 1/day', combo(Ar, Et).oneDay));
    const tv = rows => { const v = rows.filter(isTrade).map(r => r.val), m = v.reduce((a, b) => a + b, 0) / v.length, sd = Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / (v.length - 1)); return `tstat n${v.length} avg ${r2(m)} sd ${r2(sd)} t ${r2(m / (sd / Math.sqrt(v.length)))}`; };
    console.log('P8 tstat E trend ' + tv(Et));
    console.log('P9 tstat A range ' + tv(Ar));
  }
  process.exit(0);
}

console.log(`bars M15 ${B.length} ${laDate(B[0].t)}..${laDate(B[B.length - 1].t)} | M5 ${B5.length} | news days ${Object.keys(NEWS).length} | trading dates ${dates.length}`);

console.log('\n== CROSS-CHECK fixed $, 2026-08-24..2026-11-04 (chart: A13:45 9t +276.55 | A14 10t +161.95 | E 8t +280.50 | N 9t -425.80)');
const inChk = r => r.date >= '2026-08-24' && r.date <= '2026-11-04';
for (const [n, c] of [['A 13:45-18', { p: 825, s: 825, e: 1080 }], ['A 14-18', A14], ['E 18:15-22', E18], ['N 20:15-24', N20]]) console.log(line(n, stats(run(c).filter(inChk))));

console.log('\n== FIXED DOLLARS (rules as written), M15 fills');
const fixed = {}; for (const [n, c] of base) { fixed[n] = run(c); console.log(line(n, stats(fixed[n]))); }

console.log('\n== FIXED DOLLARS from 2025-06-10, M5 fills (better intrabar order)');
const fixedM5 = {}; for (const [n, c] of base) { fixedM5[n] = run({ ...c, m5: true }).filter(r => r.date >= M5_FROM); console.log(line(n, stats(fixedM5[n]))); }

console.log('\n== NORMALISED (dollar rules scaled to price/4000, P&L in today-equivalent $), M15 fills');
const norm = {}; for (const [n, c] of base) { norm[n] = run(withOpt(c, { norm: true })); console.log(line(n, stats(norm[n]))); }

console.log('\n== COMBOS with afternoon: one trade a day vs one per window');
for (const n of ['E 18:15-22 r07', 'E 18:15-22 r14', 'N 20:15-24 r07', 'N 20:15-24 r14']) {
  const f = combo(fixed['A 14:00-18:00'], fixed[n]), m = combo(fixedM5['A 14:00-18:00'], fixedM5[n]), o = combo(norm['A 14:00-18:00'], norm[n]);
  console.log(line('fixed oneDay ' + n, f.oneDay)); console.log(line('fixed both   ' + n, f.both));
  console.log(line('m5    oneDay ' + n, m.oneDay)); console.log(line('m5    both   ' + n, m.both));
  console.log(line('norm  oneDay ' + n, o.oneDay)); console.log(line('norm  both   ' + n, o.both));
}
