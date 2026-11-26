import { getStore } from '@netlify/blobs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const TZ = 'Asia/Seoul';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const r2 = (x) => Math.round(x * 100) / 100;

/* ---------- 시간 도우미 ---------- */
function tp(d, tz, opt) {
  const o = {};
  new Intl.DateTimeFormat('en-US', Object.assign({ timeZone: tz, hourCycle: 'h23' }, opt)).formatToParts(d).forEach((p) => { o[p.type] = p.value; });
  return o;
}
const DT = { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' };
function ymdTz(d, tz) { const p = tp(d, tz, DT); return p.year + '-' + p.month + '-' + p.day; }
function mdHm(d) { const p = tp(d, TZ, DT); return p.month + '-' + p.day + ' ' + p.hour + ':' + p.minute; }
function nowKst() { const p = tp(new Date(), TZ, DT); return p.month + '-' + p.day + ' ' + p.hour + ':' + p.minute + ':' + p.second; }
function dowKst(d) { return { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' }).format(d)]; }
const KO = ['', '월', '화', '수', '목', '금', '토', '일'];
function edays(k) { return Math.floor(Date.parse(k + 'T00:00:00Z') / 86400000); }

/* ---------- 캐시 / 저장소 ---------- */
const mem = new Map();
let _c = null, _p = null;
function cs() { if (_c === null) { try { _c = getStore('cache'); } catch (e) { _c = false; } } return _c; }
function ps() { if (_p === null) { try { _p = getStore('data'); } catch (e) { _p = false; } } return _p; }
async function cget(k, ttl) {
  const m = mem.get(k); if (m && m.e > Date.now()) return m.v;
  if (ttl <= 120) return null;
  const s = cs(); if (!s) return null;
  try { const r = await s.get(k, { type: 'json' }); if (r && r.e > Date.now()) { mem.set(k, r); return r.v; } } catch (e) {}
  return null;
}
async function cput(k, v, ttl) {
  const r = { e: Date.now() + ttl * 1000, v: v }; mem.set(k, r);
  if (ttl <= 120) return;
  const s = cs(); if (s) { try { await s.setJSON(k, r); } catch (e) {} }
}
async function pget(k, dflt) { const s = ps(); if (!s) return dflt; try { const v = await s.get(k, { type: 'json' }); return v == null ? dflt : v; } catch (e) { return dflt; } }
async function pput(k, v) { const s = ps(); if (!s) throw new Error('저장소 사용 불가'); await s.setJSON(k, v); }

/* ---------- 외부 데이터 ---------- */
async function jget(url, tries, headers) {
  for (let i = 0; i < (tries || 2); i++) {
    try {
      const r = await fetch(url, { headers: Object.assign({ 'User-Agent': UA, Accept: 'application/json, text/plain, */*' }, headers || {}) });
      if (r.ok) return await r.json();
    } catch (e) {}
    await sleep(300);
  }
  return null;
}
async function yc(sym, range, interval) {
  for (const h of ['query1', 'query2']) {
    const j = await jget('https://' + h + '.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(sym) + '?range=' + range + '&interval=' + interval, 1);
    const r = j && j.chart && j.chart.result && j.chart.result[0];
    if (r && r.timestamp) return r;
  }
  return null;
}

/* ===================== VIX 차트 (공두일보 상단 카드용) ===================== */
const VIX_SRC = { h: ['3mo', '60m', 30], d: ['1y', '1d', 300], w: ['10y', '1wk', 300], m: ['20y', '1mo', 300] };
async function gongdu_vix() {
  const out = { at: nowKst(), VIX: {}, live: {} };
  await Promise.all(Object.keys(VIX_SRC).map(async (s) => {
    const c = VIX_SRC[s], ck = 'vix_' + s;
    let d = await cget(ck, c[2]);
    if (!d) {
      const r = await yc('^VIX', c[0], c[1]);
      if (r) {
        const q = r.indicators.quote[0].close;
        d = { p: r.timestamp.map((t, i) => [t, q[i]]).filter((x) => typeof x[1] === 'number').map((x) => [x[0], r2(x[1])]), live: (r.meta && r.meta.regularMarketPrice) || null };
        await cput(ck, d, c[2]);
      }
    }
    out.VIX[s] = d ? d.p : [];
    if (s === 'h' && d && d.live) out.live.VIX = d.live;
  }));
  return out;
}

/* ===================== Trading 탭 (모의거래) ===================== */
const TX_START = 10000000;
const TX_SYMS = [
  { id: 'QQQM', name: 'QQQM', code: 'QQQM', dec: 2 },
  { id: 'NVDA', name: 'NVDA (엔비디아)', code: 'NVDA', dec: 2 },
  { id: 'TQQQ', name: 'TQQQ', code: 'TQQQ', dec: 2 }
];
const txSym = (id) => TX_SYMS.filter((s) => s.id === id)[0];
async function tx_candles(id, tf) {
  const s = txSym(id); if (!s) return [];
  const p = { '15m': ['15m', '5d'], '1h': ['1h', '1mo'], '1d': ['1d', '2y'], '1w': ['1wk', '10y'] }[tf]; if (!p) return [];
  const key = 'txc_' + id + '_' + tf, hit = await cget(key, 60); if (hit) return hit;
  const r = await yc(s.code, p[1], p[0]); if (!r) throw new Error('시세 조회 실패');
  const q = r.indicators.quote[0], out = [];
  r.timestamp.forEach((t, i) => { if (q.close[i] == null || q.open[i] == null) return; out.push({ t: t * 1000, o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i] }); });
  await cput(key, out, 60); return out;
}
async function txPrice(s) { const r = await yc(s.code, '1d', '1m'); if (!r) throw new Error('현재가 조회 실패'); return +r.meta.regularMarketPrice; }
async function tx_quotes() {
  const hit = await cget('txq', 20); if (hit) return hit;
  const q = { t: Date.now() };
  await Promise.all(TX_SYMS.map(async (s) => { try { q[s.id] = await txPrice(s); } catch (e) { q[s.id] = null; } }));
  await cput('txq', q, 20); return q;
}
async function txLoad() { return await pget('tx_state', { realized: 0, pos: {}, hist: [] }); }
async function tx_state() { const st = await txLoad(); return { startUsd: TX_START, syms: TX_SYMS, realized: st.realized, pos: st.pos, hist: st.hist }; }
function txApply(st, s, q, price) {
  const p = st.pos[s.id];
  if (!p || !p.q) { st.pos[s.id] = { q: q, a: price, t: Date.now() }; return; }
  if ((p.q > 0) === (q > 0)) { const tot = Math.abs(p.q) + Math.abs(q); p.a = (p.a * Math.abs(p.q) + price * Math.abs(q)) / tot; p.q = Math.round((p.q + q) * 1e6) / 1e6; return; }
  const close = Math.min(Math.abs(q), Math.abs(p.q)), dir = p.q > 0 ? 1 : -1, pnl = (price - p.a) * close * dir;
  st.realized += pnl;
  st.hist.unshift([Date.now(), s.id, dir > 0 ? 'L' : 'S', Math.round(close * 1e6) / 1e6, p.a, price, Math.round(pnl * 100) / 100]);
  if (st.hist.length > 100) st.hist.length = 100;
  const rest = Math.round((p.q + q) * 1e6) / 1e6;
  if (Math.abs(rest) < 1e-9) delete st.pos[s.id];
  else if ((rest > 0) === (p.q > 0)) p.q = rest;
  else st.pos[s.id] = { q: rest, a: price, t: Date.now() };
}
async function tx_order(id, side, price, qty) {
  const s = txSym(id); if (!s) throw new Error('종목 없음');
  qty = Number(qty); if (!(qty > 0)) throw new Error('수량을 확인하세요');
  if (side !== 'buy' && side !== 'sell') throw new Error('주문 구분 오류');
  const px = (price === null || price === undefined || price === '') ? await txPrice(s) : Number(price);
  if (!(px > 0)) throw new Error('가격을 확인하세요');
  const st = await txLoad();
  txApply(st, s, Math.round(qty * 1e6) / 1e6 * (side === 'buy' ? 1 : -1), px);
  await pput('tx_state', st);
  return await tx_state();
}
async function tx_reset() { await pput('tx_state', { realized: 0, pos: {}, hist: [] }); return await tx_state(); }

/* ===================== Fear / BTC (Trading 탭 상단 차트) ===================== */
const FAG_SRC = { h: ['1mo', '60m', 60], d: ['3y', '1d', 300], w: ['10y', '1wk', 300], m: ['max', '1mo', 300] };
const FAG_LIVE = { '1m': ['1d', '1m', 15], '5m': ['1d', '5m', 30], '15m': ['5d', '15m', 60] };
const FAG_Q = { '1m': ['5d', '1m', 20], '5m': ['5d', '5m', 30], '15m': ['1mo', '15m', 60], '1h': ['3mo', '60m', 60], '1d': ['5y', '1d', 300], '1w': ['10y', '1wk', 300] };
function fagBars(r) {
  const q = r.indicators.quote[0], out = [];
  r.timestamp.forEach((t, i) => {
    const o = q.open[i], h = q.high[i], l = q.low[i], c = q.close[i]; if (typeof c !== 'number') return;
    out.push([t, Math.round(typeof o === 'number' ? o : c), Math.round(typeof h === 'number' ? h : c), Math.round(typeof l === 'number' ? l : c), Math.round(c)]);
  });
  return out;
}
async function fagNow() {
  const now = Math.floor(Date.now() / 1000);
  const j = await jget('https://api.coinmarketcap.com/data-api/v3/fear-greed/chart?start=' + (now - 3 * 86400) + '&end=' + now, 2);
  const list = j && j.data && j.data.dataList; if (!list || !list.length) return null;
  const d = list.reduce((a, b) => (Number(b.timestamp) > Number(a.timestamp) ? b : a));
  const p = Number(d.btcPrice), s = Number(d.score); if (isNaN(s)) return null;
  return [Number(d.timestamp), s, isNaN(p) ? null : Math.round(p)];
}
async function fagRecord() {
  const n = await fagNow(); if (!n) return 'no data';
  const rec = await pget('fag_rec', []);
  if (rec.length && rec[rec.length - 1][0] >= n[0]) return 'same';
  rec.push(n); if (rec.length > 9000) rec.splice(0, 500);
  await pput('fag_rec', rec); return 'added';
}
async function mvrv() {
  const hit = await cget('mvrv_v2', 7200); if (hit) return hit;
  try {
    const j = await jget('https://community-api.coinmetrics.io/v4/timeseries/asset-metrics?assets=btc&metrics=CapMrktCurUSD,CapMVRVCur&frequency=1d&page_size=900&paging_from=end', 2);
    const rows = ((j && j.data) || []).map((x) => ({ t: Date.parse(x.time), mc: Number(x.CapMrktCurUSD), mv: Number(x.CapMVRVCur) })).filter((x) => x.mc > 0 && x.mv > 0);
    if (rows.length > 800) {
      const wk = {}; rows.forEach((x) => { wk[Math.floor((x.t / 86400000 + 3) / 7)] = x; });
      const w = Object.keys(wk).map(Number).sort((a, b) => a - b).slice(-104).map((k) => wk[k].mc);
      const mean = w.reduce((a, b) => a + b, 0) / w.length, sd = Math.sqrt(w.reduce((a, b) => a + (b - mean) * (b - mean), 0) / w.length);
      const last = rows[rows.length - 1], rc = last.mc / last.mv, z = (last.mc - rc) / sd, s = Math.max(-2, Math.min(2, -2 + ((z + 0.23) / (6.85 + 0.23)) * 4));
      const out = { m: last.mv, z: z, s: s };
      if (!isNaN(out.m) && !isNaN(z)) { await cput('mvrv_v2', out, 7200); await cput('mvrv_last2', out, 21600); return out; }
    }
  } catch (e) {}
  return await cget('mvrv_last2', 21600);
}
async function fag_getData() {
  const out = { at: nowKst(), F: [], B: {}, live: null };
  let f = await cget('fag_idx3', 300), nowRaw = await cget('fag_now', 300);
  if (!f) {
    const j = await jget('https://api.coinmarketcap.com/data-api/v3/fear-greed/chart?start=1687900000&end=' + Math.floor(Date.now() / 1000), 2);
    const list = j && j.data && j.data.dataList;
    if (list && list.length) {
      f = list.map((d) => { const p = Number(d.btcPrice); return [Number(d.timestamp), Number(d.score), isNaN(p) ? null : Math.round(p)]; }).filter((x) => x[0] > 0 && !isNaN(x[1])).sort((a, b) => a[0] - b[0]);
      const last = f[f.length - 1]; nowRaw = last.slice(); last[0] = Math.floor(last[0] / 86400) * 86400;
      if (f.length > 1 && f[f.length - 2][0] >= last[0]) f.splice(f.length - 2, 1);
      await cput('fag_idx3', f, 300); await cput('fag_now', nowRaw, 300);
    }
  }
  out.F = f || [];
  const [M, rec] = await Promise.all([mvrv(), pget('fag_rec', [])]);
  out.M = M; out.I = rec.slice(-700);
  if (nowRaw && (!out.I.length || out.I[out.I.length - 1][0] < nowRaw[0])) out.I.push(nowRaw);
  await Promise.all(Object.keys(FAG_SRC).map(async (s) => {
    const cfg = FAG_SRC[s], ck = 'fag_ohlc_' + s;
    let d = await cget(ck, cfg[2]);
    if (!d) { const r = await yc('BTC-USD', cfg[0], cfg[1]); if (r) { d = { p: fagBars(r), live: (r.meta && r.meta.regularMarketPrice) || null }; await cput(ck, d, cfg[2]); } }
    out.B[s] = d ? d.p : [];
    if (s === 'h' && d && d.live) out.live = d.live;
  }));
  return out;
}
async function fag_getLive(tf) {
  const cfg = FAG_LIVE[tf]; if (!cfg) return null;
  const ck = 'fag_live2_' + tf; let d = await cget(ck, cfg[2]);
  if (!d) { const r = await yc('BTC-USD', cfg[0], cfg[1]); if (!r) return null; d = { tf: tf, p: fagBars(r).slice(-220), live: (r.meta && r.meta.regularMarketPrice) || null }; await cput(ck, d, cfg[2]); }
  return d;
}
async function qBars(sym, tf, tag) {
  const cfg = FAG_Q[tf]; if (!cfg) return null;
  const ck = tag + sym + '_' + tf; let d = await cget(ck, cfg[2]);
  if (!d) {
    const [r, v] = await Promise.all([yc(sym, cfg[0], cfg[1]), yc('^VIX', cfg[0], cfg[1])]);
    if (!r) return null;
    const vm = {};
    if (v) { const vc = v.indicators.quote[0].close; v.timestamp.forEach((t, i) => { if (typeof vc[i] === 'number') vm[t] = vc[i]; }); }
    const vts = Object.keys(vm).map(Number).sort((a, b) => a - b), q = r.indicators.quote[0], p = [];
    let j = -1;
    r.timestamp.forEach((t, i) => {
      const c = q.close[i]; if (typeof c !== 'number') return;
      const o = typeof q.open[i] === 'number' ? q.open[i] : c, hi = typeof q.high[i] === 'number' ? q.high[i] : c, lo = typeof q.low[i] === 'number' ? q.low[i] : c;
      while (j + 1 < vts.length && vts[j + 1] <= t) j++;
      const vx = (j >= 0 && t - vts[j] <= 3 * 86400) ? vm[vts[j]] : null;
      p.push([t, r2(o), r2(hi), r2(lo), r2(c), vx == null ? null : r2(vx)]);
    });
    d = { p: p.slice(tf === '1d' ? -1400 : -600), live: (r.meta && r.meta.regularMarketPrice) || null };
    await cput(ck, d, cfg[2]);
  }
  return { tf: tf, sym: sym, p: d.p, live: d.live };
}
async function fag_getQ(tf) { const d = await qBars('QQQM', tf, 'fq1_'); if (d) delete d.sym; return d; }
async function sim_getQ(sym, tf) { if (['QQQ', 'QLD', 'TQQQ', 'SGOV'].indexOf(sym) < 0) return null; return await qBars(sym, tf, 'sq2_'); }

/* ===================== Tripod 시뮬레이션 ===================== */
const SIM_YEARS = 10;
const TRI = { usd: 100000, sma: 250, up: 0.01, dn: -0.05, vw: 10, vUp: 28, vDn: 25, dw: 252, dd: -0.09, tc: 0.0003 };
const TRI_G = { T: 3, L: 2, Q: 1, C: 0 };
const TRI_NAME = { T: 'TQQQ 100% (3배)', L: 'QLD 100% (2배)', Q: 'QQQ 100% (1배)', C: '현금 100% (SGOV)' };
const SLM = { CQ: 'buy1단계', QT: 'buy 확정', TQ: '공포', QC: '과매도', CT: 'buy 확정', TC: '과매도' };
const SL = (f, t) => SLM[f + t] || (f + '→' + t);
const NYD = (t) => ymdTz(new Date(t * 1000), 'America/New_York');

function simParse(j) {
  const d = j.chart.result[0], q = d.indicators.quote[0];
  const ac = (d.indicators.adjclose && d.indicators.adjclose[0] && d.indicators.adjclose[0].adjclose) || q.close;
  const rows = [], idx = {};
  d.timestamp.forEach((t, i) => {
    if (typeof q.close[i] !== 'number') return;
    const k = NYD(t), r = { k: k, c: q.close[i], a: typeof ac[i] === 'number' ? ac[i] : q.close[i] };
    if (idx[k] != null) rows[idx[k]] = r; else { idx[k] = rows.length; rows.push(r); }
  });
  return { rows: rows, by: idx };
}
async function simFetchAll() {
  const p2 = Math.floor(Date.now() / 1000), p1 = p2 - Math.floor((SIM_YEARS + 1.6) * 365.25 * 86400);
  const syms = ['QQQ', '^VIX', '^NDX', 'QLD', 'TQQQ', 'SGOV', '^IRX'], out = {};
  await Promise.all(syms.map(async (s) => {
    let j = null;
    for (const h of ['query1', 'query2']) {
      j = await jget('https://' + h + '.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(s) + '?interval=1d&period1=' + p1 + '&period2=' + p2 + '&events=div%7Csplit', 1);
      if (j && j.chart && j.chart.result) break;
    }
    if (!j || !j.chart || !j.chart.result) throw new Error(s + ' 시세 조회 실패');
    out[s] = simParse(j);
  }));
  return out;
}
function align(cal, P) {
  const c = [], a = []; let lc = null, la = null;
  cal.forEach((k) => { const j = P.by[k]; if (j != null) { lc = P.rows[j].c; la = P.rows[j].a; } c.push(lc); a.push(la); });
  return { c: c, a: a };
}
function sma(arr, len) {
  const out = [];
  for (let i = 0; i < arr.length; i++) {
    if (i < len - 1) { out.push(null); continue; }
    let s = 0, ok = true;
    for (let j = i - len + 1; j <= i; j++) { if (arr[j] == null) { ok = false; break; } s += arr[j]; }
    out.push(ok ? s / len : null);
  }
  return out;
}
function mdd(v) { let pk = -1, m = 0; v.forEach((x) => { if (x > pk) pk = x; const dd = x / pk - 1; if (dd < m) m = dd; }); return m * 100; }
function stats(cal, S, v) {
  const days = edays(cal[cal.length - 1]) - edays(cal[S]), fin = v[v.length - 1];
  return { final: Math.round(fin), tot: (fin / v[0] - 1) * 100, cagr: (Math.pow(fin / v[0], 365.25 / days) - 1) * 100, mdd: mdd(v) };
}
function yearly(cal, S, arrs) {
  const keys = cal.slice(S), rows = [], lastIdx = {};
  keys.forEach((k, i) => { lastIdx[k.slice(0, 4)] = i; });
  const years = Object.keys(lastIdx).sort();
  years.forEach((y, yi) => {
    const e = lastIdx[y], s = yi === 0 ? 0 : lastIdx[years[yi - 1]];
    rows.push({ y: y, v: arrs.map((a) => (a[e] / a[s] - 1) * 100), p: yi === 0 ? 'start' : (yi === years.length - 1 ? 'ytd' : '') });
  });
  return rows;
}
function shade3(hold) {
  const out = [], mp = { T: 'BUY', L: 'MID', Q: 'LOW', C: 'SELL' }; let a = 0;
  for (let i = 1; i <= hold.length; i++) if (i === hold.length || hold[i] !== hold[a]) { out.push({ a: a, b: i - 1, s: mp[hold[a]] }); a = i; }
  return out;
}
function simTripod(x) {
  const R = x.R, cal = x.cal, n = x.n, usd = TRI.usd;
  const NX = align(cal, R['^NDX']).c, QAl = align(cal, R.QQQ), QA = QAl.a, QCc = QAl.c, QL = align(cal, R.QLD).a, TQ = align(cal, R.TQQQ).a;
  const NS = sma(NX, TRI.sma), VM = sma(x.vf, TRI.vw), st = new Array(n).fill(null);
  let reg = null;
  for (let i = 0; i < n; i++) {
    if (i < TRI.dw - 1 || NS[i] == null || VM[i] == null || NX[i] == null) continue;
    let hi = 0, bad = false;
    for (let j = i - TRI.dw + 1; j <= i; j++) { if (NX[j] == null) { bad = true; break; } if (NX[j] > hi) hi = NX[j]; }
    if (bad) continue;
    const gap = NX[i] / NS[i] - 1, dd = NX[i] / hi - 1;
    if (gap > TRI.up) reg = 'U'; else if (gap < TRI.dn) reg = 'D';
    if (reg == null) continue;
    st[i] = reg === 'U' ? ((VM[i] < TRI.vUp && dd >= TRI.dd) ? 'T' : 'Q') : (VM[i] < TRI.vDn ? 'Q' : 'C');
  }
  let S = -1;
  for (let i = 2; i < n; i++) if (cal[i] >= x.D0 && st[i - 1] != null && TQ[i] != null && QL[i] != null && QA[i] != null && TQ[i - 1] != null && QL[i - 1] != null) { S = i; break; }
  if (S < 0) throw new Error('Tripod 시작일을 찾지 못함');
  const ret = (k, c) => (c === 'T' ? TQ[k] / TQ[k - 1] - 1 : c === 'L' ? QL[k] / QL[k - 1] - 1 : c === 'Q' ? QA[k] / QA[k - 1] - 1 : x.tbill(k));
  let V = usd, held = st[S - 1];
  const eq = [V], hold = [held], bq = [usd];
  for (let k = S + 1; k < n; k++) {
    const w = st[k - 2];
    if (w != null && w !== held) { V *= 1 - TRI.tc; held = w; }
    V *= 1 + ret(k, held); eq.push(V); hold.push(held); bq.push(usd * QA[k] / QA[S]);
  }
  const marks = [];
  for (let k = S; k < n - 1; k++) {
    if (st[k] == null || st[k - 1] == null || st[k] === st[k - 1]) continue;
    const e = k + 1; let hi52 = 0;
    for (let j = Math.max(0, e - 251); j <= e; j++) if (QCc[j] != null && QCc[j] > hi52) hi52 = QCc[j];
    marks.push({ k: k + 1 - S, s: TRI_G[st[k]] > TRI_G[st[k - 1]] ? 'BUY' : 'SELL', f: st[k - 1], t: st[k], d: cal[e], p: QCc[e] == null ? null : r2(QCc[e]), dd: (hi52 && QCc[e] != null) ? QCc[e] / hi52 - 1 : null, vx: x.vf[e] != null ? r2(x.vf[e]) : null });
  }
  const r0 = Math.round, fin = V, days = edays(cal[n - 1]) - edays(cal[S]), qs = stats(cal, S, bq);
  const o = { kind: 'T', mode: 'tab', at: nowKst().slice(0, 11), start: cal[S], end: cal[n - 1], T: cal.slice(S).map(edays) };
  o.panes = [{ title: 'Tripod 전략 (시작 $100,000 · 나스닥100 250일선 + VIX 10일평균 + 52주 낙폭)', fmt: '$', log: 1, lines: [{ n: 'Tripod 전략 평가금액', c: '#212633', w: 2.4, v: eq.map(r0), m: 1 }] }];
  o.marks = marks; o.shade = shade3(hold); o.bq = bq.map(r0);
  o.sum = [
    { n: 'Tripod 전략', c: '#212633', final: r0(fin), inv: usd, pnl: r0(fin - usd), tot: (fin / usd - 1) * 100, cagr: (Math.pow(fin / usd, 365.25 / days) - 1) * 100, mdd: mdd(eq), trades: marks.length },
    { n: 'QQQ $100,000 보유', c: '#d9822b', final: qs.final, inv: usd, pnl: qs.final - usd, tot: qs.tot, cagr: qs.cagr, mdd: qs.mdd }
  ];
  o.cols = ['Tripod', 'QQQ 보유'];
  o.rows = yearly(cal, S, [eq, bq]);
  let j = n - 2;
  while (j > S && st[j - 1] === held) j--;
  const f = (j > S || st[S - 1] !== held) ? j + 1 : S, lc = n - 1, P = (arr, k) => Math.round(arr[k] * 100) / 100, ing = [];
  if (held === 'T') ing.push({ t: 'TQQQ', p: P(TQ, f), d: cal[f], cur: P(TQ, lc) });
  else if (held === 'L') ing.push({ t: 'QLD', p: P(QL, f), d: cal[f], cur: P(QL, lc) });
  else if (held === 'Q') ing.push({ t: 'QQQ', p: P(QA, f), d: cal[f], cur: P(QA, lc) });
  else { const sg = x.SG.a; if (sg[f] != null && sg[lc] != null) ing.push({ t: '현금 (SGOV)', p: P(sg, f), d: cal[f], cur: P(sg, lc) }); else ing.push({ t: '현금 100%', p: 1, d: cal[f], cur: 1 }); }
  o.ing = ing;
  o.now = { code: held, name: TRI_NAME[held], since: cal[f], lastSig: marks.length ? marks[marks.length - 1].s : null, pend: (st[n - 1] != null && st[n - 1] !== held) ? TRI_NAME[st[n - 1]] : null };
  return o;
}
async function simBuild() {
  const R = await simFetchAll(), cal = R.QQQ.rows.map((r) => r.k), n = cal.length;
  const vk = R['^VIX'].rows, vf = []; let vj = -1, lv = null;
  cal.forEach((k) => { while (vj + 1 < vk.length && vk[vj + 1].k <= k) vj++; if (vj >= 0 && (edays(k) - edays(vk[vj].k)) <= 3) lv = vk[vj].c; vf.push(lv); });
  const SG = align(cal, R.SGOV), IR = align(cal, R['^IRX']);
  const d0 = new Date(); d0.setFullYear(d0.getFullYear() - SIM_YEARS);
  const tbill = (k) => ((SG.a[k] != null && SG.a[k - 1] != null) ? SG.a[k] / SG.a[k - 1] - 1 : ((IR.c[k - 1] != null ? IR.c[k - 1] : 4) / 100 / 252));
  return simTripod({ R: R, cal: cal, n: n, D0: ymdTz(d0, 'America/New_York'), vf: vf, tbill: tbill, SG: SG });
}
async function simGet() {
  let d = await cget('simT', 21600);
  if (!d) { d = await simBuild(); await cput('simT', d, 21600); }
  return d;
}
async function sim_get(kind) { if (kind !== 'T') return null; return await simGet(); }
async function sim_marks() {
  const d = await simGet(); if (!d || !d.marks) return null;
  return { m: d.marks.map((x) => [d.T[x.k] * 86400, SL(x.f, x.t)]), now: d.now ? { name: d.now.name, since: d.now.since } : null };
}
async function tripodBlock() {
  try {
    const d = await simGet(), mk = (d && d.marks) || [], last = mk[mk.length - 1];
    return {
      now: last ? { label: SL(last.f, last.t), since: last.d, s: last.s } : null,
      hold: d && d.now ? d.now.name : null,
      trades: mk.slice(-3).reverse().map((m) => ({ d: m.d, label: SL(m.f, m.t), s: m.s, p: m.p, dd: m.dd, vx: m.vx }))
    };
  } catch (e) { return null; }
}

/* ===================== 공두일보 ===================== */
const GD_NEWS_Q = '뉴욕증시 OR 나스닥 OR S&P500 OR 다우지수 OR 연준 OR 미국 국채금리';
const f_ = (v, d) => (v === null || v === undefined || isNaN(v)) ? '-' : Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const p_ = (v) => (v === null || v === undefined || isNaN(v)) ? '-' : (v >= 0 ? '+' : '') + (v * 100).toFixed(2) + '%';
const bp_ = (v) => (v === null || v === undefined || isNaN(v)) ? '-' : (v >= 0 ? '+' : '') + v.toFixed(1) + 'bp';
async function gdSeries(sym) {
  try {
    const r = await yc(sym, '1y', '1d'); if (!r) return null;
    const c = (r.indicators.quote[0].close || []).filter((x) => typeof x === 'number'); if (c.length < 2) return null;
    const last = c[c.length - 1], prev = c[c.length - 2];
    return { closes: c, last: last, prev: prev, chg: last / prev - 1, hi52: Math.max.apply(null, c) };
  } catch (e) { return null; }
}
const ma_ = (c, n) => (!c || c.length < n) ? null : c.slice(-n).reduce((a, b) => a + b, 0) / n;
async function gdFear() {
  try {
    const j = await jget('https://production.dataviz.cnn.io/index/fearandgreed/graphdata', 2, { Referer: 'https://edition.cnn.com/markets/fear-and-greed', Origin: 'https://edition.cnn.com' });
    if (!j || !j.fear_and_greed) return null;
    const kr = { 'extreme fear': '극단적 공포', fear: '공포', neutral: '중립', greed: '탐욕', 'extreme greed': '극단적 탐욕' };
    return { score: Math.round(j.fear_and_greed.score), rating: kr[String(j.fear_and_greed.rating).toLowerCase()] || j.fear_and_greed.rating };
  } catch (e) { return null; }
}
function dec(s) { return String(s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').trim(); }
async function googleNews(q) {
  const r = await fetch('https://news.google.com/rss/search?q=' + encodeURIComponent(q + ' when:1d') + '&hl=ko&gl=KR&ceid=KR:ko', { headers: { 'User-Agent': UA } });
  if (!r.ok) return [];
  const x = await r.text();
  return [...x.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => {
    const it = m[1], g = (tag) => { const mm = it.match(new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)</' + tag + '>')); return mm ? dec(mm[1]) : ''; };
    const src = g('source'); let title = g('title');
    if (src && title.endsWith(' - ' + src)) title = title.slice(0, -(src.length + 3));
    return { title: title, link: g('link'), source: src, time: Date.parse(g('pubDate')) || 0 };
  }).sort((a, b) => b.time - a.time);
}
async function gdNews() {
  for (let t = 0; t < 3; t++) {
    try {
      const seen = {};
      const news = (await googleNews(GD_NEWS_Q)).filter((n) => { const k = n.title.replace(/\s+/g, '').slice(0, 24); if (seen[k]) return false; seen[k] = 1; return true; })
        .slice(0, 10).map((n) => ({ t: n.title, l: n.link, s: n.source, tm: n.time ? mdHm(new Date(n.time)) : '' }));
      if (news.length) return news;
    } catch (e) {}
    await sleep(1200);
  }
  return [];
}
const GD_KR = [[/FOMC Meeting Minutes/i, 'FOMC 의사록'], [/FOMC|Federal Funds Rate/i, 'FOMC 금리 결정'], [/Fed Chair|Powell/i, '연준 의장 발언'], [/Core CPI/i, '근원 CPI(소비자물가)'], [/CPI/i, 'CPI(소비자물가)'], [/Core PPI/i, '근원 PPI(생산자물가)'], [/PPI/i, 'PPI(생산자물가)'], [/Core PCE/i, '근원 PCE 물가'], [/Non-Farm|NFP/i, '비농업 고용'], [/Unemployment Rate/i, '실업률'], [/Unemployment Claims/i, '신규 실업수당 청구'], [/Retail Sales/i, '소매판매'], [/GDP/i, 'GDP 성장률'], [/ISM Manufacturing/i, 'ISM 제조업 지수'], [/ISM Services/i, 'ISM 서비스업 지수'], [/JOLTS/i, 'JOLTS 구인'], [/Consumer Sentiment/i, '소비자심리(미시간대)']];
async function gdSched() {
  const urls = ['https://nfs.faireconomy.media/ff_calendar_thisweek.json', 'https://nfs.faireconomy.media/ff_calendar_nextweek.json'], now = Date.now();
  let all = [];
  for (const u of urls) {
    for (let t = 0; t < 3; t++) {
      try { const r = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0' } }); if (r.ok) { all = all.concat(await r.json()); break; } if (r.status === 404) break; } catch (e) {}
      await sleep(1200);
    }
  }
  const seen = {};
  return all.filter((e) => e.country === 'USD' && e.impact === 'High' && Date.parse(e.date) >= now - 3600000)
    .filter((e) => { const k = e.date + e.title; if (seen[k]) return false; seen[k] = 1; return true; })
    .sort((a, b) => Date.parse(a.date) - Date.parse(b.date)).slice(0, 8)
    .map((e) => {
      const m = GD_KR.find((x) => x[0].test(e.title)), d = new Date(e.date), p = tp(d, TZ, DT);
      return { when: (+p.month) + '/' + (+p.day) + '(' + KO[dowKst(d)] + ') ' + p.hour + ':' + p.minute, t: m ? m[1] + ' (' + e.title + ')' : e.title, f: e.forecast || '', p: e.previous || '' };
    });
}
const gdStage = (dd) => dd === null ? '-' : dd > -0.05 ? '정상 범위(-5% 이내)' : dd > -0.10 ? '1단계 조정(-5~-10%)' : dd > -0.20 ? '2단계 조정(-10~-20%)' : '약세장(-20% 이하)';
const gdFx = (v) => v >= 1450 ? '1,450원 이상 고환율 경계' : v >= 1400 ? '1,400원대 — 달러 자산 매수 부담' : v >= 1350 ? '1,350~1,400원 박스권' : '1,350원 아래 — 환율 안정';
function gdMood(q, vix) {
  if (!q) return '시세 확인 필요';
  const base = q.chg >= 0.01 ? '기술주 강세' : q.chg <= -0.01 ? '기술주 약세' : '보합권 혼조';
  return base + (vix ? (vix.last >= 30 ? ', 공포 확대' : vix.last >= 20 ? ', 변동성 경계' : ', 변동성 안정') : '');
}
async function gongduBuild() {
  const now = new Date(), ymd = ymdTz(now, TZ), dow = dowKst(now), weekend = dow >= 6;
  const [q, sp, tnx, fx, vix, rsp, spy, fg, news, sched] = await Promise.all([gdSeries('QQQM'), gdSeries('^GSPC'), gdSeries('^TNX'), gdSeries('KRW=X'), gdSeries('^VIX'), gdSeries('RSP'), gdSeries('SPY'), gdFear(), gdNews(), gdSched()]);
  const tnxNow = tnx ? (tnx.last > 20 ? tnx.last / 10 : tnx.last) : null, tnxPrev = tnx ? (tnx.prev > 20 ? tnx.prev / 10 : tnx.prev) : null;
  const ma200 = q ? ma_(q.closes, 200) : null, ma50 = q ? ma_(q.closes, 50) : null, ddQ = q ? q.last / q.hi52 - 1 : null, low20 = q ? Math.min.apply(null, q.closes.slice(-20)) : null;
  const sr = { sup: null, res: null, note: '-' };
  if (q) {
    const hi20 = Math.max.apply(null, q.closes.slice(-20));
    const lv = [['50일선', ma50], ['200일선', ma200], ['20일 저점', low20], ['20일 고점', hi20], ['52주 고점', q.hi52]].filter((x) => typeof x[1] === 'number');
    const below = lv.filter((x) => x[1] < q.last).sort((a, b) => b[1] - a[1])[0], above = lv.filter((x) => x[1] > q.last).sort((a, b) => a[1] - b[1])[0];
    sr.sup = below ? below[1] : null; sr.res = above ? above[1] : null; sr.note = (below ? below[0] : '-') + ' / ' + (above ? above[0] : '-');
  }
  let breadth = null;
  if (rsp && spy && rsp.closes.length > 21 && spy.closes.length > 21) breadth = (rsp.last / rsp.closes[rsp.closes.length - 21] - 1) - (spy.last / spy.closes[spy.closes.length - 21] - 1);
  let score = 0;
  const notes = [];
  if (q && ma200) { if (q.last >= ma200) { score++; notes.push('QQQM이 200일선 위(상승 추세)'); } else { score--; notes.push('QQQM이 200일선 아래(하락 추세)'); } }
  if (ddQ !== null && ddQ <= -0.10) { score++; notes.push('고점 대비 10% 이상 조정으로 가격 매력'); }
  if (vix) { if (vix.last >= 30) { score++; notes.push('VIX 30 이상 극단적 공포(역발상 매수 구간)'); } else if (vix.last <= 13) { score--; notes.push('VIX 13 이하로 시장 안일'); } }
  if (fg) { if (fg.score <= 25) { score++; notes.push('공포탐욕지수 극단적 공포'); } else if (fg.score >= 75) { score--; notes.push('공포탐욕지수 극단적 탐욕(과열)'); } }
  if (tnxNow !== null && tnxNow >= 4.75) { score--; notes.push('10년물 금리 4.75% 이상으로 성장주 부담'); }
  const op = score >= 2 ? 'BUY' : score <= -2 ? 'SELL' : 'HOLD';
  const idx = [
    q && { k: 'QQQM', v: '$' + f_(q.last, 2), chg: q.chg, sub: '52주 고점 $' + f_(q.hi52, 2) + ' 대비 ' + p_(ddQ) },
    sp && { k: 'S&P500', v: f_(sp.last, 2), chg: sp.chg, sub: '고점 대비 ' + p_(sp.last / sp.hi52 - 1) },
    vix && { k: 'VIX', v: f_(vix.last, 2), chg: vix.chg, sub: vix.last >= 30 ? '공포 구간(30 이상)' : vix.last >= 20 ? '경계 구간(20 이상)' : '안정 구간(20 미만)' },
    tnx && { k: '美 10년물 금리', v: f_(tnxNow, 3) + '%', chgBp: (tnxNow - tnxPrev) * 100, sub: '조정 단계(QQQM): ' + gdStage(ddQ) },
    fx && { k: '원/달러', v: f_(fx.last, 1) + '원', chg: fx.chg, sub: gdFx(fx.last) }
  ].filter(Boolean);
  const headline = (q ? 'QQQM $' + f_(q.last, 2) + ' (' + p_(q.chg) + ')' : 'QQQM -') + ' · S&P500 ' + (sp ? p_(sp.chg) : '-') + ' · VIX ' + (vix ? f_(vix.last, 2) : '-') + ' — ' + gdMood(q, vix);
  const lines = [];
  if (q && ma200) lines.push('QQQM ' + (q.last >= ma200 ? '200일선 위 유지' : '200일선 아래') + ' — 추세 분기점 **$' + f_(ma200, 2) + '** (현재 ' + p_(q.last / ma200 - 1) + ')');
  if (vix) lines.push('VIX ' + f_(vix.last, 2) + (fg ? ', 공포탐욕 ' + fg.score + '(' + fg.rating + ')' : '') + ' — 경계선 **VIX 20** / 공포 구간 **VIX 30**');
  if (tnx) lines.push('美 10년물 ' + f_(tnxNow, 3) + '%, 원/달러 ' + (fx ? f_(fx.last, 1) + '원' : '-') + ' — 금리 **4.5%** 넘으면 성장주 부담');
  const opinion = {
    table: [
      ['추세 (QQQM vs 200일선)', q && ma200 ? '$' + f_(q.last, 2) + ' / $' + f_(ma200, 2) + ' (' + p_(q.last / ma200 - 1) + ')' : '-', q && ma200 ? (q.last >= ma200 ? '상승' : '하락') : '-'],
      ['지지 / 저항', q ? '지지 $' + f_(sr.sup, 2) + ' · 저항 $' + f_(sr.res, 2) : '-', sr.note],
      ['Fear & Greed', fg ? fg.score + ' (' + fg.rating + ')' : '조회 실패', fg ? (fg.score <= 25 ? '매수 우위' : fg.score >= 75 ? '과열' : '중립') : '-'],
      ['VIX', vix ? f_(vix.last, 2) + ' (' + p_(vix.chg) + ')' : '-', vix ? (vix.last >= 30 ? '공포' : vix.last >= 20 ? '경계' : '안정') : '-'],
      ['시장 폭 (RSP−SPY, 1달)', breadth !== null ? p_(breadth) : '-', breadth !== null ? (breadth >= 0 ? '확산(양호)' : '대형주 쏠림') : '-'],
      ['금리 (美 10년물)', tnx ? f_(tnxNow, 3) + '% (' + bp_((tnxNow - tnxPrev) * 100) + ')' : '-', tnxNow !== null ? (tnxNow >= 4.5 ? '부담' : '중립') : '-'],
      ['기업 이익', '실적 시즌 뉴스 참고', '자동 수집 안 함']
    ],
    holder: op === 'SELL' ? '반등 시 비중 축소. QQQM이 200일선 $' + f_(ma200, 2) + '을 되찾기 전까지 추가 매수 보류.' : '200일선 $' + f_(ma200, 2) + ' 위에서는 보유 유지. 종가 기준 이탈 시 비중 축소 검토.',
    newBuy: op === 'BUY' ? '분할 매수 시작. 고점 대비 -10%($' + f_(q ? q.hi52 * 0.9 : null, 2) + ') 부근에서 추가.' : '고점 대비 -10%($' + f_(q ? q.hi52 * 0.9 : null, 2) + ') 또는 VIX 30 이상에서 분할 매수.',
    change: '매수 전환: 200일선 위 + VIX 30↑ 또는 공포탐욕 25↓. 매도 전환: 200일선 이탈 + 금리 4.75%↑ 또는 공포탐욕 75↑.',
    reason: notes.length ? notes.join(', ') + '.' : '판단 근거 데이터 부족.'
  };
  const b = {
    date: ymd, dateLabel: tp(now, TZ, DT).year + '년 ' + (+tp(now, TZ, DT).month) + '월 ' + (+tp(now, TZ, DT).day) + '일 (' + KO[dow] + ')', weekend: weekend, builtAt: mdHm(now),
    headline: headline, lines: lines, idx: idx, news: news, sched: sched, opinion: opinion,
    sources: 'Yahoo Finance(시세·금리·환율, 미국장 종가 기준) · CNN Fear & Greed · Google 뉴스 · Forex Factory(경제 일정)'
  };
  await pput('g/' + ymd, b);
  try {
    const l = await ps().list({ prefix: 'g/' }), cutoff = ymdTz(new Date(Date.now() - 30 * 864e5), TZ);
    for (const x of l.blobs) if (x.key.slice(2) < cutoff) await ps().delete(x.key);
  } catch (e) {}
  return b;
}
async function gongduExtras() {
  const ymd = ymdTz(new Date(), TZ), b = await pget('g/' + ymd, null);
  if (!b) return await gongduBuild();
  const [news, sched] = await Promise.all([gdNews(), gdSched()]);
  let ch = false;
  if (news.length) { b.news = news; ch = true; }
  if (sched.length) { b.sched = sched; ch = true; }
  if (ch) { b.extrasAt = mdHm(new Date()); await pput('g/' + ymd, b); }
  return b;
}
async function gongdu_getData(date) {
  const l = await ps().list({ prefix: 'g/' });
  let dates = l.blobs.map((x) => x.key.slice(2)).sort().reverse();
  const today = ymdTz(new Date(), TZ);
  if (!dates.length || (dates[0] < today && dowKst(new Date()) <= 5 && Number(tp(new Date(), TZ, DT).hour) >= 7)) { await gongduBuild(); dates = (await ps().list({ prefix: 'g/' })).blobs.map((x) => x.key.slice(2)).sort().reverse(); }
  const pick = dates.indexOf(date) >= 0 ? date : dates[0];
  let b = await pget('g/' + pick, null);
  if (b && pick === today && (!b.news || !b.news.length) && !mem.get('gd_heal')) { mem.set('gd_heal', { e: Date.now() + 3600000, v: 1 }); try { b = await gongduExtras(); } catch (e) {} }
  if (b) b.tripod = await tripodBlock();
  return { dates: dates, b: b };
}

/* ===================== 라우터 / 스케줄 작업 ===================== */
const FN = { gongdu_getData, gongdu_vix, sim_get, sim_getQ, sim_marks, fag_getData, fag_getLive, fag_getQ, tx_candles, tx_quotes, tx_state, tx_order, tx_reset };
const J = (o, s) => new Response(JSON.stringify(o), { status: s || 200, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
export default async (req) => {
  const fn = new URL(req.url).pathname.split('/').pop();
  let a = []; try { const b = await req.json(); a = b.a || []; } catch (e) {}
  if (!FN[fn]) return J({ ok: false, e: 'unknown ' + fn }, 404);
  try { return J({ ok: true, d: await FN[fn].apply(null, a) }); } catch (e) { return J({ ok: false, e: String((e && e.message) || e) }); }
};
export const jobs = {
  fagRecord: fagRecord,
  simRefresh: async () => { const d = await simBuild(); await cput('simT', d, 21600); return 'ok'; },
  gongduBuild: gongduBuild,
  gongduExtras: gongduExtras
};
