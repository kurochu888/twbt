// 回測引擎（瀏覽器版）。邏輯與 twbt/backtest/ 相同（整張交易：一張 1000 股），結果已和 Python 對照驗證。
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
      sigRet: a.sig_ret ? dec(a.sig_ret) : null,
      sigRetConservative: a.sig_ret_conservative ? dec(a.sig_ret_conservative) : null,
      halt: new Set(a.halt || []),
      pxLast: a.px_last ?? null, splits: a.splits || [],
    };
  }
  // 每個交易日距離前一個交易日幾年（日曆天 ÷ 365.25）：現金利息、蒙地卡羅的年數照日曆時間算（1990 年代週六也開盤）
  const dt = new Float64Array(days.length);
  for (let i = 1; i < days.length; i++) dt[i] = (days[i] - days[i - 1]) / 365.25;
  if (days.length > 1) dt[0] = quantile(Array.from(dt.subarray(1)).sort((a, b) => a - b), 0.5);
  return { days, dt, assets, updated: json.updated, calibration: json.calibration, params: json.params };
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
  // 免手續費（折扣 0）時連最低 20 元也不收；買賣成本都四捨五入到整數元（跟 finance-app 的 defaultFee 一樣）
  const fee = (amt, kind) => (kind === 'index' || amt <= 0 || !(commission * discount > 0)) ? 0 : Math.max(amt * commission * discount, minFee);
  return {
    commission, discount, rate: commission * discount,
    buy: (amt, kind) => Math.floor(fee(amt, kind) + 0.5),
    sell: (amt, kind) => Math.floor(fee(amt, kind) + amt * (tax[kind] ?? 0) + 0.5),
  };
}

// ---------- 整張交易（一張 = 1000 股）：跟 twbt/backtest/lots.py 逐行對應 ----------
export const LOT = 1000;
// 每股價格（以最新收盤為錨、用不含配息的價格報酬往回推，單位是「現在的一股」）、每張股數（分割前 = 1000 × 分割倍數）、每股配息
const lotCache = new Map();
export function lotSeries(data, code, opts) {
  const key = [code, opts.useSynthetic !== false, opts.tw50Excess !== false].join('|');
  if (lotCache.has(key)) return lotCache.get(key);
  const a = data.assets[code], n = data.days.length;
  const r = returnsFor(data, code, opts), s = priceReturnsFor(data, code, opts);
  const px = new Float64Array(n).fill(NaN), lot = new Float64Array(n).fill(LOT), div = new Float64Array(n);
  px[n - 1] = a.pxLast ?? 1;
  for (let t = n - 1; t > 0; t--) {
    if (Number.isNaN(s[t]) || Number.isNaN(px[t])) break;
    px[t - 1] = px[t] / (1 + s[t]);
  }
  for (const [at, ratio] of a.splits) for (let t = 0; t < at; t++) lot[t] *= ratio;
  for (let t = 1; t < n; t++) {
    if (!(Number.isNaN(r[t]) || Number.isNaN(s[t]) || Number.isNaN(px[t - 1])) && r[t] !== s[t]) div[t] = px[t - 1] * (r[t] - s[t]) / (1 + r[t]);
  }
  const out = { px, lot, div };
  if (lotCache.size >= 12) lotCache.delete(lotCache.keys().next().value);
  lotCache.set(key, out);
  return out;
}

// 一筆錢：現金 + 股數（整張買賣）
export class LotAccount {
  constructor(capital, cost, kind) { this.cash = capital; this.shares = 0; this.cost = cost; this.kind = kind; this.rate = cost.rate; }
  maxLots(budget, lotPrice) {           // 這筆預算（含手續費）最多買幾張
    budget = Math.min(budget, this.cash);
    if (!(budget > 0 && lotPrice > 0)) return 0;
    let n = Math.floor(budget / (lotPrice * (1 + this.rate)));
    while (n > 0 && n * lotPrice + this.cost.buy(n * lotPrice, this.kind) > budget) n--;   // 最低手續費 20 元時可能還不夠
    return n;
  }
  buyLots(n, px, lot) {
    if (n <= 0) return false;
    const gross = n * px * lot;
    this.cash -= gross + this.cost.buy(gross, this.kind); this.shares += n * lot;
    return true;
  }
  buyMax(budget, px, lot) { return this.buyLots(this.maxLots(budget, px * lot), px, lot); }
  sellShares(shares, px) {
    if (shares <= 0) return false;
    const gross = shares * px;
    this.cash += gross - this.cost.sell(gross, this.kind); this.shares -= shares;
    return true;
  }
  sellAll(px) { return this.sellShares(this.shares, px); }
  value(px) { return this.cash + this.shares * px; }
  finalValue(px) {                       // 期末全部賣出後的金額
    if (this.shares <= 0) return this.cash;
    const gross = this.shares * px;
    return this.cash + gross - this.cost.sell(gross, this.kind);
  }
}

