// 回測引擎（瀏覽器版）。邏輯與 twbt/backtest/ 相同（整張交易：台股一張 1000 股、美股一次 1 股），結果已和 Python 對照驗證。
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
// 市場：資料檔裡的 market（舊版 returns.json 沒有 = 台股）。美股：美元、一次 1 股、成本到 0.01 美元、配息預扣 30%
const TW_MARKET = { id: 'tw', currency: 'TWD', lot: 1000, tick: 10, costUnit: 1, minTrade: 1000, capital: 1_000_000,
  bench: 'TAIEX', base: '0050', lev: '00631L', rebal: ['0050', '00631L', '00675L'] };
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
      leverage: a.leverage ?? LEVERAGE[code] ?? 1, divTax: a.div_tax ?? 0,
    };
    LEVERAGE[code] = assets[code].leverage;            // 均線預設參數、再平衡曝險照槓桿倍數
    if (a.kind !== 'index') EXPOSURE[code] = assets[code].leverage;
  }
  const m = json.market;
  const market = m ? { id: m.id, currency: m.currency, lot: m.lot, tick: m.tick, costUnit: m.cost_unit, minTrade: m.min_trade,
    capital: m.capital, bench: m.bench, base: m.base, lev: m.lev, rebal: m.rebal } : TW_MARKET;
  // 每個交易日距離前一個交易日幾年（日曆天 ÷ 365.25）：現金利息、蒙地卡羅的年數照日曆時間算（1990 年代週六也開盤）
  const dt = new Float64Array(days.length);
  for (let i = 1; i < days.length; i++) dt[i] = (days[i] - days[i - 1]) / 365.25;
  if (days.length > 1) dt[0] = quantile(Array.from(dt.subarray(1)).sort((a, b) => a - b), 0.5);
  return { days, dt, assets, market, updated: json.updated, calibration: json.calibration, params: json.params };
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
export function makeCost({ commission = 0.001425, discount = 1, minFee = 20, tax = TAX, unit = 1 } = {}) {
  // 免手續費（折扣 0）時連最低 20 元也不收；買賣成本都四捨五入到整數元（跟 finance-app 的 defaultFee 一樣）
  // unit：四捨五入的單位（台股 1 元、美股 0.01 美元）
  const fee = (amt, kind) => (kind === 'index' || amt <= 0 || !(commission * discount > 0)) ? 0 : Math.max(amt * commission * discount, minFee);
  const rd = unit === 1 ? (x => Math.floor(x + 0.5)) : (x => Math.floor(x / unit + 0.5) * unit);
  return {
    commission, discount, rate: commission * discount,
    buy: (amt, kind) => rd(fee(amt, kind)),
    sell: (amt, kind) => rd(fee(amt, kind) + amt * (tax[kind] ?? 0)),
  };
}
// 美股成本：手續費率（例如 0.001 = 0.1%）、每筆最低（美元），沒有證交稅（同 costs.py 的 us_cost）
export const NO_TAX = { stock: 0, etf: 0, index: 0 };
export function makeUsCost({ commission = 0, minFee = 0 } = {}) {
  return makeCost({ commission, discount: 1, minFee, tax: NO_TAX, unit: 0.01 });
}
export const costFor = (data, o = {}) => (data.market.id === 'us' ? makeUsCost(o) : makeCost(o));

// ---------- 整張交易（台股一張 = 1000 股、美股 1 股）：跟 twbt/backtest/lots.py 逐行對應 ----------
export const LOT = 1000;
// 每股價格（以最新收盤為錨、用不含配息的價格報酬往回推，單位是「現在的一股」）、每張股數（分割前 = 1000 × 分割倍數）、每股配息
const lotCache = new Map();
export function lotSeries(data, code, opts) {
  const key = [data.market.id, code, opts.useSynthetic !== false, opts.tw50Excess !== false].join('|');
  if (lotCache.has(key)) return lotCache.get(key);
  const a = data.assets[code], n = data.days.length, M = data.market;
  const r = returnsFor(data, code, opts), s = priceReturnsFor(data, code, opts);
  const px = new Float64Array(n).fill(NaN), lot = new Float64Array(n).fill(M.lot), div = new Float64Array(n);
  px[n - 1] = a.pxLast ?? 1;
  for (let t = n - 1; t > 0; t--) {
    if (Number.isNaN(s[t]) || Number.isNaN(px[t])) break;
    px[t - 1] = px[t] / (1 + s[t]);
  }
  for (const [at, ratio] of a.splits) for (let t = 0; t < at; t++) lot[t] *= ratio;
  const keep = 1 - a.divTax;                          // 配息扣掉預扣稅後實際入帳的比例（美股 0.7）
  for (let t = 1; t < n; t++) {
    if (!(Number.isNaN(r[t]) || Number.isNaN(s[t]) || Number.isNaN(px[t - 1])) && r[t] !== s[t]) {
      div[t] = px[t - 1] * (r[t] - s[t]) / (1 + r[t]);
      if (keep !== 1) div[t] *= keep;
    }
  }
  // 每張金額：真實期間 = 實際成交價（到分）× 每張股數，四捨五入到 tick（台股 10 元、美股 0.01 美元；手續費卡在 .5 元時捨入方向才不會因為浮點誤差不同）
  const lp = new Float64Array(n);
  const realFrom = opts.useSynthetic === false || a.firstReal === null ? 0 : Math.max(a.firstReal, 0);
  for (let t = 0; t < n; t++) { lp[t] = px[t] * lot[t]; if (t >= realFrom && a.firstReal !== null && !Number.isNaN(lp[t])) lp[t] = Math.floor(lp[t] / M.tick + 0.5) * M.tick; }
  const out = { px, lot, lp, div };
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
  // lp = 每張金額、lot = 每張股數（現在的股）；張數 = 股數 ÷ 每張股數，一定是整數
  lots(lot) { return Math.round(this.shares / lot); }
  buyLots(n, lp, lot) {
    if (n <= 0) return false;
    const gross = n * lp;
    this.cash -= gross + this.cost.buy(gross, this.kind); this.shares += n * lot;
    return true;
  }
  buyMax(budget, lp, lot) { return this.buyLots(this.maxLots(budget, lp), lp, lot); }
  sellLots(n, lp, lot) {
    if (n <= 0) return false;
    const gross = n * lp;
    this.cash += gross - this.cost.sell(gross, this.kind); this.shares -= n * lot;
    return true;
  }
  sellAll(lp, lot) { const ok = this.sellLots(this.lots(lot), lp, lot); this.shares = 0; return ok; }
  value(lp, lot) { return this.cash + this.lots(lot) * lp; }
  finalValue(lp, lot) {                  // 期末全部賣出後的金額
    const n = this.lots(lot);
    if (n <= 0) return this.cash;
    const gross = n * lp;
    return this.cash + gross - this.cost.sell(gross, this.kind);
  }
}

