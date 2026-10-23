// 買進持有回測引擎（瀏覽器版）。邏輯與 twbt/backtest/buyhold.py 相同，結果已和 Python 對照驗證。
// 純計算、不碰畫面，方便在 Node 裡測試。

export const TRADING_DAYS = 252;
const DAY_MS = 86400000;

// ---------- 日期 ----------
export function ymdToDay(ymd) {            // 19900104 → 自 1970-01-01 起的天數
  const y = Math.floor(ymd / 10000), m = Math.floor(ymd / 100) % 100, d = ymd % 100;
  return Date.UTC(y, m - 1, d) / DAY_MS;
}
export function isoToDay(iso) {            // '2000-01-01' → 天數
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / DAY_MS;
}
export function dayToIso(day) {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}
export function addMonths(day, months) {   // 同 pandas DateOffset(months=)：月底會自動夾到該月最後一天
  const t = new Date(day * DAY_MS);
  const y = t.getUTCFullYear(), m = t.getUTCMonth() + months, d = t.getUTCDate();
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return Date.UTC(y, m, Math.min(d, last)) / DAY_MS;
}

// ---------- 資料 ----------
export function prepare(json) {
  const days = Int32Array.from(json.dates, ymdToDay);
  const assets = {};
  for (const [code, a] of Object.entries(json.assets)) {
    const dec = arr => Float64Array.from(arr, v => (v === null ? NaN : v / json.scale));
    assets[code] = {
      code, name: a.name, kind: a.kind, first: a.first, firstReal: a.first_real,
      ret: dec(a.ret), retConservative: a.ret_conservative ? dec(a.ret_conservative) : null,
    };
  }
  return { days, assets, updated: json.updated, calibration: json.calibration, params: json.params };
}

// 依設定取得某標的的每日報酬。useSynthetic=false 時，上市前（含上市當天）設為 NaN。
export function returnsFor(data, code, { useSynthetic = true, tw50Excess = true } = {}) {
  const a = data.assets[code];
  let r = (!tw50Excess && a.retConservative) ? a.retConservative : a.ret;
  if (!useSynthetic && a.firstReal !== null) {
    r = Float64Array.from(r);
    for (let i = 0; i <= a.firstReal; i++) r[i] = NaN;
  }
  return r;
}

// 每天是否為模擬資料（index 從 0 到 firstReal 都算模擬）
export function isSynthetic(data, code, i) {
  const a = data.assets[code];
  return a.firstReal !== null && i <= a.firstReal;
}

// ---------- 成本 ----------
export const TAX = { stock: 0.003, etf: 0.001, index: 0 };
export function makeCost({ commission = 0.001425, discount = 1, minFee = 20, tax = TAX } = {}) {
  const fee = (amt, kind) => (kind === 'index' || amt <= 0) ? 0 : Math.max(amt * commission * discount, minFee);
  return {
    buy: (amt, kind) => fee(amt, kind),
    sell: (amt, kind) => fee(amt, kind) + amt * (tax[kind] ?? 0),
  };
}

// ---------- 區間 ----------
function lowerBound(days, day) {           // 第一個 >= day 的位置
  let lo = 0, hi = days.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (days[mid] < day) lo = mid + 1; else hi = mid; }
  return lo;
}
export function bounds(days, startDay, endDay) {
  const si = lowerBound(days, startDay);
  const ei = lowerBound(days, endDay + 1) - 1;
  if (si >= days.length || ei < 0 || si >= ei) return null;
  return [si, ei];
}

// ---------- 指標 ----------
function mean(a) { let s = 0; for (const x of a) s += x; return s / a.length; }
function std(a) {                          // 樣本標準差（ddof=1），同 pandas
  if (a.length < 2) return NaN;
  const m = mean(a); let s = 0; for (const x of a) s += (x - m) ** 2;
  return Math.sqrt(s / (a.length - 1));
}

export function maxDrawdown(eq) {          // 回傳 {mdd, top, trough, recovery}（都是陣列位置）
  let peak = -Infinity, peakAt = 0, mdd = 0, trough = 0, top = 0;
  for (let i = 0; i < eq.length; i++) {
    if (eq[i] > peak) { peak = eq[i]; peakAt = i; }
    const dd = eq[i] / peak - 1;
    if (dd < mdd) { mdd = dd; trough = i; top = peakAt; }
  }
  let recovery = null;
  for (let i = trough; i < eq.length; i++) if (eq[i] >= eq[top]) { recovery = i; break; }
  return { mdd, top, trough, recovery };
}