// 買進持有（整張）：期初買最多張數；除息那天現金夠一張就再投入；期末賣出
function bhPath(data, code, si, ei, opts) {
  const { capital = 1_000_000, cost = makeCost() } = opts;
  const a = data.assets[code], eq = new Float64Array(ei - si + 1);
  if (a.kind === 'index') {               // 大盤不能交易：照指數算、不扣成本
    const r = returnsFor(data, code, opts);
    eq[0] = capital;
    for (let i = si + 1; i <= ei; i++) eq[i - si] = eq[i - si - 1] * (1 + r[i]);
    return { eq, lots0: null };
  }
  const { px, lot, div } = lotSeries(data, code, opts);
  const acct = new LotAccount(capital, cost, a.kind);
  acct.buyMax(acct.cash, px[si], lot[si]);
  const lots0 = acct.shares / lot[si];
  eq[0] = acct.value(px[si]);
  for (let t = si + 1; t <= ei; t++) {
    if (div[t] !== 0) {
      acct.cash += acct.shares * div[t];
      if (!a.halt.has(t)) acct.buyMax(acct.cash, px[t], lot[t]);
    }
    eq[t - si] = acct.value(px[t]);
  }
  eq[eq.length - 1] = acct.finalValue(px[ei]);
  return { eq, lots0, lotPrice: px[si] * lot[si] };
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
  const ppy = years > 0 ? r.length / years : TRADING_DAYS;   // 這段期間平均一年幾個交易日
  const ex = r.map(x => x - rf / ppy);
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
    total, cagr, vol: sd * Math.sqrt(ppy),
    sharpe: sd > 0 ? mean(ex) / sd * Math.sqrt(ppy) : NaN,
    sortino: down.length > 1 ? mean(ex) / std(down) * Math.sqrt(ppy) : NaN,
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
    const { eq, lots0, lotPrice } = bhPath(data, code, si, ei, opts);
    const dayIdx = data.days.subarray(si, ei + 1);
    const st = summarize(eq, dayIdx, opts.rf ?? 0);
    st.lots0 = lots0; st.lotPrice = lotPrice ?? null;
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
  const { capital = 1_000_000 } = opts;
  if (ei - si < 20) return null;
  for (let i = si + 1; i <= ei; i++) if (Number.isNaN(r[i])) return null;
  const { eq } = bhPath(data, code, si, ei, opts);
  let peak = eq[0], mdd = 0;
  const daily = [];
  for (let i = 0; i < eq.length; i++) {
    if (i > 0) daily.push(eq[i] / eq[i - 1] - 1);
    if (eq[i] > peak) peak = eq[i];
    const dd = eq[i] / peak - 1; if (dd < mdd) mdd = dd;
  }
  const net = eq[eq.length - 1] / capital;
  const years = (data.days[ei] - data.days[si]) / 365.25;
  let syn = 0;
  for (let i = si; i <= ei; i++) if (isSynthetic(data, code, i)) syn++;
  return {
    code, start: dayToIso(data.days[si]), end: dayToIso(data.days[ei]), years,
    total: net - 1, cagr: net > 0 ? net ** (1 / years) - 1 : -1,
    mdd, vol: std(daily) * Math.sqrt(daily.length / years), syntheticShare: syn / (ei - si + 1),
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

export function rollingWins(data, years) {
  const L = Math.round(years * 12);
  const first = data.days[0], last = data.days[data.days.length - 1];
  const t = new Date(first * DAY_MS);
  let s = Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), 1) / DAY_MS;
  const wins = [];
  while (addMonths(s, L) <= last) { wins.push([s, addMonths(s, L)]); s = addMonths(s, 1); }
  return wins;
}
export function rolling(data, codes, years, opts) {
  return windows(data, codes, rollingWins(data, years), opts);
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
  return windows(data, codes, randomWins(data, n, yearsMin, yearsMax, seed), opts);
}
export function randomWins(data, n, yearsMin, yearsMax, seed) {
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
  return wins;
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


// ====================== 均線趨勢策略（接刀版） ======================
// 規則照 kurochu888/finance-app 的 computeTrend()/runBacktest()，跟 twbt/backtest/trend.py 逐行對應。
export const LEVERAGE = { TAIEX: 1, '0050': 1, '00631L': 2, '00675L': 2 };
export const TREND_DEFAULTS = {
  2: { maFast: 120, maSlow: 240, exitBuffer: 0.90, recoverSlope: 1.002, recoverStrong: 1.03, pyramidGap: 0.15, pyramidLevels: 2 },
  1: { maFast: 100, maSlow: 200, exitBuffer: 0.95, recoverSlope: 1.002, recoverStrong: 1.03, pyramidGap: 0.15, pyramidLevels: 1 },
};
export const ACT = { NONE: 0, RECOVER: 1, ADD: 2, EXIT: 3 };
export const STATUS = { WATCH: 0, HOLD: 1, WAIT: 2 };
export const STATUS_NAME = ['觀望', '續抱', '接刀中'];

function sma(x, w) {
  const out = new Float64Array(x.length).fill(NaN);
  let s = 0;
  for (let i = 0; i < x.length; i++) {
    s += x[i];
    if (i >= w) s -= x[i - w];
    if (i >= w - 1) out[i] = s / w;
  }
  return out;
}

export function signals(close, p) {
  const n = close.length;
  const act = new Int8Array(n), status = new Int8Array(n), layers = new Int8Array(n);
  const win = Math.max(p.maFast, p.maSlow);
  if (n < win + 1) return { act, status, layers };
  const maf = sma(close, p.maFast), mas = sma(close, p.maSlow);
  let st = STATUS.WATCH, base = 0, cnt = 0;
  for (let i = win; i < n; i++) {
    const c = close[i], f = maf[i], s = mas[i], fy = maf[i - 1];
    let a = ACT.NONE;
    if (st === STATUS.HOLD) {
      if (c < f * p.exitBuffer) a = ACT.EXIT;
    } else {
      const stable = c > f && close[i - 1] > maf[i - 1];
      const slope = f >= fy * p.recoverSlope;
      const strong = c > f * p.recoverStrong;
      const ref = Math.min(base > 0 ? base : close[i - 1], s);
      if ((stable && slope) || strong) a = ACT.RECOVER;
      else if (c < ref * (1 - p.pyramidGap) && cnt < p.pyramidLevels) a = ACT.ADD;
    }
    if (a === ACT.RECOVER) { base = c; cnt = 0; st = STATUS.HOLD; }
    else if (a === ACT.ADD) { base = c; cnt += 1; st = STATUS.WAIT; }
    else if (a === ACT.EXIT) { base = c; cnt = 0; st = STATUS.WAIT; }
    act[i] = a; status[i] = st; layers[i] = cnt;
  }
  return { act, status, layers };
}

// 訊號用的價格報酬：預設「只還原分割、不含配息」（跟 app 一樣）；signalPrice='adjusted' 用總報酬
function signalReturnsFor(data, code, opts) {
  const a = data.assets[code];
  if (opts.signalPrice === 'adjusted' || !a.sigRet) return returnsFor(data, code, opts);
  let r = (opts.tw50Excess === false && a.sigRetConservative) ? a.sigRetConservative : a.sigRet;
  if (opts.useSynthetic === false && a.firstReal !== null) {
    r = Float64Array.from(r);
    for (let i = 0; i <= a.firstReal; i++) r[i] = NaN;
  }
  return r;
}

// 每股價格用的報酬：一律不含配息（只還原分割）。正2 不配息，就是總報酬
function priceReturnsFor(data, code, opts) {
  return signalReturnsFor(data, code, { ...opts, signalPrice: 'raw' });
}

const prepCache = new Map();
export function trendPrep(data, code, opts, p) {
  const key = [code, opts.useSynthetic !== false, opts.tw50Excess !== false, opts.signalPrice || 'raw', JSON.stringify(p)].join('|');
  if (prepCache.has(key)) return prepCache.get(key);
  const r = returnsFor(data, code, opts), sr = signalReturnsFor(data, code, opts);
  let first = -1;
  for (let i = 0; i < r.length; i++) if (!Number.isNaN(r[i])) { first = i; break; }
  if (first < 1) { prepCache.set(key, null); return null; }
  const i0 = first - 1, n = r.length - i0;
  const price = new Float64Array(n), spx = new Float64Array(n);
  price[0] = spx[0] = 1;
  for (let j = 1; j < n; j++) {
    price[j] = price[j - 1] * (1 + r[i0 + j]);
    spx[j] = spx[j - 1] * (1 + (Number.isNaN(sr[i0 + j]) ? 0 : sr[i0 + j]));
  }
  const halt = data.assets[code].halt, pos = [];
  for (let j = 0; j < n; j++) if (j === 0 || !halt.has(i0 + j)) pos.push(j);   // 暫停交易日不算進均線
  const sig = signals(Float64Array.from(pos, j => spx[j]), p);
  const act = new Int8Array(n), status = new Int8Array(n), layers = new Int8Array(n);
  let k = 0;
  for (let j = 0; j < n; j++) {
    if (k + 1 < pos.length && pos[k + 1] === j) k++;
    if (pos[k] === j) act[j] = sig.act[k];
    status[j] = sig.status[k]; layers[j] = sig.layers[k];
  }
  const win = Math.max(p.maFast, p.maSlow);
  const minSi = pos.length >= win ? i0 + pos[win - 1] : Infinity;   // 均線第一次算得出來的那天
  const out = { i0, minSi, price, act, status, layers };
  if (prepCache.size >= 20) prepCache.delete(prepCache.keys().next().value);   // 最多留 20 份（改參數很多次也不會一直吃記憶體）
  prepCache.set(key, out);
  return out;
}

function trendSim(data, code, prep, p, si, ei, opts, keepEvents) {
  const { capital = 1_000_000, cost = makeCost() } = opts;
  const kind = data.assets[code].kind, halt = data.assets[code].halt;
  const { i0, act, status, layers } = prep;
  const { px: PX, lot: LOTS, div: DIV } = lotSeries(data, code, opts);
  const acct = new LotAccount(capital, cost, kind);
  const j0 = si - i0, st0 = status[j0], k0 = layers[j0];
  let cashAtExit = capital;
  if (st0 === STATUS.HOLD) acct.buyMax(acct.cash, PX[si], LOTS[si]);
  else if (st0 === STATUS.WAIT && k0 > 0) acct.buyMax(cashAtExit * k0 / p.pyramidLevels, PX[si], LOTS[si]);
  const eq = new Float64Array(ei - si + 1);
  eq[0] = acct.value(PX[si]);
  const events = [];
  let peak = eq[0], mdd = 0, inMarket = acct.shares > 0 ? 1 : 0;
  for (let t = si + 1; t <= ei; t++) {
    const j = t - i0, a = act[j], px = PX[t], lot = LOTS[t];
    if (DIV[t] !== 0) acct.cash += acct.shares * DIV[t];          // 配息發現金
    if (a === ACT.RECOVER) acct.buyMax(acct.cash, px, lot);
    else if (a === ACT.ADD) acct.buyMax(cashAtExit / p.pyramidLevels, px, lot);
    else if (a === ACT.EXIT) { acct.sellAll(px); cashAtExit = acct.cash; }
    else if (DIV[t] !== 0 && status[j] === STATUS.HOLD && !halt.has(t)) acct.buyMax(acct.cash, px, lot);   // 續抱中配息再投入
    const v = acct.value(px);
    if (a && keepEvents) events.push({ i: t, act: a, layer: layers[j], value: v, price: px * lot / LOT, lots: acct.shares / lot });
    eq[t - si] = v;
    if (acct.shares > 0) inMarket++;
  }
  eq[eq.length - 1] = acct.finalValue(PX[ei]);
  for (const v of eq) { if (v > peak) peak = v; const d = v / peak - 1; if (d < mdd) mdd = d; }
  return { eq, events, st0, k0, mdd, inMarket: inMarket / eq.length };
}

export function trendParamsFor(code, custom) {
  const lev = LEVERAGE[code] >= 2 ? 2 : 1;
  return { ...TREND_DEFAULTS[lev], ...(custom?.[lev] || {}) };
}

export function trendPeriod(data, codes, startIso, endIso, opts, custom) {
  const results = [], skipped = [];
  let anyBounds = false;
  for (const code of codes.filter(c => c !== 'TAIEX')) {
    const p = trendParamsFor(code, custom);
    const prep = trendPrep(data, code, opts, p);
    if (!prep || !Number.isFinite(prep.minSi)) { skipped.push({ code, name: data.assets[code].name, availableFrom: '－' }); continue; }
    // 均線還算不出來的日子策略只能觀望，跟買進持有比不公平：兩者都從均線第一次算得出來的那天開始
    const firstOk = dayToIso(data.days[prep.minSi]);
    const s0 = startIso < firstOk ? firstOk : startIso;
    const one = period(data, [code], s0, endIso, opts);
    if (one.error) { if (s0 !== startIso) skipped.push({ code, name: data.assets[code].name, availableFrom: firstOk }); continue; }
    anyBounds = true;
    skipped.push(...one.skipped);
    const r = one.results[0];
    if (!r) continue;
    const si = data.days.indexOf(r.dayIdx[0]), ei = si + r.dayIdx.length - 1;
    const sim = trendSim(data, r.code, prep, p, si, ei, opts, true);
    const st = summarize(sim.eq, r.dayIdx, opts.rf ?? 0);
    st.syntheticShare = r.stats.syntheticShare; st.syntheticUntil = r.stats.syntheticUntil;
    st.inMarket = sim.inMarket;
    results.push({
      ...r, bh: r.stats, stats: st, equity: sim.eq, bhEquity: r.equity, params: p,
      shiftedFrom: s0 !== startIso ? firstOk : null,
      startStatus: STATUS_NAME[sim.st0] + (sim.st0 === STATUS.WAIT ? `（已接 ${sim.k0} 層）` : ''),
      events: sim.events.map(e => ({ ...e, date: dayToIso(data.days[e.i]) })),
    });
  }
  if (!anyBounds && !results.length && !skipped.length) return { error: '這段區間沒有足夠的交易日' };
  return { results, skipped };
}

export function trendWindows(data, codes, wins, opts, custom) {
  codes = codes.filter(c => c !== 'TAIEX');
  const bhRows = windows(data, codes, wins, opts);
  const bhMap = new Map(bhRows.map(r => [r.code + '|' + r.start + '|' + r.end, r]));
  const rows = [];
  const preps = Object.fromEntries(codes.map(c => [c, trendPrep(data, c, opts, trendParamsFor(c, custom))]));
  for (const [s, e] of wins) {
    const b = bounds(data.days, s, e);
    if (!b) continue;
    const [si, ei] = b;
    for (const c of codes) {
      const bh = bhMap.get(c + '|' + dayToIso(data.days[si]) + '|' + dayToIso(data.days[ei]));
      const prep = preps[c];
      if (!bh || !prep || si < prep.minSi) continue;   // 均線還算不出來的起點不比
      const sim = trendSim(data, c, prep, trendParamsFor(c, custom), si, ei, opts, false);
      const net = sim.eq[sim.eq.length - 1] / (opts.capital ?? 1_000_000);
      rows.push({
        code: c, start: bh.start, end: bh.end, years: bh.years,
        total: net - 1, cagr: net > 0 ? net ** (1 / bh.years) - 1 : -1, mdd: sim.mdd,
        bhTotal: bh.total, bhCagr: bh.cagr, bhMdd: bh.mdd, syntheticShare: bh.syntheticShare,
      });
    }
  }
  return rows;
}

// ====================== 蒙地卡羅（區塊自助抽樣） ======================
// 跟 twbt/backtest/montecarlo.py 同一套：stationary block bootstrap 重組歷史日報酬，
// 每條路徑先讓均線累積（觀望），之後 years 年比較策略與買進持有（同一天開始、都扣成本）。
function geometric(rnd, p) {
  if (p >= 1) return 1;
  return Math.max(1, Math.ceil(Math.log(1 - rnd()) / Math.log(1 - p)));
}

export function mcSource(data, code, opts) {
  const r = returnsFor(data, code, opts), s = signalReturnsFor(data, code, opts), q = priceReturnsFor(data, code, opts);
  const rr = [], ss = [], qq = [], dd = [];
  for (let i = 0; i < r.length; i++) if (!Number.isNaN(r[i]) && !Number.isNaN(s[i]) && !Number.isNaN(q[i])) { rr.push(r[i]); ss.push(s[i]); qq.push(q[i]); dd.push(data.dt[i]); }
  let first = -1;
  for (let i = 0; i < r.length; i++) if (!Number.isNaN(r[i])) { first = i; break; }
  return { r: Float64Array.from(rr), s: Float64Array.from(ss), q: Float64Array.from(qq), dt: Float64Array.from(dd), px0: data.assets[code].pxLast ?? 1,
    from: first > 0 ? dayToIso(data.days[first]) : '－', to: dayToIso(data.days[data.days.length - 1]) };
}

// 模擬路徑的每股價格與配息：從現在的每股價格出發、一張 1000 股、沒有分割（跟 montecarlo.py 的 path_prices 一樣）
function pathPrices(r, q, px0) {
  const n = r.length + 1, px = new Float64Array(n), div = new Float64Array(n);
  px[0] = px0;
  for (let j = 1; j < n; j++) {
    px[j] = px[j - 1] * (1 + q[j - 1]);
    if (r[j - 1] !== q[j - 1]) div[j] = px[j - 1] * (r[j - 1] - q[j - 1]) / (1 + r[j - 1]);
  }
  return { px, div };
}

function mcPath(src, idx, p, warm, kind, cost, capital) {
  let years = 0;
  for (let j = warm; j < idx.length; j++) years += src.dt[idx[j]];   // 這條路徑實際經過的日曆時間
  const n = idx.length + 1;
  const spx = new Float64Array(n), rr = new Float64Array(n - 1), qq = new Float64Array(n - 1);
  spx[0] = 1;
  for (let j = 1; j < n; j++) { spx[j] = spx[j - 1] * (1 + src.s[idx[j - 1]]); rr[j - 1] = src.r[idx[j - 1]]; qq[j - 1] = src.q[idx[j - 1]]; }
  const { px, div } = pathPrices(rr, qq, src.px0);
  const { act, status } = signals(spx, p);
  const acct = new LotAccount(capital, cost, kind);
  let cashAtExit = capital, trades = 0;
  let peak = capital, mdd = 0, v = capital;
  for (let t = warm + 1; t < n; t++) {
    const a = act[t];
    if (div[t] !== 0) acct.cash += acct.shares * div[t];
    if (a === ACT.RECOVER) { acct.buyMax(acct.cash, px[t], LOT); trades++; }
    else if (a === ACT.ADD) { acct.buyMax(cashAtExit / p.pyramidLevels, px[t], LOT); trades++; }
    else if (a === ACT.EXIT) { acct.sellAll(px[t]); cashAtExit = acct.cash; trades++; }
    else if (div[t] !== 0 && status[t] === STATUS.HOLD) acct.buyMax(acct.cash, px[t], LOT);
    v = t === n - 1 ? acct.finalValue(px[t]) : acct.value(px[t]);
    if (v > peak) peak = v; else if (v / peak - 1 < mdd) mdd = v / peak - 1;
  }
  const b = new LotAccount(capital, cost, kind);
  b.buyMax(b.cash, px[warm], LOT);
  let bv = b.value(px[warm]), bpeak = bv, bmdd = 0;
  for (let t = warm + 1; t < n; t++) {
    if (div[t] !== 0) { b.cash += b.shares * div[t]; b.buyMax(b.cash, px[t], LOT); }
    bv = t === n - 1 ? b.finalValue(px[t]) : b.value(px[t]);
    if (bv > bpeak) bpeak = bv; else if (bv / bpeak - 1 < bmdd) bmdd = bv / bpeak - 1;
  }
  const cg = x => (x > 0 ? x ** (1 / years) - 1 : -1);
  return { cagr: cg(v / capital), mdd, bhCagr: cg(bv / capital), bhMdd: bmdd, trades };
}

// 跑 n 條路徑；每 chunk 條讓出一次畫面（onProgress 回報進度，回傳 false 可中止）
export async function monteCarlo(data, code, opts, custom, { n = 1000, years = 10, block = 120, seed = 1, chunk = 50 } = {}, onProgress) {
  const src = mcSource(data, code, opts);
  const p = trendParamsFor(code, custom);
  const warm = Math.max(p.maFast, p.maSlow) - 1;
  if (src.r.length < 2 * Math.max(p.maFast, p.maSlow)) throw new Error(`${code} 可抽樣的資料太少`);
  let span = 0;
  for (let i = 1; i < src.dt.length; i++) span += src.dt[i];
  const len = warm + Math.round(years * src.r.length / span);   // 取樣歷史平均一年幾個交易日
  const rnd = mulberry32(seed), N = src.r.length, prob = 1 / block;
  const cost = opts.cost ?? makeCost(), capital = opts.capital ?? 1_000_000, kind = data.assets[code].kind;
  const rows = [], idx = new Int32Array(len);
  for (let k = 0; k < n; k++) {
    let i = 0;
    while (i < len) {
      const start = Math.floor(rnd() * N), L = block <= 1 ? 1 : Math.min(geometric(rnd, prob), len - i);
      for (let j = 0; j < L; j++) idx[i + j] = (start + j) % N;
      i += L;
    }
    rows.push(mcPath(src, idx, p, warm, kind, cost, capital));
    if ((k + 1) % chunk === 0 && onProgress) {
      if (onProgress((k + 1) / n) === false) return null;
      await new Promise(res => setTimeout(res, 0));
    }
  }
  return { code, rows, source: src, params: p };
}

export function mcSummary(rows) {
  const q = (arr, p) => quantile([...arr].sort((a, b) => a - b), p);
  const d = rows.map(r => r.cagr - r.bhCagr);
  const n = rows.length;
  const share = f => rows.filter(f).length / n;
  return {
    n, win: d.filter(x => x > 0).length / n,
    diff50: q(d, 0.5), diff5: q(d, 0.05), diff95: q(d, 0.95),
    mddBetter: share(r => r.mdd > r.bhMdd),
    loss: share(r => r.cagr < 0), bhLoss: share(r => r.bhCagr < 0),
    trades: rows.reduce((a, r) => a + r.trades, 0) / n,
  };
}

// ====================== 再平衡策略 ======================
// 跟 twbt/backtest/rebalance.py 逐行對應。cfg = {weights: {code: w, CASH: w}, freq: 'none'|'M'|'Q'|'H'|'Y', band, cashRate, trend}
export const REBAL_ASSETS = ['0050', '00631L', '00675L'];
const LEVERAGED = new Set(['00631L', '00675L']);
const MIN_TRADE = 1000;   // 再平衡時單筆不到 1,000 元就不交易（跟 Python 版一樣）
export const EXPOSURE = { '0050': 1, '00631L': 2, '00675L': 2, CASH: 0 };

export function normWeights(weights) {
  const w = Object.fromEntries(Object.entries(weights).filter(([, v]) => v > 0));
  const s = Object.values(w).reduce((a, b) => a + b, 0);
  if (!(s > 0)) throw new Error('配置比例加總要大於 0');
  for (const k in w) w[k] /= s;
  return w;
}
export const exposureOf = weights => Object.entries(normWeights(weights)).reduce((a, [k, v]) => a + EXPOSURE[k] * v, 0);

function periodKey(day, freq) {
  const t = new Date(day * DAY_MS), y = t.getUTCFullYear(), m = t.getUTCMonth() + 1;
  if (freq === 'M') return y * 12 + m;
  if (freq === 'Q') return y * 4 + Math.floor((m - 1) / 3);
  if (freq === 'H') return y * 2 + Math.floor((m - 1) / 6);
  if (freq === 'Y') return y;
  return null;
}

function rebalCtx(data, cfg, opts, custom) {
  const w = normWeights(cfg.weights);
  const codes = Object.keys(w).filter(k => k !== 'CASH');
  const R = Object.fromEntries(codes.map(c => [c, returnsFor(data, c, opts)]));
  const preps = {};
  let first = 0;
  for (const c of codes) {
    let f = -1;
    for (let i = 0; i < R[c].length; i++) if (!Number.isNaN(R[c][i])) { f = i; break; }
    if (f < 1) throw new Error(`${c} 沒有資料`);
    first = Math.max(first, f - 1);
    if (cfg.trend && LEVERAGED.has(c)) {
      const p = trendParamsFor(c, custom);
      preps[c] = { prep: trendPrep(data, c, opts, p), levels: p.pyramidLevels };
      first = Math.max(first, preps[c].prep.minSi);
    }
  }
  const L = Object.fromEntries(codes.map(c => [c, lotSeries(data, c, opts)]));
  return { w, codes, R, preps, first,
    PX: Object.fromEntries(codes.map(c => [c, L[c].px])), LOTS: Object.fromEntries(codes.map(c => [c, L[c].lot])),
    DIV: Object.fromEntries(codes.map(c => [c, L[c].div])) };
}

function rebalSim(data, ctx, cfg, si, ei, opts, keepLog) {
  const { w, codes, preps, PX, LOTS, DIV } = ctx;
  const keyAt = ctx.keyAt ?? (t => periodKey(data.days[t], cfg.freq));
  const cost = opts.cost ?? makeCost(), capital = opts.capital ?? 1_000_000;
  const cashG = 1 + (cfg.cashRate ?? 0), dtAt = ctx.dt ? (t => ctx.dt[t]) : (t => data.dt[t]);
  const kind = c => (ctx.kind ? ctx.kind[c] : data.assets[c].kind);
  const acct = Object.fromEntries(codes.map(c => [c, new LotAccount(0, cost, kind(c))]));   // 每一檔的股數（現金統一放 cash）
  let cash = capital, trades = 0, curT = si;
  const log = [];
  const frac = (c, t) => {
    const g = preps[c]; if (!g) return 1;
    const j = t - g.prep.i0, st = g.prep.status[j], k = g.prep.layers[j];
    return st === STATUS.HOLD ? 1 : (st === STATUS.WAIT && k > 0 ? k / g.levels : 0);
  };
  const target = t => {
    const tw = {}; let s = 0;
    for (const c of codes) { tw[c] = w[c] * frac(c, t); s += tw[c]; }
    tw.CASH = 1 - s; return tw;
  };
  const hold = c => acct[c].shares * PX[c][curT];
  const total = () => { let v = cash; for (const c of codes) v += hold(c); return v; };
  // 暫停交易（分割）的日子不能買賣：定期再平衡先跳過那一檔，下次檢查再調（模擬路徑沒有暫停交易日）
  const halted = c => !ctx.dt && data.assets[c].halt.has(curT);
  // smallOk：期初建立部位、均線訊號的進出不受 MIN_TRADE 限制；目標 0（出場）一定全部賣掉
  const tradeTo = (tw, only, smallOk) => {
    const V = total(), sel = only ? [only] : codes.filter(c => smallOk || !halted(c));
    const want = {};
    for (const c of sel) want[c] = tw[c] === 0 ? 0 : Math.floor(tw[c] * V / (PX[c][curT] * LOTS[c][curT]) + 0.5);   // 最接近目標的張數
    for (const c of sel) {                                    // 先賣
      const a = acct[c], lot = LOTS[c][curT], have = Math.round(a.shares / lot);
      if (have > want[c]) {
        const g = (have - want[c]) * lot * PX[c][curT];
        if (g < MIN_TRADE && !(smallOk || tw[c] === 0)) continue;
        a.cash = 0; a.sellShares(want[c] === 0 ? a.shares : (have - want[c]) * lot, PX[c][curT]);
        cash += a.cash; trades++;
      }
    }
    for (const c of sel) {                                    // 再用現金買
      const a = acct[c], lot = LOTS[c][curT], have = Math.round(a.shares / lot);
      if (have < want[c]) {
        const pl = PX[c][curT] * lot;
        a.cash = cash;
        const n = Math.min(want[c] - have, a.maxLots(cash, pl));
        if (n <= 0 || (n * pl < MIN_TRADE && !smallOk)) continue;
        a.buyLots(n, PX[c][curT], lot);
        cash = a.cash; trades++;
      }
    }
  };
  tradeTo(target(si), null, true);
  const eq = new Float64Array(ei - si + 1);
  eq[0] = total();
  let lastKey = keyAt(si);
  for (let t = si + 1; t <= ei; t++) {
    curT = t;
    cash *= cashG ** dtAt(t);
    for (const c of codes) if (DIV[c][t] !== 0) cash += acct[c].shares * DIV[c][t];   // 配息發現金
    const tw = target(t);
    if (cfg.trend) for (const c of codes) {
      const g = preps[c];
      if (g && g.prep.act[t - g.prep.i0]) { tradeTo(tw, c, true); if (keepLog) log.push({ i: t, what: `${c} 均線訊號`, act: g.prep.act[t - g.prep.i0] }); }
    }
    const key = keyAt(t);
    const check = (cfg.freq === 'none' && cfg.band > 0) || (key !== null && key !== lastKey);
    lastKey = key;
    if (check) {
      const V = total();
      let dev = Math.abs(cash / V - tw.CASH);
      for (const c of codes) dev = Math.max(dev, Math.abs(hold(c) / V - tw[c]));
      if (!(cfg.band > 0) || dev > cfg.band + 1e-12) { const n0 = trades; tradeTo(tw); if (keepLog && trades > n0) log.push({ i: t, what: '再平衡' }); }
    }
    eq[t - si] = total();
  }
  for (const c of codes) if (acct[c].shares > 0) eq[eq.length - 1] -= cost.sell(hold(c), kind(c));
  return { eq, trades, log };
}

export function rebalPeriod(data, cfg, startIso, endIso, opts, custom) {
  const ctx = rebalCtx(data, cfg, opts, custom);
  const b = bounds(data.days, isoToDay(startIso), isoToDay(endIso));
  if (!b) return { error: '這段區間沒有足夠的交易日' };
  let [si, ei] = b;
  const shifted = si < ctx.first ? dayToIso(data.days[ctx.first]) : null;
  si = Math.max(si, ctx.first);
  if (si >= ei) return { error: `這個配置最早 ${dayToIso(data.days[ctx.first])} 才有資料` };
  const dayIdx = data.days.subarray(si, ei + 1);
  const main = rebalSim(data, ctx, cfg, si, ei, opts, true);
  const flat = rebalSim(data, ctx, { ...cfg, freq: 'none', band: 0 }, si, ei, opts, false);
  const lotPrice = Object.fromEntries(ctx.codes.map(c => [c, ctx.PX[c][si] * ctx.LOTS[c][si]]));
  return { si, ei, dayIdx, shifted, main, flat, lotPrice, exposure: exposureOf(cfg.weights),
    stats: summarize(main.eq, dayIdx), flatStats: summarize(flat.eq, dayIdx) };
}

export function rebalWindows(data, cfg, wins, opts, custom) {
  const ctx = rebalCtx(data, cfg, opts, custom);
  const flatCfg = { ...cfg, freq: 'none', band: 0 };
  const capital = opts.capital ?? 1_000_000, rows = [];
  for (const [s, e] of wins) {
    const b = bounds(data.days, s, e);
    if (!b) continue;
    const [si, ei] = b;
    if (si < ctx.first || ei - si < 20) continue;
    const years = (data.days[ei] - data.days[si]) / 365.25;
    const row = { start: dayToIso(data.days[si]), end: dayToIso(data.days[ei]), years };
    for (const [name, c] of [['', cfg], ['flat', flatCfg]]) {
      const { eq } = rebalSim(data, ctx, c, si, ei, opts, false);
      const net = eq[eq.length - 1] / capital;
      let peak = eq[0], mdd = 0;
      for (const v of eq) { if (v > peak) peak = v; const d = v / peak - 1; if (d < mdd) mdd = d; }
      row[name ? 'flatCagr' : 'cagr'] = net > 0 ? net ** (1 / years) - 1 : -1;
      row[name ? 'flatMdd' : 'mdd'] = mdd;
      row[name ? 'flatTotal' : 'total'] = net - 1;
    }
    rows.push(row);
  }
  return rows;
}


// ---------- 再平衡的蒙地卡羅：所有標的同一天一起抽樣（保留彼此的關聯） ----------
// 模擬行情沒有日曆，「每月／每季／每半年／每年」用交易日數近似：21／63／126／252 天
const FREQ_DAYS = { M: 21, Q: 63, H: 126, Y: 252 };

export function rebalMcPath(data, cfg, opts, custom, idx, warm, yearsIn, srcIn) {
  const w = normWeights(cfg.weights);
  const codes = Object.keys(w).filter(k => k !== 'CASH');
  const need = new Set([...codes, '0050', '00631L']);           // 對照組要用到 0050、00631L
  const src = srcIn ?? Object.fromEntries([...need].map(c => [c, { r: returnsFor(data, c, opts), s: signalReturnsFor(data, c, opts), q: priceReturnsFor(data, c, opts) }]));
  const n = idx.length + 1;
  const R = {}, preps = {}, kind = {}, PX = {}, LOTS = {}, DIV = {};
  const dtp = new Float64Array(n);
  let years = 0;
  for (let j = 1; j < n; j++) { dtp[j] = data.dt[idx[j - 1]]; if (j > warm) years += dtp[j]; }   // 實際經過的日曆時間
  for (const c of need) {
    const r = new Float64Array(n), spx = new Float64Array(n);
    spx[0] = 1;
    const q = new Float64Array(n - 1);
    for (let j = 1; j < n; j++) { r[j] = src[c].r[idx[j - 1]]; q[j - 1] = src[c].q[idx[j - 1]]; spx[j] = spx[j - 1] * (1 + src[c].s[idx[j - 1]]); }
    R[c] = r; kind[c] = data.assets[c].kind;
    const pp = pathPrices(r.subarray(1), q, data.assets[c].pxLast ?? 1);
    PX[c] = pp.px; DIV[c] = pp.div; LOTS[c] = new Float64Array(n).fill(LOT);
    if (LEVERAGED.has(c)) {
      const p = trendParamsFor(c, custom), sig = signals(spx, p);
      preps[c] = { prep: { i0: 0, ...sig }, levels: p.pyramidLevels, p };
    }
  }
  const fd = FREQ_DAYS[cfg.freq];
  const mk = (cf, cs) => ({ w: normWeights(cf.weights), codes: cs, R, kind, dt: dtp, PX, LOTS, DIV,
    preps: cf.trend ? Object.fromEntries(cs.filter(c => preps[c]).map(c => [c, preps[c]])) : {},
    keyAt: t => (fd ? Math.floor((t - warm) / fd) : null) });
  const ei = n - 1, capital = opts.capital ?? 1_000_000;
  const res = eq => {
    let peak = eq[0], mdd = 0;
    for (const v of eq) { if (v > peak) peak = v; const d = v / peak - 1; if (d < mdd) mdd = d; }
    const net = eq[eq.length - 1] / capital;
    return { cagr: net > 0 ? net ** (1 / years) - 1 : -1, mdd };
  };
  const main = res(rebalSim(data, mk(cfg, codes), cfg, warm, ei, opts, false).eq);
  const flatCfg = { ...cfg, freq: 'none', band: 0 };
  const flat = res(rebalSim(data, mk(flatCfg, codes), flatCfg, warm, ei, opts, false).eq);
  const bhCfg = { weights: { '0050': 1 }, freq: 'none', band: 0, cashRate: 0, trend: false };
  const bh = res(rebalSim(data, mk(bhCfg, ['0050']), bhCfg, warm, ei, opts, false).eq);
  const trCfg = { weights: { '00631L': 1 }, freq: 'none', band: 0, cashRate: 0, trend: true };
  const tr = res(rebalSim(data, mk(trCfg, ['00631L']), trCfg, warm, ei, opts, false).eq);
  const out = { cagr: main.cagr, mdd: main.mdd, flatCagr: flat.cagr, flatMdd: flat.mdd,
    bhCagr: bh.cagr, bhMdd: bh.mdd, trCagr: tr.cagr, trMdd: tr.mdd };
  if (cfg.trend && codes.some(c => LEVERAGED.has(c))) {          // 同配置、同規則、不搭配均線
    const ntCfg = { ...cfg, trend: false };
    const nt = res(rebalSim(data, mk(ntCfg, codes), ntCfg, warm, ei, opts, false).eq);
    out.noTrCagr = nt.cagr; out.noTrMdd = nt.mdd;
  }
  return out;
}

export async function rebalMonteCarlo(data, cfg, opts, custom, { n = 1000, years = 10, block = 120, seed = 1, chunk = 25 } = {}, onProgress) {
  const w = normWeights(cfg.weights);
  const codes = [...new Set([...Object.keys(w).filter(k => k !== 'CASH'), '0050', '00631L'])];
  // 可抽樣的日子：每一檔都有資料
  const rs = codes.map(c => [returnsFor(data, c, opts), signalReturnsFor(data, c, opts), priceReturnsFor(data, c, opts)]);
  const src = Object.fromEntries(codes.map((c, i) => [c, { r: rs[i][0], s: rs[i][1], q: rs[i][2] }]));
  const ok = [];
  for (let i = 0; i < data.days.length; i++) if (rs.every(([r, s, q]) => !Number.isNaN(r[i]) && !Number.isNaN(s[i]) && !Number.isNaN(q[i]))) ok.push(i);
  if (ok.length < 600) throw new Error('可抽樣的資料太少');
  const warm = Math.max(...['00631L', '00675L'].map(c => { const p = trendParamsFor(c, custom); return Math.max(p.maFast, p.maSlow); })) - 1;
  let span = 0;
  for (let k = 1; k < ok.length; k++) span += data.dt[ok[k]];
  const len = warm + Math.round(years * ok.length / span);   // 取樣歷史平均一年幾個交易日
  const rnd = mulberry32(seed), N = ok.length, prob = 1 / block;
  const idx = new Int32Array(len), rows = [];
  for (let k = 0; k < n; k++) {
    let i = 0;
    while (i < len) {
      const start = Math.floor(rnd() * N), L = block <= 1 ? 1 : Math.min(geometric(rnd, prob), len - i);
      for (let j = 0; j < L; j++) idx[i + j] = ok[(start + j) % N];
      i += L;
    }
    rows.push(rebalMcPath(data, cfg, opts, custom, idx, warm, years, src));
    if ((k + 1) % chunk === 0 && onProgress) {
      if (onProgress((k + 1) / n) === false) return null;
      await new Promise(res => setTimeout(res, 0));
    }
  }
  return { rows, from: dayToIso(data.days[ok[0]]), to: dayToIso(data.days[ok[N - 1]]) };
}