// 買進持有（整張）：期初買最多張數；除息那天現金夠一張就再投入；期末賣出
function bhPath(data, code, si, ei, opts) {
  const { capital = data.market.capital, cost = costFor(data) } = opts;
  const a = data.assets[code], eq = new Float64Array(ei - si + 1);
  if (a.kind === 'index') {               // 大盤不能交易：照指數算、不扣成本
    const r = returnsFor(data, code, opts);
    eq[0] = capital;
    for (let i = si + 1; i <= ei; i++) eq[i - si] = eq[i - si - 1] * (1 + r[i]);
    return { eq, lots0: null };
  }
  const { lp, lot, div } = lotSeries(data, code, opts);
  const acct = new LotAccount(capital, cost, a.kind);
  acct.buyMax(acct.cash, lp[si], lot[si]);
  const lots0 = acct.lots(lot[si]);
  eq[0] = acct.value(lp[si], lot[si]);
  for (let t = si + 1; t <= ei; t++) {
    if (div[t] !== 0) {
      acct.cash += acct.shares * div[t];
      if (!a.halt.has(t)) acct.buyMax(acct.cash, lp[t], lot[t]);
    }
    eq[t - si] = acct.value(lp[t], lot[t]);
  }
  eq[eq.length - 1] = acct.finalValue(lp[ei], lot[ei]);
  return { eq, lots0, lotPrice: lp[si] };
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

// 回撤與套牢期（水下期），同 metrics.py 的 underwater()：
// 套牢 = 從前高（跌之前最後一天在最高點）到淨值回到 ≥ 前高的那天；期末還沒回到前高就算到期末（recovery = null）
// 回傳 {mdd, top, trough, recovery, longest}（都是陣列位置）；longest = 最長的一次 {depth, top, trough, recovery, years}，一樣長取最早那次
export function underwater(eq, dayIdx) {
  const n = eq.length, eps = [];
  let peakAt = 0, lowAt = 0, under = false;
  for (let i = 1; i < n; i++) {
    if (eq[i] >= eq[peakAt]) {
      if (under) { eps.push([peakAt, lowAt, i]); under = false; }
      peakAt = i;                            // 一樣高也往後移：高點 = 開始下跌前的最後一天
    } else if (!under || eq[i] < eq[lowAt]) { lowAt = i; under = true; }
  }
  if (under) eps.push([peakAt, lowAt, null]);
  const out = { mdd: 0, top: 0, trough: 0, recovery: 0, longest: null };
  for (const [t, lo, r] of eps) {
    const depth = eq[lo] / eq[t] - 1;
    if (depth < out.mdd) Object.assign(out, { mdd: depth, top: t, trough: lo, recovery: r });
    const years = (dayIdx[r ?? n - 1] - dayIdx[t]) / 365.25;
    if (!out.longest || years > out.longest.years) out.longest = { depth, top: t, trough: lo, recovery: r, years };
  }
  return out;
}
// 最長套牢（年）與它到期末是不是還沒結束，定義同 underwater()；t = 每個點的時間（年，遞增）。
// 蒙地卡羅的模擬行情沒有日期，用這個（t = 累積經過的日曆年數）。同 metrics.py 的 longest_uw()
export function longestUw(eq, t) {
  let peak = eq[0], peakT = t[0], under = false, best = 0, open = false;
  for (let i = 1; i < eq.length; i++) {
    if (eq[i] >= peak) {
      if (under) { if (t[i] - peakT > best) best = t[i] - peakT; under = false; }
      peak = eq[i]; peakT = t[i];
    } else under = true;
  }
  if (under && t[t.length - 1] - peakT > best) { best = t[t.length - 1] - peakT; open = true; }   // 一樣長取最早那次
  return { uw: best, uwOpen: open };
}
// 多區間用：最長套牢幾年、到期末是不是還沒回到前高
export function uwStats(eq, dayIdx) {
  const lg = underwater(eq, dayIdx).longest;
  return { uw: lg ? lg.years : 0, uwOpen: !!(lg && lg.recovery === null) };
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
  const dd = underwater(eq, dayIdx), lg = dd.longest;
  const yrs = (a, b) => (dayIdx[b] - dayIdx[a]) / 365.25;
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
    mddFall: yrs(dd.top, dd.trough), mddRecover: yrs(dd.trough, dd.recovery ?? n - 1),
    uw: lg ? lg.years : 0, uwOpen: !!(lg && lg.recovery === null),
    uwTop: lg ? dayToIso(dayIdx[lg.top]) : null, uwEnd: lg && lg.recovery !== null ? dayToIso(dayIdx[lg.recovery]) : null,
    uwDepth: lg ? lg.depth : 0,
    calmar: dd.mdd < 0 ? cagr / Math.abs(dd.mdd) : NaN,
    bestYear: Math.max(...yearly), worstYear: Math.min(...yearly),
    yearly: yearEnd.map((p, k) => ({ year: p.y, ret: yearly[k] })),
    final: eq[n - 1],
  };
}