export function summarize(eq, dayIdx, rf = 0) {
  // eq：每日淨值；dayIdx：對應的日期（天數）
  const n = eq.length;
  const years = (dayIdx[n - 1] - dayIdx[0]) / 365.25;
  const total = eq[n - 1] / eq[0] - 1;
  const cagr = years > 0 && total > -1 ? (1 + total) ** (1 / years) - 1 : NaN;
  const r = [];
  for (let i = 1; i < n; i++) r.push(eq[i] / eq[i - 1] - 1);
  const sd = std(r);
  const ex = r.map(x => x - rf / TRADING_DAYS);
  const down = r.filter(x => x < 0);
  const dd = maxDrawdown(eq);
  // 年度報酬：每年最後一天的淨值相比
  const yearEnd = [];
  for (let i = 0; i < n; i++) {
    const y = new Date(dayIdx[i] * DAY_MS).getUTCFullYear();
    if (i === n - 1 || new Date(dayIdx[i + 1] * DAY_MS).getUTCFullYear() !== y) yearEnd.push({ y, v: eq[i] });
  }
  const yearly = yearEnd.map((p, k) => p.v / (k === 0 ? eq[0] : yearEnd[k - 1].v) - 1);
  return {
    start: dayToIso(dayIdx[0]), end: dayToIso(dayIdx[n - 1]), years,
    total, cagr, vol: sd * Math.sqrt(TRADING_DAYS),
    sharpe: sd > 0 ? mean(ex) / sd * Math.sqrt(TRADING_DAYS) : NaN,
    sortino: down.length > 1 ? mean(ex) / std(down) * Math.sqrt(TRADING_DAYS) : NaN,
    mdd: dd.mdd, mddTop: dayToIso(dayIdx[dd.top]), mddTrough: dayToIso(dayIdx[dd.trough]),
    mddRecovery: dd.recovery !== null ? dayToIso(dayIdx[dd.recovery]) : null,
    calmar: dd.mdd < 0 ? cagr / Math.abs(dd.mdd) : NaN,
    bestYear: Math.max(...yearly), worstYear: Math.min(...yearly),
    yearly: yearEnd.map((p, k) => ({ year: p.y, ret: yearly[k] })),
    final: eq[n - 1],
  };
}

// ---------- 自訂區間 ----------
export function period(data, codes, startIso, endIso, opts) {
  const { capital = 1_000_000, cost = makeCost() } = opts;
  const b = bounds(data.days, isoToDay(startIso), isoToDay(endIso));
  if (!b) return { error: '這段區間沒有足夠的交易日' };
  const [si, ei] = b;
  const results = [], skipped = [];
  for (const code of codes) {
    const a = data.assets[code], r = returnsFor(data, code, opts);
    let bad = false;
    for (let i = si + 1; i <= ei; i++) if (Number.isNaN(r[i])) { bad = true; break; }
    if (bad) {
      const fr = opts.useSynthetic === false ? a.firstReal : a.first;
      skipped.push({ code, name: a.name, availableFrom: dayToIso(data.days[fr]) });
      continue;
    }
    const eq = new Float64Array(ei - si + 1);
    eq[0] = capital - cost.buy(capital, a.kind);
    for (let i = si + 1; i <= ei; i++) eq[i - si] = eq[i - si - 1] * (1 + r[i]);
    eq[eq.length - 1] -= cost.sell(eq[eq.length - 1], a.kind);
    const dayIdx = data.days.subarray(si, ei + 1);
    const st = summarize(eq, dayIdx, opts.rf ?? 0);
    let syn = 0;
    for (let i = si; i <= ei; i++) if (isSynthetic(data, code, i)) syn++;
    st.syntheticShare = syn / (ei - si + 1);
    // 模擬段結束的位置（畫圖時虛線）
    st.syntheticUntil = a.firstReal !== null && si <= a.firstReal ? Math.min(a.firstReal, ei) - si : -1;
    results.push({ code, name: a.name, stats: st, equity: eq, dayIdx });
  }
  return { results, skipped, start: dayToIso(data.days[si]), end: dayToIso(data.days[ei]) };
}