// ---------- 自訂區間 ----------
export function period(data, codes, startIso, endIso, opts) {
  const { capital = data.market.capital, cost = costFor(data) } = opts;
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
  const { capital = data.market.capital } = opts;
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
    mdd, vol: std(daily) * Math.sqrt(daily.length / years), ...uwStats(eq, data.days.subarray(si, ei + 1)),
    syntheticShare: syn / (ei - si + 1),
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
  2: { maFast: 120, maSlow: 240, exitBuffer: 0.90, recoverSlope: 1.001, recoverStrong: 1.02, pyramidGap: 0.15, pyramidLevels: 2 },
  1: { maFast: 100, maSlow: 200, exitBuffer: 0.925, recoverSlope: 1.001, recoverStrong: 1.02, pyramidGap: 0.15, pyramidLevels: 1 },
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
  const key = [data.market.id, code, opts.useSynthetic !== false, opts.tw50Excess !== false, opts.signalPrice || 'raw', JSON.stringify(p)].join('|');
  if (prepCache.has(key)) return prepCache.get(key);
  const out = trendPrepRaw(data, code, opts, p);
  if (prepCache.size >= 20) prepCache.delete(prepCache.keys().next().value);   // 最多留 20 份（改參數很多次也不會一直吃記憶體）
  prepCache.set(key, out);
  return out;
}
// 不進快取（參數掃描一次幾十組，放進去會把平常用的擠掉）
function trendPrepRaw(data, code, opts, p) {
  const r = returnsFor(data, code, opts), sr = signalReturnsFor(data, code, opts);
  let first = -1;
  for (let i = 0; i < r.length; i++) if (!Number.isNaN(r[i])) { first = i; break; }
  if (first < 1) return null;
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
  return { i0, minSi, price, act, status, layers };
}

function trendSim(data, code, prep, p, si, ei, opts, keepEvents) {
  const { capital = data.market.capital, cost = costFor(data) } = opts;
  const kind = data.assets[code].kind, halt = data.assets[code].halt;
  const { i0, act, status, layers } = prep;
  const { lp: LP, lot: LOTS, div: DIV } = lotSeries(data, code, opts);
  const acct = new LotAccount(capital, cost, kind);
  const j0 = si - i0, st0 = status[j0], k0 = layers[j0];
  let cashAtExit = capital;
  if (st0 === STATUS.HOLD) acct.buyMax(acct.cash, LP[si], LOTS[si]);
  else if (st0 === STATUS.WAIT && k0 > 0) acct.buyMax(cashAtExit * k0 / p.pyramidLevels, LP[si], LOTS[si]);
  const eq = new Float64Array(ei - si + 1);
  eq[0] = acct.value(LP[si], LOTS[si]);
  const events = [];
  let peak = eq[0], mdd = 0, inMarket = acct.shares > 0 ? 1 : 0;
  for (let t = si + 1; t <= ei; t++) {
    const j = t - i0, a = act[j], lp = LP[t], lot = LOTS[t];
    if (DIV[t] !== 0) acct.cash += acct.shares * DIV[t];          // 配息發現金
    if (a === ACT.RECOVER) acct.buyMax(acct.cash, lp, lot);
    else if (a === ACT.ADD) acct.buyMax(cashAtExit / p.pyramidLevels, lp, lot);
    else if (a === ACT.EXIT) { acct.sellAll(lp, lot); cashAtExit = acct.cash; }
    else if (DIV[t] !== 0 && status[j] === STATUS.HOLD && !halt.has(t)) acct.buyMax(acct.cash, lp, lot);   // 續抱中配息再投入
    const v = acct.value(lp, lot);
    if (a && keepEvents) events.push({ i: t, act: a, layer: layers[j], value: v, price: lp / data.market.lot, lots: acct.lots(lot) });
    eq[t - si] = v;
    if (acct.shares > 0) inMarket++;
  }
  eq[eq.length - 1] = acct.finalValue(LP[ei], LOTS[ei]);
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
  for (const code of codes.filter(c => data.assets[c].kind !== 'index')) {
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
  codes = codes.filter(c => data.assets[c].kind !== 'index');
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
      const net = sim.eq[sim.eq.length - 1] / (opts.capital ?? data.market.capital);
      rows.push({
        code: c, start: bh.start, end: bh.end, years: bh.years,
        total: net - 1, cagr: net > 0 ? net ** (1 / bh.years) - 1 : -1, mdd: sim.mdd,
        ...uwStats(sim.eq, data.days.subarray(si, ei + 1)),
        bhTotal: bh.total, bhCagr: bh.cagr, bhMdd: bh.mdd, bhUw: bh.uw, bhUwOpen: bh.uwOpen, syntheticShare: bh.syntheticShare,
      });
    }
  }
  return rows;
}

// ====================== 參數穩健性檢查 ======================
// 跟 twbt/backtest/robust.py 同一套：兩個參數各取一排值（其他照目前設定），每一組從同一天開始各跑一條淨值，
// 各段績效從這條淨值切出來（不含每段期初買、期末賣的成本）。
export const ROBUST_GRIDS = {
  exit: { label: '快線 × 出場乘數', names: ['maFast', 'exitBuffer'],
    2: [[60, 80, 100, 120, 150, 180, 240], [0.85, 0.875, 0.90, 0.925, 0.95, 0.97]],
    1: [[50, 70, 100, 130, 160, 200], [0.90, 0.925, 0.95, 0.97, 0.98, 1.0]] },
  pyramid: { label: '接刀間距 × 層數', names: ['pyramidGap', 'pyramidLevels'],
    2: [[0.05, 0.10, 0.15, 0.20, 0.25, 0.30], [1, 2, 3, 4]], 1: [[0.05, 0.10, 0.15, 0.20, 0.25, 0.30], [1, 2, 3, 4]] },
  recover: { label: '轉回斜率 × 強反彈', names: ['recoverSlope', 'recoverStrong'],
    2: [[1.0, 1.001, 1.002, 1.004, 1.006], [1.01, 1.02, 1.03, 1.05, 1.08, 1.12]],
    1: [[1.0, 1.001, 1.002, 1.004, 1.006], [1.01, 1.02, 1.03, 1.05, 1.08, 1.12]] },
};

export function paramSweep(data, code, opts, custom, gridKey) {
  const g = ROBUST_GRIDS[gridKey], lev = LEVERAGE[code] >= 2 ? 2 : 1;
  const [xs, ys] = g[lev], names = g.names;
  const base = trendParamsFor(code, custom);
  const combos = xs.flatMap(x => ys.map(y => ({ [names[0]]: x, [names[1]]: y })));
  const preps = combos.map(c => trendPrepRaw(data, code, opts, { ...base, ...c }));
  if (preps.some(p => !p)) throw new Error(`${data.assets[code].name} 沒有資料`);
  const n = data.days.length, si = Math.max(...preps.map(p => p.minSi)), ei = n - 1;
  if (!Number.isFinite(si) || ei - si < 250) throw new Error(`${data.assets[code].name} 均線算得出來之後不到一年`);
  const days = data.days.subarray(si, ei + 1);
  const t = Float64Array.from(days, d => (d - days[0]) / 365.25);
  const eq = [], trades = [];
  combos.forEach((c, k) => {
    const p = { ...base, ...c }, pr = preps[k];
    eq.push(trendSim(data, code, pr, p, si, ei, opts, false).eq);
    let m = 0; for (let j = si + 1 - pr.i0; j <= ei - pr.i0; j++) if (pr.act[j]) m++;
    trades.push(m);
  });
  const def = combos.findIndex(c => names.every(k => Math.abs(base[k] - c[k]) <= 1e-8 + 1e-5 * Math.abs(c[k])));   // 同 np.isclose
  return { code, gridKey, names, xs, ys, combos, base, si, ei, days, t, eq, trades, bh: bhPath(data, code, si, ei, opts).eq, def };
}

function swCagr(sw, eq, a, b) {
  const net = eq[b] / eq[a];
  return net > 0 ? net ** (1 / (sw.t[b] - sw.t[a])) - 1 : -1;
}
function swStats(sw, eq, a, b) {
  const x = eq.subarray(a, b + 1);
  let peak = x[0], mdd = 0;
  for (const v of x) { if (v > peak) peak = v; const d = v / peak - 1; if (d < mdd) mdd = d; }
  const cagr = swCagr(sw, eq, a, b);
  return { cagr, mdd, calmar: mdd < 0 ? cagr / -mdd : NaN, uw: longestUw(x, sw.t.subarray(a, b + 1)).uw };
}
// 起訖日（ISO，可省略）→ 陣列位置，同 robust.py 的 _pos()
function swPos(sw, startIso, endIso) {
  const a = startIso ? lowerBound(sw.days, isoToDay(startIso)) : 0;
  const b = endIso ? lowerBound(sw.days, isoToDay(endIso) + 1) - 1 : sw.days.length - 1;
  if (b - a < 20) throw new Error(`${startIso ?? ''} ~ ${endIso ?? ''} 太短`);
  return [a, b];
}
function swRoll(sw, a, b, years) {
  const L = Math.round(years * 12), out = [];
  const t0 = new Date(sw.days[a] * DAY_MS);
  for (let s = Date.UTC(t0.getUTCFullYear(), t0.getUTCMonth(), 1) / DAY_MS; addMonths(s, L) <= sw.days[b]; s = addMonths(s, 1)) {
    const i = Math.max(a, lowerBound(sw.days, s)), j = lowerBound(sw.days, addMonths(s, L) + 1) - 1;
    if (j - i >= 20) out.push([i, j]);
  }
  return out;
}