// ---------- 多區間 ----------
function windowStats(data, code, r, si, ei, opts) {
  const { capital = 1_000_000, cost = makeCost() } = opts;
  if (ei - si < 20) return null;
  for (let i = si + 1; i <= ei; i++) if (Number.isNaN(r[i])) return null;
  const kind = data.assets[code].kind;
  const inv = 1 - cost.buy(capital, kind) / capital;
  let v = inv, peak = inv, mdd = 0;
  const daily = [];
  for (let i = si + 1; i <= ei; i++) {
    v *= 1 + r[i]; daily.push(r[i]);
    if (v > peak) peak = v;
    const dd = v / peak - 1; if (dd < mdd) mdd = dd;
  }
  const final = v * capital;
  const net = (final - cost.sell(final, kind)) / capital;
  const years = (data.days[ei] - data.days[si]) / 365.25;
  let syn = 0;
  for (let i = si; i <= ei; i++) if (isSynthetic(data, code, i)) syn++;
  return {
    code, start: dayToIso(data.days[si]), end: dayToIso(data.days[ei]), years,
    total: net - 1, cagr: net > 0 ? net ** (1 / years) - 1 : -1,
    mdd, vol: std(daily) * Math.sqrt(TRADING_DAYS), syntheticShare: syn / (ei - si + 1),
  };
}

export function windows(data, codes, wins, opts) {
  const rets = Object.fromEntries(codes.map(c => [c, returnsFor(data, c, opts)]));
  const rows = [];
  for (const [s, e] of wins) {
    const b = bounds(data.days, s, e);
    if (!b) continue;
    for (const c of codes) {
      const st = windowStats(data, c, rets[c], b[0], b[1], opts);
      if (st) rows.push(st);
    }
  }
  return rows;
}

export function rolling(data, codes, years, opts) {
  const L = Math.round(years * 12);
  const first = data.days[0], last = data.days[data.days.length - 1];
  const t = new Date(first * DAY_MS);
  let s = Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), 1) / DAY_MS;
  const wins = [];
  while (addMonths(s, L) <= last) { wins.push([s, addMonths(s, L)]); s = addMonths(s, 1); }
  return windows(data, codes, wins, opts);
}

export function mulberry32(seed) {          // 可重現的亂數
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randomWindows(data, codes, n, yearsMin, yearsMax, seed, opts) {
  const rnd = mulberry32(seed);
  const first = data.days[0], last = data.days[data.days.length - 1];
  const wins = [];
  for (let k = 0; k < n; k++) {
    const L = Math.max(1, Math.round((yearsMin + rnd() * (yearsMax - yearsMin)) * 12));
    const latest = addMonths(last, -L);
    if (latest <= first) throw new Error(`資料期間不夠 ${yearsMax} 年`);
    const s = first + Math.floor(rnd() * (latest - first + 1));
    wins.push([s, addMonths(s, L)]);
  }
  return windows(data, codes, wins, opts);
}

// ---------- 分布摘要 ----------
export function quantile(sorted, p) {      // 線性內插，同 pandas
  if (!sorted.length) return NaN;
  const h = (sorted.length - 1) * p, lo = Math.floor(h), hi = Math.ceil(h);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (h - lo);
}

export function describe(rows, codes, col = 'cagr') {
  const out = {};
  for (const c of codes) {
    const v = rows.filter(r => r.code === c).map(r => r[col]).sort((a, b) => a - b);
    const tot = rows.filter(r => r.code === c).map(r => r.total);
    out[c] = {
      count: v.length, mean: v.length ? mean(v) : NaN, min: v[0], max: v[v.length - 1],
      p5: quantile(v, 0.05), p25: quantile(v, 0.25), p50: quantile(v, 0.5),
      p75: quantile(v, 0.75), p95: quantile(v, 0.95),
      lossProb: tot.length ? tot.filter(x => x < 0).length / tot.length : NaN,
    };
  }
  return out;
}

export function worstBest(rows, codes, col = 'cagr') {
  const out = {};
  for (const c of codes) {
    const g = rows.filter(r => r.code === c);
    if (!g.length) continue;
    let w = g[0], b = g[0];
    for (const r of g) { if (r[col] < w[col]) w = r; if (r[col] > b[col]) b = r; }
    out[c] = { worst: w, best: b };
  }
  return out;
}

export function winRate(rows, a, b, col = 'cagr') {
  const key = r => r.start + '|' + r.end;
  const mb = new Map(rows.filter(r => r.code === b).map(r => [key(r), r[col]]));
  let n = 0, win = 0;
  for (const r of rows) {
    if (r.code !== a || !mb.has(key(r))) continue;
    n++; if (r[col] > mb.get(key(r))) win++;
  }
  return n ? win / n : NaN;
}