// 每組一列：年化、最大回撤、報酬回撤比、最長套牢、年化差；rollYears：這段期間所有 N 年區間贏買進持有的比例、年化差中位數、最差的 N 年
export function sweepTable(sw, startIso, endIso, rollYears = 10) {
  const [a, b] = swPos(sw, startIso, endIso);
  const wins = rollYears ? swRoll(sw, a, b, rollYears) : [];
  const bh = swStats(sw, sw.bh, a, b);
  const bhRoll = wins.map(([s, e]) => swCagr(sw, sw.bh, s, e));
  const full = !startIso && !endIso;
  const rows = sw.combos.map((c, i) => {
    const r = { ...c, ...swStats(sw, sw.eq[i], a, b), isDef: i === sw.def };
    r.diff = r.cagr - bh.cagr;
    if (full) r.trades = sw.trades[i];
    if (wins.length) {
      const st = wins.map(([s, e]) => swCagr(sw, sw.eq[i], s, e)), d = st.map((v, k) => v - bhRoll[k]);
      r.rollWin = d.filter(v => v > 0).length / d.length;
      r.rollDiff = quantile([...d].sort((x, y) => x - y), 0.5);
      r.rollWorst = Math.min(...st);
    }
    return r;
  });
  return { rows, start: dayToIso(sw.days[a]), end: dayToIso(sw.days[b]), bh, windows: wins.length, a, b };
}

const argmax = v => { let k = -1; v.forEach((x, i) => { if (!Number.isNaN(x) && (k < 0 || x > v[k])) k = i; }); return k; };
function ranks(v) {              // 由大到小排名，一樣大取平均、NaN 不排（同 pandas rank(ascending=False)）
  const idx = v.map((x, i) => i).filter(i => !Number.isNaN(v[i])).sort((i, j) => v[j] - v[i]), out = new Array(v.length).fill(NaN);
  for (let s = 0; s < idx.length;) {
    let e = s; while (e + 1 < idx.length && v[idx[e + 1]] === v[idx[s]]) e++;
    for (let k = s; k <= e; k++) out[idx[k]] = (s + e) / 2 + 1;
    s = e + 1;
  }
  return out;
}
function pearson(x0, y0) {       // 只用兩邊都有數字的組合（同 pandas corr）
  const k = x0.map((_, i) => i).filter(i => !Number.isNaN(x0[i]) && !Number.isNaN(y0[i]));
  const x = k.map(i => x0[i]), y = k.map(i => y0[i]);
  const mx = mean(x), my = mean(y);
  let sxy = 0, sx = 0, sy = 0;
  for (let i = 0; i < x.length; i++) { sxy += (x[i] - mx) * (y[i] - my); sx += (x[i] - mx) ** 2; sy += (y[i] - my) ** 2; }
  return sxy / Math.sqrt(sx * sy);
}

// 樣本內外：分界前一天以前挑參數、分界以後驗證
export function sweepSplit(sw, splitIso, objective = 'cagr') {
  const ins = sweepTable(sw, null, dayToIso(isoToDay(splitIso) - 1), 0), oos = sweepTable(sw, splitIso, null, 0);
  const vin = ins.rows.map(r => r[objective]), vout = oos.rows.map(r => r[objective]);
  const rIn = ranks(vin), rOut = ranks(vout), best = argmax(vin);
  return { ins, oos, objective, corr: pearson(rIn, rOut), best, bestRank: Math.trunc(rOut[best]),
    defRank: sw.def >= 0 ? Math.trunc(rOut[sw.def]) : null, rIn, rOut };
}

// 建議參數：每一格跟上下左右鄰居（共 5 格）的平均最高的那組，只從不在邊緣的格子裡選（同 robust.py 的 suggest()）
export function sweepSuggest(sw, rows, key) {
  const nx = sw.xs.length, ny = sw.ys.length, v = rows.map(r => r[key]);
  const cells = [];
  for (let x = 1; x < nx - 1; x++) for (let y = 1; y < ny - 1; y++) cells.push([x, y]);
  if (!cells.length) for (let x = 0; x < nx; x++) for (let y = 0; y < ny; y++) cells.push([x, y]);
  let best = null;
  for (const [x, y] of cells) {
    const nb = [];
    for (const [a, b] of [[x, y], [x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]])
      if (a >= 0 && a < nx && b >= 0 && b < ny && !Number.isNaN(v[a * ny + b])) nb.push(v[a * ny + b]);
    if (!nb.length) continue;
    const score = nb.reduce((s, z) => s + z, 0) / nb.length;
    if (!best || score > best.score) best = { i: x * ny + y, score, worst: Math.min(...nb) };
  }
  return best;
}

// walk-forward：從 firstIso 起每 stepYears 年用之前全部歷史重挑一次參數，接下來 stepYears 年照用
// pick：'best' = 挑最高的那組；'plateau' = 挑高原中間（sweepSuggest）
export function sweepWalkForward(sw, firstIso, stepYears = 5, objective = 'cagr', pick = 'best') {
  const d = sw.days, n = d.length, t0 = isoToDay(firstIso);
  if (t0 <= addMonths(d[0], 36)) throw new Error(`第一次挑參數前至少要 3 年歷史（策略從 ${dayToIso(d[0])} 開始）`);
  const step = Math.round(stepYears * 12), a0 = lowerBound(d, t0);
  const wf = new Float64Array(n - a0), blocks = [];
  wf[0] = 1;
  let cur = t0;
  for (;;) {
    const a = lowerBound(d, cur);
    if (a >= n - 1) break;
    const b = Math.min(n - 1, lowerBound(d, addMonths(cur, step)));
    const ins = sweepTable(sw, null, dayToIso(d[a - 1]), 0);
    const k = pick === 'best' ? argmax(ins.rows.map(r => r[objective])) : sweepSuggest(sw, ins.rows, objective).i;
    for (let i = a; i <= b; i++) wf[i - a0] = wf[a - a0] * sw.eq[k][i] / sw.eq[k][a];
    blocks.push({ start: dayToIso(d[a]), end: dayToIso(d[b]), k, combo: sw.combos[k], isDef: k === sw.def,
      cagr: swCagr(sw, sw.eq[k], a, b), defCagr: sw.def >= 0 ? swCagr(sw, sw.eq[sw.def], a, b) : NaN, bhCagr: swCagr(sw, sw.bh, a, b) });
    if (b >= n - 1) break;
    cur = d[b];
  }
  const norm = eq => Float64Array.from(eq.subarray(a0), v => v / eq[a0]);
  const curves = { wf, ...(sw.def >= 0 ? { def: norm(sw.eq[sw.def]) } : {}), bh: norm(sw.bh) };
  const tt = sw.t.subarray(a0), summary = {};
  for (const [k, x] of Object.entries(curves)) {
    let peak = x[0], mdd = 0;
    for (const v of x) { if (v > peak) peak = v; const dd = v / peak - 1; if (dd < mdd) mdd = dd; }
    const cagr = x[x.length - 1] ** (1 / (tt[tt.length - 1] - tt[0])) - 1;
    summary[k] = { cagr, mdd, calmar: mdd < 0 ? cagr / -mdd : NaN, uw: longestUw(x, tt).uw };
  }
  return { blocks, curves, days: d.subarray(a0), summary };
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
    lot: data.market.lot, keep: 1 - data.assets[code].divTax,
    from: first > 0 ? dayToIso(data.days[first]) : '－', to: dayToIso(data.days[data.days.length - 1]) };
}

// 模擬路徑的每股價格與配息：從現在的每股價格出發、一張 lot 股（台股 1000、美股 1）、沒有分割（跟 montecarlo.py 的 path_prices 一樣）
// keep：配息扣掉預扣稅後實際入帳的比例
function pathPrices(r, q, px0, keep = 1) {
  const n = r.length + 1, px = new Float64Array(n), div = new Float64Array(n);
  px[0] = px0;
  for (let j = 1; j < n; j++) {
    px[j] = px[j - 1] * (1 + q[j - 1]);
    if (r[j - 1] !== q[j - 1]) { div[j] = px[j - 1] * (r[j - 1] - q[j - 1]) / (1 + r[j - 1]); if (keep !== 1) div[j] *= keep; }
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
  const { px, div } = pathPrices(rr, qq, src.px0, src.keep);
  const { act, status } = signals(spx, p);
  const LOT = src.lot;
  const acct = new LotAccount(capital, cost, kind);
  let cashAtExit = capital, trades = 0;
  let peak = capital, mdd = 0, v = capital;
  const T = new Float64Array(n - warm), se = new Float64Array(n - warm), be = new Float64Array(n - warm);   // 累積日曆年數、每天淨值
  for (let t = warm + 1; t < n; t++) T[t - warm] = T[t - warm - 1] + src.dt[idx[t - 1]];
  se[0] = capital;
  for (let t = warm + 1; t < n; t++) {
    const a = act[t];
    if (div[t] !== 0) acct.cash += acct.shares * div[t];
    const lp = px[t] * LOT;
    if (a === ACT.RECOVER) { acct.buyMax(acct.cash, lp, LOT); trades++; }
    else if (a === ACT.ADD) { acct.buyMax(cashAtExit / p.pyramidLevels, lp, LOT); trades++; }
    else if (a === ACT.EXIT) { acct.sellAll(lp, LOT); cashAtExit = acct.cash; trades++; }
    else if (div[t] !== 0 && status[t] === STATUS.HOLD) acct.buyMax(acct.cash, lp, LOT);
    v = t === n - 1 ? acct.finalValue(lp, LOT) : acct.value(lp, LOT);
    se[t - warm] = v;
    if (v > peak) peak = v; else if (v / peak - 1 < mdd) mdd = v / peak - 1;
  }
  const b = new LotAccount(capital, cost, kind);
  b.buyMax(b.cash, px[warm] * LOT, LOT);
  let bv = b.value(px[warm] * LOT, LOT), bpeak = bv, bmdd = 0;
  be[0] = bv;
  for (let t = warm + 1; t < n; t++) {
    if (div[t] !== 0) { b.cash += b.shares * div[t]; b.buyMax(b.cash, px[t] * LOT, LOT); }
    bv = t === n - 1 ? b.finalValue(px[t] * LOT, LOT) : b.value(px[t] * LOT, LOT);
    be[t - warm] = bv;
    if (bv > bpeak) bpeak = bv; else if (bv / bpeak - 1 < bmdd) bmdd = bv / bpeak - 1;
  }
  const cg = x => (x > 0 ? x ** (1 / years) - 1 : -1);
  const su = longestUw(se, T), bu = longestUw(be, T);
  return { cagr: cg(v / capital), mdd, bhCagr: cg(bv / capital), bhMdd: bmdd, trades,
    uw: su.uw, uwOpen: su.uwOpen, bhUw: bu.uw, bhUwOpen: bu.uwOpen };
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
  const cost = opts.cost ?? costFor(data), capital = opts.capital ?? data.market.capital, kind = data.assets[code].kind;
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
    uw50: q(rows.map(r => r.uw), 0.5), bhUw50: q(rows.map(r => r.bhUw), 0.5),
    uw95: q(rows.map(r => r.uw), 0.95), bhUw95: q(rows.map(r => r.bhUw), 0.95),
    uwBetter: share(r => r.uw < r.bhUw),
    loss: share(r => r.cagr < 0), bhLoss: share(r => r.bhCagr < 0),
    trades: rows.reduce((a, r) => a + r.trades, 0) / n,
  };
}

// ====================== 再平衡策略 ======================
// 跟 twbt/backtest/rebalance.py 逐行對應。cfg = {weights: {code: w, CASH: w}, freq: 'none'|'M'|'Q'|'H'|'Y', band, cashRate, trend}
export const REBAL_ASSETS = ['0050', '00631L', '00675L'];      // 台股；美股見 data.market.rebal
const LEVERAGED = { has: c => (LEVERAGE[c] ?? 1) >= 2 };            // 正2（均線訊號只管這些）
// 再平衡時單筆不到 data.market.minTrade（台股 1,000 元、美股 30 美元）就不交易（跟 Python 版一樣）
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
    LP: Object.fromEntries(codes.map(c => [c, L[c].lp])), LOTS: Object.fromEntries(codes.map(c => [c, L[c].lot])),
    DIV: Object.fromEntries(codes.map(c => [c, L[c].div])) };
}

function rebalSim(data, ctx, cfg, si, ei, opts, keepLog) {
  const { w, codes, preps, LP, LOTS, DIV } = ctx;
  const keyAt = ctx.keyAt ?? (t => periodKey(data.days[t], cfg.freq));
  const cost = opts.cost ?? costFor(data), capital = opts.capital ?? data.market.capital, MIN_TRADE = data.market.minTrade;
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
  const hold = c => acct[c].lots(LOTS[c][curT]) * LP[c][curT];
  const total = () => { let v = cash; for (const c of codes) v += hold(c); return v; };
  // 暫停交易（分割）的日子不能買賣：定期再平衡先跳過那一檔，下次檢查再調（模擬路徑沒有暫停交易日）
  const halted = c => !ctx.dt && data.assets[c].halt.has(curT);
  // smallOk：期初建立部位、均線訊號的進出不受 MIN_TRADE 限制；目標 0（出場）一定全部賣掉
  const tradeTo = (tw, only, smallOk) => {
    const V = total(), sel = only ? [only] : codes.filter(c => smallOk || !halted(c));
    const want = {};
    for (const c of sel) want[c] = tw[c] === 0 ? 0 : Math.floor(tw[c] * V / LP[c][curT] + 0.5);   // 最接近目標的張數
    for (const c of sel) {                                    // 先賣
      const a = acct[c], lot = LOTS[c][curT], lp = LP[c][curT], have = a.lots(lot);
      if (have > want[c]) {
        if ((have - want[c]) * lp < MIN_TRADE && !(smallOk || tw[c] === 0)) continue;
        a.cash = 0; a.sellLots(have - want[c], lp, lot);
        cash += a.cash; trades++;
      }
    }
    for (const c of sel) {                                    // 再用現金買
      const a = acct[c], lot = LOTS[c][curT], lp = LP[c][curT], have = a.lots(lot);
      if (have < want[c]) {
        a.cash = cash;
        const n = Math.min(want[c] - have, a.maxLots(cash, lp));
        if (n <= 0 || (n * lp < MIN_TRADE && !smallOk)) continue;
        a.buyLots(n, lp, lot);
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
  const lotPrice = Object.fromEntries(ctx.codes.map(c => [c, ctx.LP[c][si]]));
  return { si, ei, dayIdx, shifted, main, flat, lotPrice, exposure: exposureOf(cfg.weights),
    stats: summarize(main.eq, dayIdx), flatStats: summarize(flat.eq, dayIdx) };
}

export function rebalWindows(data, cfg, wins, opts, custom) {
  const ctx = rebalCtx(data, cfg, opts, custom);
  const flatCfg = { ...cfg, freq: 'none', band: 0 };
  const capital = opts.capital ?? data.market.capital, rows = [];
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
      const u = uwStats(eq, data.days.subarray(si, ei + 1));
      row[name ? 'flatUw' : 'uw'] = u.uw; row[name ? 'flatUwOpen' : 'uwOpen'] = u.uwOpen;
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
  const { base, lev } = data.market;
  const need = new Set([...codes, base, lev]);                  // 對照組要用到 0050、00631L（美股 QQQ、QLD）
  const src = srcIn ?? Object.fromEntries([...need].map(c => [c, { r: returnsFor(data, c, opts), s: signalReturnsFor(data, c, opts), q: priceReturnsFor(data, c, opts) }]));
  const n = idx.length + 1;
  const R = {}, preps = {}, kind = {}, LP = {}, LOTS = {}, DIV = {};
  const dtp = new Float64Array(n);
  let years = 0;
  for (let j = 1; j < n; j++) { dtp[j] = data.dt[idx[j - 1]]; if (j > warm) years += dtp[j]; }   // 實際經過的日曆時間
  for (const c of need) {
    const r = new Float64Array(n), spx = new Float64Array(n);
    spx[0] = 1;
    const q = new Float64Array(n - 1);
    for (let j = 1; j < n; j++) { r[j] = src[c].r[idx[j - 1]]; q[j - 1] = src[c].q[idx[j - 1]]; spx[j] = spx[j - 1] * (1 + src[c].s[idx[j - 1]]); }
    R[c] = r; kind[c] = data.assets[c].kind;
    const pp = pathPrices(r.subarray(1), q, data.assets[c].pxLast ?? 1, 1 - data.assets[c].divTax), U = data.market.lot;
    LP[c] = pp.px.map(x => x * U); DIV[c] = pp.div; LOTS[c] = new Float64Array(n).fill(U);
    if (LEVERAGED.has(c)) {
      const p = trendParamsFor(c, custom), sig = signals(spx, p);
      preps[c] = { prep: { i0: 0, ...sig }, levels: p.pyramidLevels, p };
    }
  }
  const fd = FREQ_DAYS[cfg.freq];
  const mk = (cf, cs) => ({ w: normWeights(cf.weights), codes: cs, R, kind, dt: dtp, LP, LOTS, DIV,
    preps: cf.trend ? Object.fromEntries(cs.filter(c => preps[c]).map(c => [c, preps[c]])) : {},
    keyAt: t => (fd ? Math.floor((t - warm) / fd) : null) });
  const ei = n - 1, capital = opts.capital ?? data.market.capital;
  const T = new Float64Array(n - warm);                         // 從 warm 起累積的日曆年數
  for (let j = warm + 1; j < n; j++) T[j - warm] = T[j - warm - 1] + dtp[j];
  const res = eq => {
    let peak = eq[0], mdd = 0;
    for (const v of eq) { if (v > peak) peak = v; const d = v / peak - 1; if (d < mdd) mdd = d; }
    const net = eq[eq.length - 1] / capital;
    return { cagr: net > 0 ? net ** (1 / years) - 1 : -1, mdd, uw: longestUw(eq, T).uw };
  };
  const main = res(rebalSim(data, mk(cfg, codes), cfg, warm, ei, opts, false).eq);
  const flatCfg = { ...cfg, freq: 'none', band: 0 };
  const flat = res(rebalSim(data, mk(flatCfg, codes), flatCfg, warm, ei, opts, false).eq);
  const bhCfg = { weights: { [base]: 1 }, freq: 'none', band: 0, cashRate: 0, trend: false };
  const bh = res(rebalSim(data, mk(bhCfg, [base]), bhCfg, warm, ei, opts, false).eq);
  const trCfg = { weights: { [lev]: 1 }, freq: 'none', band: 0, cashRate: 0, trend: true };
  const tr = res(rebalSim(data, mk(trCfg, [lev]), trCfg, warm, ei, opts, false).eq);
  const out = { cagr: main.cagr, mdd: main.mdd, uw: main.uw, flatCagr: flat.cagr, flatMdd: flat.mdd, flatUw: flat.uw,
    bhCagr: bh.cagr, bhMdd: bh.mdd, bhUw: bh.uw, trCagr: tr.cagr, trMdd: tr.mdd, trUw: tr.uw };
  if (cfg.trend && codes.some(c => LEVERAGED.has(c))) {          // 同配置、同規則、不搭配均線
    const ntCfg = { ...cfg, trend: false };
    const nt = res(rebalSim(data, mk(ntCfg, codes), ntCfg, warm, ei, opts, false).eq);
    out.noTrCagr = nt.cagr; out.noTrMdd = nt.mdd; out.noTrUw = nt.uw;
  }
  return out;
}

export async function rebalMonteCarlo(data, cfg, opts, custom, { n = 1000, years = 10, block = 120, seed = 1, chunk = 25 } = {}, onProgress) {
  const w = normWeights(cfg.weights);
  const codes = [...new Set([...Object.keys(w).filter(k => k !== 'CASH'), data.market.base, data.market.lev])];
  // 可抽樣的日子：每一檔都有資料
  const rs = codes.map(c => [returnsFor(data, c, opts), signalReturnsFor(data, c, opts), priceReturnsFor(data, c, opts)]);
  const src = Object.fromEntries(codes.map((c, i) => [c, { r: rs[i][0], s: rs[i][1], q: rs[i][2] }]));
  const ok = [];
  for (let i = 0; i < data.days.length; i++) if (rs.every(([r, s, q]) => !Number.isNaN(r[i]) && !Number.isNaN(s[i]) && !Number.isNaN(q[i]))) ok.push(i);
  if (ok.length < 600) throw new Error('可抽樣的資料太少');
  const warm = Math.max(...data.market.rebal.filter(c => LEVERAGED.has(c)).map(c => { const p = trendParamsFor(c, custom); return Math.max(p.maFast, p.maSlow); })) - 1;
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
