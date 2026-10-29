// 介面：讀設定 → 呼叫 engine.js 計算 → 畫結果
import * as E from './engine.js?v=6b95a6a2dc';
import { LineChart, ScatterChart } from './plot.js?v=6b95a6a2dc';

// 版本號：tools/stamp_version.py 自動蓋上（日期 · 程式內容的 hash，跟 finance-app 一樣不手動編號）
const BUILD_HASH = '6b95a6a2dc';
const BUILD_DATE = '2026-10-29';

const ORDER = ['TAIEX', '0050', '00631L', '00675L'];
const LABEL = { TAIEX: '大盤（含息）', '0050': '0050', '00631L': '00631L 台灣50正2', '00675L': '00675L 加權正2' };
const SHORT = { TAIEX: '大盤', '0050': '0050', '00631L': '00631L', '00675L': '00675L' };
const DAY_MS = 86400000;
const STORE_KEY = 'twbt.settings.v1';

const $ = id => document.getElementById(id);
const MC_MAX = 20000;   // 蒙地卡羅最多幾條
const state = {
  mode: 'period', assets: new Set(ORDER), capital: 1_000_000, discount: 1, useSyn: true, excess: true,
  start: '2000-01-01', end: '', rollYears: 10, rndN: 500, rndMin: 5, rndMax: 15, seed: 42,
  metric: 'cagr', log: true,
  strategy: 'bh', trendCustom: { 1: {}, 2: {} }, signalPrice: 'raw', chartAsset: '00631L',
  mcN: 1000, mcYears: 10, mcSeed: 1, mcBlock: 120, mcMetric: 'cagr',
  rbWeights: { '0050': 0, '00631L': 50, '00675L': 0, CASH: 50 }, rbFreq: 'Q', rbBand: 5, rbCash: 1, rbTrend: false,
  robAsset: '00631L', robGrid: 'exit', robObj: 'cagr', robSplit: '2010-01-01', robWfStart: '2000-01-01', robWfStep: 5, robMetric: 'cagr',
};
const DEFAULTS = { ...state, assets: new Set(ORDER), rbWeights: { ...state.rbWeights } };

const RB_PRESETS = [
  ['00631L 50% ＋ 現金', { '0050': 0, '00631L': 50, '00675L': 0, CASH: 50 }],
  ['00631L 65% ＋ 現金（約 1.3 倍）', { '0050': 0, '00631L': 65, '00675L': 0, CASH: 35 }],
  ['0050 50% ＋ 00631L 50%', { '0050': 50, '00631L': 50, '00675L': 0, CASH: 0 }],
];
const RB_NAMES = { '0050': '0050', '00631L': '00631L', '00675L': '00675L', CASH: '現金' };
// 上一次蒙地卡羅結果（設定一樣才顯示）、執行中的代號（換設定就作廢）、執行中那次的設定（設定沒變就不中斷）
let mcLast = null, mcToken = 0, mcRunning = null;
const PARAM_FIELDS = [
  ['maFast', '快線（日）', 1, 2, 500],
  ['maSlow', '慢線（日）', 1, 2, 500],
  ['exitBuffer', '出場乘數', 0.005, 0.5, 1],
  ['pyramidGap', '接刀間距', 0.01, 0.01, 0.6],
  ['pyramidLevels', '接刀層數', 1, 1, 10],
  ['recoverSlope', '轉回斜率門檻', 0.001, 0.98, 1.05],
  ['recoverStrong', '強反彈倍數', 0.005, 1, 1.5],
];
let DATA = null;
const charts = {};

// ---------- 小工具 ----------
// 數字欄位：空白或不是數字 → null（不動）；超出範圍 → 改成最接近的允許值（不再默默忽略）
const clampNum = (raw, lo, hi) => {
  if (String(raw).trim() === '') return null;
  const v = Number(raw); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : null;
};
const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const color = code => css(`--c-${code}`);
function pct(x, d = 1, sign = false) {
  if (x === null || x === undefined || Number.isNaN(x)) return '－';
  const s = (x * 100).toFixed(d) + '%';
  return sign && x > 0 ? '+' + s : s;
}
const money = x => Number.isFinite(x) ? Math.round(x).toLocaleString('zh-TW') : '－';
// 長金額縮寫：1.36 億、8,201 萬（卡片空間小時用）
const moneyShort = x => !Number.isFinite(x) ? '－' : Math.abs(x) >= 1e8 ? (x / 1e8).toFixed(x >= 1e10 ? 0 : x >= 1e9 ? 1 : 2) + ' 億'
  : Math.abs(x) >= 1e4 ? Math.round(x / 1e4).toLocaleString('zh-TW') + ' 萬' : money(x);
// 總報酬很大時改用「幾倍」（期末 ÷ 期初），手機卡片才放得下
const totalShort = x => !Number.isFinite(x) ? '－' : x >= 9.995 ? `${Math.round(1 + x).toLocaleString('zh-TW')} 倍` : pct(x, 0, true);
const num2 = x => Number.isFinite(x) ? x.toFixed(2) : '－';
// 時間長度（年）：不到 1 個月用天、不到 1 年用月，其他用年
const dur = y => !Number.isFinite(y) ? '－' : y < 1 / 12 ? `${Math.round(y * 365.25)} 天` : y < 1 ? `${Math.round(y * 12)} 個月` : `${y.toFixed(1)} 年`;
// 最長套牢：期末還沒回到前高的加「+」（實際只會更長）
const uwShort = s => s.uw > 0 ? dur(s.uw) + (s.uwOpen ? '+' : '') : '沒有';
const UW_HINT = '最長套牢 = 從前高跌下去、到淨值回到前高，花最久的那一次；「+」= 到期末還沒回到前高，實際更長。';
const cls = x => (x > 0 ? 'pos' : x < 0 ? 'neg' : '');
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const yearOf = ms => new Date(ms).getUTCFullYear();
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ ...state, assets: [...state.assets] }));
  } catch (_) { /* 無痕模式等情況：不存也沒關係 */ }
}
function restore() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    if (s) Object.assign(state, s, {
      assets: new Set(s.assets?.length ? s.assets : ORDER),
      trendCustom: { 1: { ...(s.trendCustom?.[1] || {}) }, 2: { ...(s.trendCustom?.[2] || {}) } },
      rbWeights: { '0050': 0, '00631L': 0, '00675L': 0, CASH: 0, ...(s.rbWeights || { '00631L': 50, CASH: 50 }) },
    });
  } catch (_) { /* 忽略 */ }
  sanitize();
}
// 存檔可能是舊版或壞掉的：每個值都檢查，不合法就用預設值、超出範圍就夾到範圍內
function sanitize() {
  const D = DEFAULTS;
  const num = (k, lo, hi, int = false) => {
    const v = Number(state[k]);
    state[k] = Number.isFinite(v) && state[k] !== '' && state[k] !== null && typeof state[k] !== 'boolean' ? Math.min(hi, Math.max(lo, int ? Math.round(v) : v)) : D[k];
  };
  const pick = (k, list) => { if (!list.includes(state[k])) state[k] = D[k]; };
  const bool = k => { if (typeof state[k] !== 'boolean') state[k] = D[k]; };
  num('capital', 1, 1e12, true); pick('discount', [1, 0.6, 0.5, 0.38, 0.28, 0]);
  bool('useSyn'); bool('excess'); bool('log'); bool('rbTrend');
  num('rollYears', 1, 30, true); num('rndN', 10, 5000, true); num('rndMin', 0.5, 30); num('rndMax', 0.5, 30); num('seed', -1e9, 1e9, true);
  num('mcN', 100, MC_MAX, true); num('mcYears', 1, 30, true); num('mcSeed', -1e9, 1e9, true); pick('mcBlock', [1, 20, 60, 120, 250]);
  num('rbBand', 0, 50); num('rbCash', 0, 10);
  pick('strategy', ['bh', 'trend', 'rebal']); pick('mode', ['period', 'rolling', 'random', 'mc', 'robust']);
  pick('robAsset', ['0050', '00631L', '00675L']); pick('robGrid', Object.keys(E.ROBUST_GRIDS)); pick('robObj', ['cagr', 'calmar']);
  pick('robMetric', Object.keys(ROB_METRICS)); num('robWfStep', 1, 10, true);
  pick('signalPrice', ['raw', 'adjusted']); pick('metric', Object.keys(METRICS)); pick('mcMetric', ['cagr', 'mdd', 'total']);
  pick('rbFreq', ['none', 'M', 'Q', 'H', 'Y']); pick('chartAsset', ORDER);
  const okDate = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));
  if (!okDate(state.start)) state.start = D.start;
  if (!okDate(state.robSplit)) state.robSplit = D.robSplit;
  if (!okDate(state.robWfStart)) state.robWfStart = D.robWfStart;
  if (state.end !== '' && !okDate(state.end)) state.end = D.end;
  state.assets = new Set([...state.assets].filter(c => ORDER.includes(c)));
  if (!state.assets.size) state.assets = new Set(ORDER);
  const w = {};
  for (const k of ['0050', '00631L', '00675L', 'CASH']) { const v = Number(state.rbWeights?.[k]); w[k] = Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : 0; }
  state.rbWeights = w;
  for (const lev of [1, 2]) {
    const c = state.trendCustom[lev] || {};
    for (const k of Object.keys(c)) {
      const f = PARAM_FIELDS.find(x => x[0] === k), v = Number(c[k]);
      if (!f || !Number.isFinite(v) || typeof c[k] === 'boolean') { delete c[k]; continue; }
      c[k] = Math.min(f[4], Math.max(f[3], ['maFast', 'maSlow', 'pyramidLevels'].includes(k) ? Math.round(v) : v));
    }
    state.trendCustom[lev] = c;
  }
}

// ---------- 設定表單 ----------
function buildControls() {
  const box = $('assets');
  box.innerHTML = ORDER.map(c => `<button class="chip" type="button" data-code="${c}" aria-pressed="${state.assets.has(c)}" style="color:var(--c-${c})"><span class="dot" style="background:var(--c-${c})"></span><span style="color:var(--text)">${LABEL[c]}</span></button>`).join('');
  box.addEventListener('click', e => {
    const b = e.target.closest('.chip'); if (!b) return;
    const c = b.dataset.code;
    if (state.assets.has(c)) { if (state.assets.size > 1) state.assets.delete(c); } else state.assets.add(c);
    box.querySelectorAll('.chip').forEach(x => x.setAttribute('aria-pressed', state.assets.has(x.dataset.code)));
    changed();
  });

  const last = E.dayToIso(DATA.days[DATA.days.length - 1]);
  const first = E.dayToIso(DATA.days[0]);
  const back = y => { const d = new Date(last); d.setUTCFullYear(d.getUTCFullYear() - y); return d.toISOString().slice(0, 10); };
  const presets = [
    ['全部期間', first, last], ['近 5 年', back(5), last], ['近 10 年', back(10), last],
    ['正2 上市後', '2014-10-31', last], ['1990 崩盤', '1990-01-01', '1991-12-31'],
    ['2000 網路泡沫', '2000-01-01', '2003-12-31'], ['2008 金融海嘯', '2007-06-01', '2010-12-31'],
  ];
  $('presets').innerHTML = presets.map(([t, s, e]) => `<button class="chip" type="button" data-s="${s}" data-e="${e}">${t}</button>`).join('');
  $('presets').addEventListener('click', e => {
    const b = e.target.closest('.chip'); if (!b) return;
    state.start = $('start').value = b.dataset.s; state.end = $('end').value = b.dataset.e; changed();
  });
  $('rollPresets').innerHTML = [3, 5, 10, 15, 20].map(y => `<button class="chip" type="button" data-y="${y}">${y} 年</button>`).join('');
  $('rollPresets').addEventListener('click', e => {
    const b = e.target.closest('.chip'); if (!b) return;
    state.rollYears = +b.dataset.y; $('rollYears').value = b.dataset.y; changed();
  });

  if (!state.end) state.end = last;
  $('start').min = $('end').min = first; $('start').max = $('end').max = last;
  const set = (id, v) => { $(id).value = v; };
  set('capital', money(state.capital)); set('discount', String(state.discount));
  $('useSyn').checked = state.useSyn; $('excess').checked = state.excess;
  set('start', state.start); set('end', state.end); set('rollYears', state.rollYears);
  set('rndN', state.rndN); set('rndMin', state.rndMin); set('rndMax', state.rndMax); set('rndSeed', state.seed);

  $('capital').addEventListener('input', () => {
    const v = Number($('capital').value.replace(/[^\d]/g, ''));
    if (v > 0) { state.capital = v; changed(); }
  });
  $('capital').addEventListener('blur', () => { $('capital').value = money(state.capital); });
  $('discount').addEventListener('change', () => { state.discount = +$('discount').value; changed(); });
  $('useSyn').addEventListener('change', () => { state.useSyn = $('useSyn').checked; changed(); });
  $('excess').addEventListener('change', () => { state.excess = $('excess').checked; changed(); });
  const bindNum = (id, key, lo, hi) => {
    $(id).addEventListener('input', () => { const v = clampNum($(id).value, lo, hi); if (v !== null) { state[key] = v; changed(); } });
    $(id).addEventListener('change', () => { $(id).value = state[key]; });
  };
  // 日期欄位被清空時保留原本的日期（不然開始空白會變成從 1990 年、結束空白會算不出來）
  const okDate = v => /^\d{4}-\d{2}-\d{2}$/.test(v);
  $('start').addEventListener('change', () => { if (okDate($('start').value)) { state.start = $('start').value; changed(); } else $('start').value = state.start; });
  $('end').addEventListener('change', () => { if (okDate($('end').value)) { state.end = $('end').value; changed(); } else $('end').value = state.end; });
  bindNum('rollYears', 'rollYears', 1, 30); bindNum('rndN', 'rndN', 10, 5000);
  bindNum('rndMin', 'rndMin', 0.5, 30); bindNum('rndMax', 'rndMax', 0.5, 30);
  bindNum('rndSeed', 'seed', -1e9, 1e9);
  $('reseed').addEventListener('click', () => {
    state.seed = Math.floor(Math.random() * 100000); $('rndSeed').value = state.seed; changed();
  });

  $('strategySeg').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    state.strategy = b.dataset.s; syncStrategyUI(); changed();
  });
  buildParams();
  $('signalPrice').value = state.signalPrice;
  $('signalPrice').addEventListener('change', () => { state.signalPrice = $('signalPrice').value; changed(); });
  $('resetParams').addEventListener('click', () => {
    state.trendCustom = { 1: {}, 2: {} }; buildParams(); changed();
  });
  buildRebalControls();
  syncStrategyUI();

  // 蒙地卡羅：改設定不自動跑（比較久），按按鈕才跑
  // 超出範圍不再默默忽略：自動改成最接近的允許值，離開欄位時把實際用的數字顯示回去
  for (const [id, key, lo, hi] of [['mcN', 'mcN', 100, MC_MAX], ['mcYears', 'mcYears', 1, 30], ['mcSeed', 'mcSeed', -1e9, 1e9]]) {
    $(id).value = state[key];
    $(id).addEventListener('input', () => {
      const v = clampNum($(id).value, lo, hi); if (v === null) return;
      state[key] = Math.round(v); save(); run();
    });
    $(id).addEventListener('change', () => { $(id).value = state[key]; });
  }
  $('mcBlock').value = String(state.mcBlock);
  $('mcBlock').addEventListener('change', () => { state.mcBlock = +$('mcBlock').value; save(); run(); });
  $('mcRun').addEventListener('click', () => runMC(false));

  // 參數穩健性
  for (const k of ['robAsset', 'robGrid', 'robObj']) {
    $(k).value = state[k];
    $(k).addEventListener('change', () => { state[k] = $(k).value; changed(); });
  }
  for (const k of ['robSplit', 'robWfStart']) {
    $(k).value = state[k];
    $(k).addEventListener('change', () => { if (okDate($(k).value)) { state[k] = $(k).value; changed(); } else $(k).value = state[k]; });
  }
  $('robWfStep').value = state.robWfStep;
  $('robWfStep').addEventListener('input', () => { const v = clampNum($('robWfStep').value, 1, 10); if (v !== null) { state.robWfStep = Math.round(v); changed(); } });
  $('robWfStep').addEventListener('change', () => { $('robWfStep').value = state.robWfStep; });
  $('mcCompare').addEventListener('click', () => runMC(true));

  document.querySelectorAll('.tabs button').forEach(b => b.addEventListener('click', () => {
    state.mode = b.dataset.mode; showMode(); changed();
  }));
  showMode();

  if (DATA.params?.gap_0050 !== undefined) $('gapText').textContent = pct(DATA.params.gap_0050, 2);
}

function buildParams() {
  const D = E.TREND_DEFAULTS;
  const val = (lev, k) => state.trendCustom[lev][k] ?? D[lev][k];
  $('params').innerHTML = `<span></span><span class="ph">正2（00631L、00675L）</span><span class="ph">1 倍（0050）</span>` +
    PARAM_FIELDS.map(([k, label, step, lo, hi]) => `<span class="pl">${label}</span>` + [2, 1].map(lev =>
      `<input type="number" inputmode="decimal" data-lev="${lev}" data-k="${k}" step="${step}" min="${lo}" max="${hi}" value="${val(lev, k)}" class="${state.trendCustom[lev][k] !== undefined ? 'changed' : ''}" aria-label="${label}（${lev === 2 ? '正2' : '1 倍'}）">`).join('')).join('');
  $('params').oninput = e => {
    const inp = e.target.closest('input'); if (!inp) return;
    const [k, , , lo, hi] = PARAM_FIELDS.find(f => f[0] === inp.dataset.k);
    const lev = +inp.dataset.lev, v = clampNum(inp.value, lo, hi);
    if (v === null) return;
    const int = ['maFast', 'maSlow', 'pyramidLevels'].includes(k);
    const vv = int ? Math.round(v) : v;
    if (vv === D[lev][k]) delete state.trendCustom[lev][k]; else state.trendCustom[lev][k] = vv;
    inp.classList.toggle('changed', state.trendCustom[lev][k] !== undefined);
    changed();
  };
  $('params').onchange = e => {
    const inp = e.target.closest('input'); if (!inp) return;
    inp.value = state.trendCustom[+inp.dataset.lev][inp.dataset.k] ?? D[+inp.dataset.lev][inp.dataset.k];
  };
}

function syncStrategyUI() {
  const trend = state.strategy === 'trend', rebal = state.strategy === 'rebal';
  $('stratName').textContent = trend ? '均線趨勢（接刀）' : rebal ? '再平衡' : '買進持有';
  $('strategySeg').querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', b.dataset.s === state.strategy));
  $('mcTab').hidden = !(trend || rebal);
  $('robustTab').hidden = !trend;
  if ((!(trend || rebal) && state.mode === 'mc') || (!trend && state.mode === 'robust')) { state.mode = 'period'; showMode(); }
  $('trendCard').hidden = !(trend || (rebal && state.rbTrend));
  $('rebalCard').hidden = !rebal;
  $('assetsField').hidden = rebal;
  const chip = $('assets').querySelector('[data-code="TAIEX"]');
  if (chip) { chip.disabled = trend; chip.title = trend ? '大盤是指數不能交易，策略模式不列入' : ''; }
}

function showMode() {
  document.querySelectorAll('.tabs button').forEach(b => b.setAttribute('aria-selected', b.dataset.mode === state.mode));
  document.querySelectorAll('[data-panel]').forEach(p => { p.hidden = p.dataset.panel !== state.mode; });
}

const changed = debounce(() => { save(); run(); }, 150);

// ---------- 計算 ----------
function opts() {
  return {
    useSynthetic: state.useSyn, tw50Excess: state.excess, capital: state.capital,
    cost: E.makeCost({ discount: state.discount }), signalPrice: state.signalPrice,
  };
}
const codes = () => ORDER.filter(c => state.assets.has(c) && !(state.strategy === 'trend' && c === 'TAIEX'));

function run() {
  $('excessRow').classList.toggle('disabled', !state.useSyn);
  const t0 = performance.now();
  try {
    if (state.strategy === 'rebal') runRebal();
    else if (state.strategy === 'trend') runTrend();
    else if (state.mode === 'period') renderPeriod(E.period(DATA, codes(), state.start, state.end, opts()));
    else if (state.mode === 'rolling') {
      const rows = E.rolling(DATA, codes(), state.rollYears, opts());
      renderMulti(rows, `${state.rollYears} 年滾動區間（每個月初一個起點）`);
    } else {
      const lo = Math.min(state.rndMin, state.rndMax), hi = Math.max(state.rndMin, state.rndMax);
      const rows = E.randomWindows(DATA, codes(), state.rndN, lo, hi, state.seed, opts());
      renderMulti(rows, `隨機 ${state.rndN} 個區間，長度 ${lo}～${hi} 年（種子 ${state.seed}）`);
    }
    if (!(state.strategy !== 'bh' && state.mode === 'mc')) $('status').textContent = `計算 ${Math.round(performance.now() - t0)} 毫秒`;
  } catch (err) {
    $('results').innerHTML = `<div class="warn">${esc(err.message)}</div>`;
    $('status').textContent = '';
    console.error(err);
  }
}

// ---------- 再平衡：設定 ----------
function buildRebalControls() {
  $('rbPresets').innerHTML = RB_PRESETS.map(([t], i) => `<button class="chip" type="button" data-i="${i}">${t}</button>`).join('');
  $('rbPresets').addEventListener('click', e => {
    const b = e.target.closest('.chip'); if (!b) return;
    state.rbWeights = { ...RB_PRESETS[+b.dataset.i][1] }; drawWeights(); changed();
  });
  drawWeights();
  $('rbFreq').value = state.rbFreq; $('rbBand').value = state.rbBand; $('rbCash').value = state.rbCash; $('rbTrend').checked = state.rbTrend;
  $('rbFreq').addEventListener('change', () => { state.rbFreq = $('rbFreq').value; ruleText(); changed(); });
  $('rbBand').addEventListener('input', () => { const v = clampNum($('rbBand').value, 0, 50); if (v !== null) { state.rbBand = v; ruleText(); changed(); } });
  $('rbCash').addEventListener('input', () => { const v = clampNum($('rbCash').value, 0, 10); if (v !== null) { state.rbCash = v; changed(); } });
  $('rbBand').addEventListener('change', () => { $('rbBand').value = state.rbBand; });
  $('rbCash').addEventListener('change', () => { $('rbCash').value = state.rbCash; });
  $('rbTrend').addEventListener('change', () => { state.rbTrend = $('rbTrend').checked; syncStrategyUI(); changed(); });
  ruleText();
}
function drawWeights() {
  $('rbWeights').innerHTML = Object.keys(RB_NAMES).map(k => `<label class="field"><span class="label">${RB_NAMES[k]} %</span>
    <input type="number" inputmode="decimal" min="0" max="100" step="5" data-k="${k}" value="${state.rbWeights[k] || 0}"></label>`).join('');
  $('rbWeights').oninput = e => {
    const inp = e.target.closest('input'); if (!inp) return;
    const v = clampNum(inp.value, 0, 100) ?? 0;          // 空白 = 0%
    state.rbWeights[inp.dataset.k] = v; sumText(); changed();
  };
  $('rbWeights').onchange = e => { const inp = e.target.closest('input'); if (inp) inp.value = state.rbWeights[inp.dataset.k] || 0; };
  sumText();
}
function sumText() {
  const w = state.rbWeights, sum = Object.values(w).reduce((a, b) => a + (b || 0), 0);
  let ex = '－'; try { ex = E.exposureOf(w).toFixed(2); } catch (_) { /* 全部 0 */ }
  $('rbSum').innerHTML = `合計 ${sum}%${sum !== 100 && sum > 0 ? '（不是 100%，會照比例換算）' : ''} · 曝險約 <b>${ex} 倍</b>（正2 算 2 倍、現金 0 倍）`;
}
function ruleText() {
  const f = { none: '', M: '每月', Q: '每季', H: '每半年', Y: '每年' }[state.rbFreq], b = state.rbBand;
  $('rbRuleText').textContent = !f && !(b > 0) ? '不定期、不設門檻 = 買進後放著不調（對照組）。'
    : !f ? `每天檢查，任一部位占總資產的比例跟目標差超過 ${b}%（例如目標 50%，漲到 ${50 + b}% 以上或跌到 ${50 - b}% 以下）就調回。`
    : !(b > 0) ? `${f}第一個交易日都調回目標比例。` : `${f}第一個交易日檢查，任一部位占總資產的比例跟目標差超過 ${b}%（例如目標 50%，變成 ${50 + b}% 以上或 ${50 - b}% 以下）才調回。`;
}
function rbCfg() {
  const w = Object.fromEntries(Object.entries(state.rbWeights).map(([k, v]) => [k, (v || 0) / 100]));
  return { weights: w, freq: state.rbFreq, band: (state.rbBand || 0) / 100, cashRate: (state.rbCash || 0) / 100, trend: state.rbTrend };
}

function runRebal() {
  let cfg;
  try { cfg = rbCfg(); E.normWeights(cfg.weights); } catch (err) { destroyCharts(); $('results').innerHTML = `<div class="warn">${esc(err.message)}</div>`; return; }
  if (state.mode === 'mc') { if (mcRunning && mcRunning.key === mcKey(mcRunning.compare)) return; mcToken++; renderMCIdle(); return; }
  if (state.mode === 'period') return renderRebalPeriod(cfg);
  let wins, title;
  if (state.mode === 'rolling') { wins = E.rollingWins(DATA, state.rollYears); title = `${state.rollYears} 年滾動區間（每個月初一個起點）`; }
  else {
    const lo = Math.min(state.rndMin, state.rndMax), hi = Math.max(state.rndMin, state.rndMax);
    wins = E.randomWins(DATA, state.rndN, lo, hi, state.seed); title = `隨機 ${state.rndN} 個區間，長度 ${lo}～${hi} 年（種子 ${state.seed}）`;
  }
  renderRebalMulti(cfg, wins, title);
}

// 對照組：名稱、顏色
const RB_ITEMS = [
  ['main', '再平衡策略', '--text'], ['noTr', '同配置不搭配均線', '--c-00675L'], ['flat', '同配置不再平衡', '--muted'], ['bh50', '0050 買進持有', '--c-0050'],
  ['bh631', '00631L 買進持有', '--c-alt'], ['tr631', '00631L 均線策略', '--c-00631L'],
];
// 列名跟著設定：前幾列是「你的設定」和只改一個條件的對照，後三列是固定對照（不受這張卡的設定影響）
function rbLabel(k) {
  let tr = false; try { tr = hasTrendEffect(rbCfg()); } catch (_) { /* 比例全是 0 */ }
  return {
    main: tr ? '你的設定（再平衡＋均線）' : '你的設定（再平衡）',
    noTr: '同設定、不搭配均線',
    flat: tr ? '同配置、不再平衡（有均線）' : '同配置、不再平衡',
  }[k] ?? RB_ITEMS.find(x => x[0] === k)[1];
}
const FIXED = new Set(['bh50', 'bh631', 'tr631']);
const groupRow = (cols, prev, k) => (FIXED.has(k) && !FIXED.has(prev)) ? `<tr class="grp"><td colspan="${cols}">固定對照（不受上面的設定影響）</td></tr>` : '';
const hasTrendEffect = cfg => cfg.trend && Object.keys(E.normWeights(cfg.weights)).some(k => k === '00631L' || k === '00675L');
function cfgLabel(cfg) {
  const w = E.normWeights(cfg.weights);
  const mix = Object.entries(w).map(([k, v]) => `${RB_NAMES[k]} ${Math.round(v * 100)}%`).join(' ＋ ');
  return `${mix}${hasTrendEffect(cfg) ? '（正2 搭配均線）' : ''} · ${$('rbRuleText').textContent.replace(/。$/, '')} · 曝險約 ${E.exposureOf(cfg.weights).toFixed(2)} 倍`;
}

function renderRebalPeriod(cfg) {
  destroyCharts();
  let res = E.rebalPeriod(DATA, cfg, state.start, state.end, opts(), state.trendCustom);
  if (res.error) { $('results').innerHTML = `<div class="warn">${esc(res.error)}</div>`; return; }
  let s0 = E.dayToIso(res.dayIdx[0]);
  const s1 = E.dayToIso(res.dayIdx[res.dayIdx.length - 1]);
  // 00631L 均線策略要等均線算得出來；比它早的起點，全部對照組一起延後，才是同一段期間比
  let aligned = null;
  const tr0 = E.trendPeriod(DATA, ['00631L'], s0, s1, opts(), state.trendCustom).results?.[0];
  let trSkip = null;
  // 只差均線暖身（一年內）才一起延後；差更多（例如只用真實資料、配置裡沒有正2）就不列 00631L 均線策略
  if (tr0?.shiftedFrom && tr0.shiftedFrom > s0 && E.isoToDay(tr0.shiftedFrom) - E.isoToDay(s0) > 400) trSkip = tr0.shiftedFrom;
  else if (tr0?.shiftedFrom && tr0.shiftedFrom > s0) {
    aligned = tr0.shiftedFrom;
    res = E.rebalPeriod(DATA, cfg, aligned, s1, opts(), state.trendCustom);
    if (res.error) { $('results').innerHTML = `<div class="warn">${esc(res.error)}</div>`; return; }
    s0 = E.dayToIso(res.dayIdx[0]);
  }
  const items = [
    { k: 'main', eq: res.main.eq, dayIdx: res.dayIdx },
    { k: 'flat', eq: res.flat.eq, dayIdx: res.dayIdx },
  ];
  // 搭配均線時，多列一行「同樣配置和規則、但不搭配均線」，直接看出均線的效果
  if (hasTrendEffect(cfg)) {
    const nt = E.rebalPeriod(DATA, { ...cfg, trend: false }, s0, s1, opts(), state.trendCustom);
    if (!nt.error) items.push({ k: 'noTr', eq: nt.main.eq, dayIdx: nt.dayIdx });
  }
  const bh = E.period(DATA, ['0050', '00631L'], s0, s1, opts());
  for (const r of bh.results || []) items.push({ k: r.code === '0050' ? 'bh50' : 'bh631', eq: r.equity, dayIdx: r.dayIdx });
  const tr = trSkip ? {} : E.trendPeriod(DATA, ['00631L'], s0, s1, opts(), state.trendCustom);
  if (tr.results?.[0]) items.push({ k: 'tr631', eq: tr.results[0].equity, dayIdx: tr.results[0].dayIdx, note: tr.results[0].shiftedFrom });
  for (const it of items) { const m = RB_ITEMS.find(x => x[0] === it.k); it.name = rbLabel(it.k); it.color = css(m[2]); it.st = E.summarize(it.eq, it.dayIdx); }
  items.sort((a, b) => RB_ITEMS.findIndex(x => x[0] === a.k) - RB_ITEMS.findIndex(x => x[0] === b.k));

  const nReb = res.main.log.filter(l => l.what === '再平衡').length, nSig = res.main.log.length - nReb;
  // 整張交易：配置金額不到半張的標的，四捨五入到 0 張，永遠買不到
  const wN = E.normWeights(cfg.weights);
  const tooSmall = Object.entries(res.lotPrice).filter(([c, pl]) => state.capital * wN[c] < pl / 2);
  let html = trSkip ? `<div class="warn">00631L 均線策略在這段期間最早 ${trSkip} 才能開始，跟這個配置差太多，沒有列入比較。</div>` : '';
  if (cfg.trend && !hasTrendEffect(cfg)) html += `<div class="warn">這個配置沒有正2（00631L、00675L），「搭配均線訊號」只管正2，開或關結果都一樣。</div>`;
  else if (hasTrendEffect(cfg) && nSig === 0) html += `<div class="warn">這段期間正2 的均線沒有任何動作（沒有出場、接刀或轉回續抱），所以「搭配均線訊號」開或關結果一樣。拉長期間（例如包含 2008、2020、2022 年）就看得出差別。</div>`;
  if (tooSmall.length) html += `<div class="warn">整張交易（一張 1000 股）：投入金額 × 比例不到半張，買不到 ${tooSmall.map(([c, pl]) => `${c}（配置 ${money(state.capital * wN[c])}，一張 ${money(pl)}）`).join('、')}，那部分會一直是現金。請提高投入金額。</div>`;
  html += aligned ? `<div class="warn">00631L 均線策略要先累積均線，最早 ${aligned} 才能開始；為了在同一段期間比較，全部從那天開始。</div>`
    : res.shifted ? `<div class="warn">這個配置最早 ${res.shifted} 才有資料${cfg.trend ? '（正2 的均線要先累積）' : ''}，從那天開始。</div>` : '';
  html += `<section class="card"><h3>${esc(cfgLabel(cfg))}</h3>
    <p class="hint">${s0} ～ ${s1} · 再平衡 ${nReb} 次${cfg.trend ? ` · 均線訊號 ${nSig} 次` : ''} · 交易 ${res.main.trades} 筆 · 期末 ${moneyShort(res.stats.final)}</p>
    <div class="tbl-wrap"><table class="cmp-tbl"><thead><tr><th></th><th>年化</th><th class="tot">總報酬</th><th>最大回撤</th><th>最長套牢</th><th>報酬÷回撤</th></tr></thead><tbody>
    ${items.map((it, i) => groupRow(6, items[i - 1]?.k, it.k) + `<tr class="${it.k === 'main' ? 'main' : ''}"><td><span class="dot" style="background:${it.color}"></span>${it.name}${it.note ? `<br><small style="color:var(--muted)">從 ${it.note} 起</small>` : ''}</td>
      <td class="n ${cls(it.st.cagr)}">${pct(it.st.cagr, 1, true)}</td><td class="n tot">${totalShort(it.st.total)}</td>
      <td class="n neg">${pct(it.st.mdd)}</td><td class="n">${uwShort(it.st)}</td><td class="n">${num2(it.st.calmar)}</td></tr>`).join('')}
    </tbody></table></div><p class="hint">${UW_HINT}</p>${(() => {
      const a = items.find(x => x.k === 'main'), b = items.find(x => x.k === 'noTr');
      if (!a || !b) return '';
      const d = (a.st.cagr - b.st.cagr) * 100, m = (a.st.mdd - b.st.mdd) * 100;
      return `<p class="hint"><b>均線的效果</b>（你的設定 vs 同設定、不搭配均線）：年化 ${d >= 0 ? '多' : '少'} ${Math.abs(d).toFixed(1)} 個百分點，最大回撤${m >= 0 ? '少' : '多'} ${Math.abs(m).toFixed(1)} 個百分點。</p>`;
    })()}</section>`;
  html += `<section class="card"><div class="chart-head"><h3>資產成長</h3>
      <div class="seg" id="scaleSeg"><button type="button" data-log="1" aria-pressed="${state.log}">對數</button><button type="button" data-log="0" aria-pressed="${!state.log}">一般</button></div></div>
    <div class="chart-box" id="cGrowth"></div>
    <div class="legend">${items.map(it => `<span><i style="background:${it.color}"></i>${it.name}</span>`).join('')}</div></section>
    <section class="card"><h3>回撤</h3><div class="chart-box short" id="cDD"></div></section>`;
  $('results').innerHTML = html;
  $('scaleSeg').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; state.log = b.dataset.log === '1'; save(); run(); });
  const draw = [...items].reverse();     // 主策略最後畫，在最上層
  const fmt = v => (v >= 10 ? v.toFixed(0) : v >= 1 ? v.toFixed(1) : v.toFixed(2)).replace(/\.0$/, '') + '×';
  charts.growth = new LineChart($('cGrowth'), {
    series: draw.map(it => ({ name: it.name, color: it.color, x: Float64Array.from(it.dayIdx, d => d * DAY_MS), y: Float64Array.from(it.eq, v => v / it.eq[0]) })),
    log: state.log, yFmt: fmt, tipFmt: v => v.toFixed(2) + ' 倍', ariaLabel: '資產成長',
    width: 1.5,
  });
  const dd = it => {
    const n = it.eq.length, step = Math.max(1, Math.ceil(n / 1200)), xs = [], ys = [];
    let peak = -Infinity, m = 0, mv = Infinity;
    for (let i = 0; i < n; i++) {
      peak = Math.max(peak, it.eq[i]); const d = it.eq[i] / peak - 1;
      if (d < mv) { mv = d; m = i; }
      if ((i + 1) % step === 0 || i === n - 1) { xs.push(it.dayIdx[m] * DAY_MS); ys.push(mv * 100); mv = Infinity; }
    }
    return { name: it.name, color: it.color, x: Float64Array.from(xs), y: Float64Array.from(ys) };
  };
  charts.dd = new LineChart($('cDD'), { series: draw.map(dd), yMax: 0, width: 1.1, yFmt: v => Math.round(v) + '%', tipFmt: v => v.toFixed(1) + '%', ariaLabel: '回撤' });
}

function rebalCompareTable(sets, years) {
  // sets: [{k, cagr:[], mdd:[], uw:[]}]
  const q = (a, p) => E.quantile([...a].sort((x, y) => x - y), p);
  return `<div class="tbl-wrap"><table class="cmp-tbl"><thead><tr><th></th><th>年化中位數</th><th>年化 5%</th><th>虧損機率</th><th>回撤中位數</th><th>回撤 5%</th><th>套牢中位數</th><th>套牢 95%</th></tr></thead><tbody>
    ${sets.map((it, i) => { const m = RB_ITEMS.find(x => x[0] === it.k); return groupRow(8, sets[i - 1]?.k, it.k) + `<tr class="${it.k === 'main' ? 'main' : ''}"><td><span class="dot" style="background:${css(m[2])}"></span>${rbLabel(it.k)}</td>
      <td class="n ${cls(q(it.cagr, .5))}">${pct(q(it.cagr, .5), 1, true)}</td><td class="n ${cls(q(it.cagr, .05))}">${pct(q(it.cagr, .05), 1, true)}</td>
      <td class="n">${pct(it.cagr.filter(x => x < 0).length / it.cagr.length, 0)}</td>
      <td class="n neg">${pct(q(it.mdd, .5), 0)}</td><td class="n neg">${pct(q(it.mdd, .05), 0)}</td>
      <td class="n">${dur(q(it.uw, .5))}</td><td class="n">${dur(q(it.uw, .95))}</td></tr>`; }).join('')}
    </tbody></table></div><p class="hint">套牢 = 每一段期間（或每一條模擬）裡最長的那次套牢（從前高跌下去到回到前高）；95% = 比較慘的那 5% 至少套多久。</p>`;
}
function winLine(rows, keys) {
  const name = k => rbLabel(k);
  const have = keys.filter(k => rows.some(r => r[k + 'Cagr'] !== undefined && r[k + 'Cagr'] !== null));
  const f = (k, field) => { const g = rows.filter(r => r[k + 'Cagr'] != null); return g.filter(r => field === 'c' ? r.cagr > r[k + 'Cagr'] : r.mdd > r[k + 'Mdd']).length / g.length; };
  return `<p class="hint">你的設定年化贏過：${have.map(k => `${name(k)} <b>${pct(f(k, 'c'), 0)}</b>`).join('、')}<br>最大回撤比較小：${have.map(k => `${name(k)} <b>${pct(f(k, 'm'), 0)}</b>`).join('、')}</p>`;
}

function renderRebalMulti(cfg, wins, title) {
  destroyCharts();
  const rows = E.rebalWindows(DATA, cfg, wins, opts(), state.trendCustom);
  if (!rows.length) { $('results').innerHTML = `<div class="warn">沒有符合條件的區間。${state.useSyn ? '' : '只用真實資料時期間較短，試試縮短長度或開啟模擬資料。'}</div>`; return; }
  const key = r => r.start + '|' + r.end;
  const bh = new Map(), tr = new Map();
  for (const r of E.windows(DATA, ['0050', '00631L'], wins, opts())) bh.set(r.code + key(r), r);
  for (const r of E.trendWindows(DATA, ['00631L'], wins, opts(), state.trendCustom)) tr.set(key(r), r);
  const nt = new Map();
  if (hasTrendEffect(cfg)) for (const r of E.rebalWindows(DATA, { ...cfg, trend: false }, wins, opts(), state.trendCustom)) nt.set(key(r), r);
  for (const r of rows) {
    const a = bh.get('0050' + key(r)), b = bh.get('00631L' + key(r)), c = tr.get(key(r));
    r.bh50Cagr = a?.cagr ?? null; r.bh50Mdd = a?.mdd ?? null; r.bh631Cagr = b?.cagr ?? null; r.bh631Mdd = b?.mdd ?? null;
    r.bh50Uw = a?.uw ?? null; r.bh631Uw = b?.uw ?? null;
    r.tr631Cagr = c?.cagr ?? null; r.tr631Mdd = c?.mdd ?? null; r.tr631Uw = c?.uw ?? null;
    const d = nt.get(key(r)); r.noTrCagr = d?.cagr ?? null; r.noTrMdd = d?.mdd ?? null; r.noTrUw = d?.uw ?? null;
  }
  const sets = RB_ITEMS.map(([k]) => {
    const g = k === 'main' ? rows : rows.filter(r => r[k + 'Cagr'] != null);
    return { k, cagr: g.map(r => k === 'main' ? r.cagr : r[k + 'Cagr']), mdd: g.map(r => k === 'main' ? r.mdd : r[k + 'Mdd']),
      uw: g.map(r => k === 'main' ? r.uw : r[k + 'Uw']) };
  }).filter(s => s.cagr.length);
  const m = state.metric === 'mdd' ? 'mdd' : 'cagr', M = METRICS[m];
  const dist = sets.map(st => {
    const arr = [...st[m]].sort((x, y) => x - y), q = p => E.quantile(arr, p);
    const meta = RB_ITEMS.find(x => x[0] === st.k);
    return { label: rbLabel(st.k), color: css(meta[2]), s: { min: arr[0], max: arr[arr.length - 1], p5: q(.05), p25: q(.25), p50: q(.5), p75: q(.75), p95: q(.95) } };
  });
  $('results').innerHTML = `<section class="card"><h3>${esc(title)}</h3><p class="hint">${esc(cfgLabel(cfg))} · 共 ${rows.length} 段（對照組只算同一段期間有資料的）</p>
      ${winLine(rows, ['noTr', 'flat', 'bh50', 'bh631', 'tr631'])}
      ${rebalCompareTable(sets)}</section>
    <section class="card"><div class="chart-head"><h3>分布</h3>
      <div class="seg" id="metricSeg">${['cagr', 'mdd'].map(k => `<button type="button" data-m="${k}" aria-pressed="${k === m}">${METRICS[k].label}</button>`).join('')}</div></div>
      ${rangeBars(dist, M)}</section>`;
  $('metricSeg').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; state.metric = b.dataset.m; save(); run(); });
}

function runTrend() {
  if (state.mode === 'mc') { if (mcRunning && mcRunning.key === mcKey(mcRunning.compare)) return; mcToken++; renderMCIdle(); return; }
  if (state.mode === 'robust') return renderRobust();
  if (!codes().length) { destroyCharts(); $('results').innerHTML = '<div class="warn">請至少選一檔 0050、00631L 或 00675L（大盤不能交易，不跑策略）。</div>'; return; }
  if (state.mode === 'period') {
    renderTrendPeriod(E.trendPeriod(DATA, codes(), state.start, state.end, opts(), state.trendCustom));
    return;
  }
  let wins, title;
  if (state.mode === 'rolling') {
    wins = E.rollingWins(DATA, state.rollYears);
    title = `${state.rollYears} 年滾動區間（每個月初一個起點）`;
  } else {
    const lo = Math.min(state.rndMin, state.rndMax), hi = Math.max(state.rndMin, state.rndMax);
    wins = E.randomWins(DATA, state.rndN, lo, hi, state.seed);
    title = `隨機 ${state.rndN} 個區間，長度 ${lo}～${hi} 年（種子 ${state.seed}）`;
  }
  renderTrendMulti(E.trendWindows(DATA, codes(), wins, opts(), state.trendCustom), title);
}

// ---------- 圖表 ----------
function destroyCharts() { for (const k in charts) { charts[k].destroy(); delete charts[k]; } }

function growthChart(res) {
  const series = res.results.map(r => {
    const base = r.equity[0];
    return {
      name: SHORT[r.code], color: color(r.code),
      x: Float64Array.from(r.dayIdx, d => d * DAY_MS),
      y: Float64Array.from(r.equity, v => v / base),
      dashUntil: r.stats.syntheticUntil >= 0 ? r.dayIdx[r.stats.syntheticUntil] * DAY_MS : undefined,
    };
  });
  const fmt = v => (v >= 10 ? v.toFixed(0) : v >= 1 ? v.toFixed(1) : v.toFixed(2)).replace(/\.0$/, '') + '×';
  charts.growth = new LineChart($('cGrowth'), {
    series, log: state.log, yFmt: fmt, tipFmt: v => v.toFixed(2) + ' 倍', ariaLabel: '資產成長圖',
  });
}

function drawdownChart(res) {
  const series = res.results.map(r => {
    const n = r.equity.length, step = Math.max(1, Math.ceil(n / 1200));
    const xs = [], ys = [];
    let peak = -Infinity, m = 0, mv = Infinity;
    for (let i = 0; i < n; i++) {          // 每段取最低點，避免畫出來的回撤比實際淺
      peak = Math.max(peak, r.equity[i]);
      const dd = r.equity[i] / peak - 1;
      if (dd < mv) { mv = dd; m = i; }
      if ((i + 1) % step === 0 || i === n - 1) { xs.push(r.dayIdx[m] * DAY_MS); ys.push(mv * 100); mv = Infinity; }
    }
    return { name: SHORT[r.code], color: color(r.code), x: Float64Array.from(xs), y: Float64Array.from(ys) };
  });
  charts.dd = new LineChart($('cDD'), {
    series, yMax: 0, width: 1.2, yFmt: v => Math.round(v) + '%', tipFmt: v => v.toFixed(1) + '%', ariaLabel: '回撤圖',
  });
}

function legendHtml(list, dashed) {
  return `<div class="legend">${list.map(c => `<span><i style="background:${color(c)}"></i>${SHORT[c]}</span>`).join('')}${dashed ? '<span><i class="dash"></i>虛線 = 模擬資料</span>' : ''}</div>`;
}

// 「更多指標」裡最大回撤那一次、最長套牢那一次的日期與時間
function mddDetail(s, prefix = '') {
  if (s.mdd >= 0) return `<dt>${prefix}回撤</dt><dd>沒有</dd>`;
  const sub = t => `<br><small style="color:var(--muted)">${t}</small>`;
  let h = `<dt>${prefix}回撤期間</dt><dd>${s.mddTop} → ${s.mddTrough}${sub(`跌了 ${dur(s.mddFall)}`)}</dd>
    <dt>回到前高</dt><dd>${s.mddRecovery ?? '尚未'}${sub(s.mddRecovery ? `花了 ${dur(s.mddRecover)}` : `已經 ${dur(s.mddRecover)}`)}</dd>`;
  if (s.uwTop !== s.mddTop) h += `<dt>${prefix}最長套牢</dt><dd>${s.uwTop} → ${s.uwEnd ?? '尚未回到前高'}${sub(`${uwShort(s)}，最深 ${pct(s.uwDepth)}`)}</dd>`;
  return h;
}

// ---------- 自訂區間 ----------
function renderPeriod(res) {
  destroyCharts();
  if (res.error) { $('results').innerHTML = `<div class="warn">${res.error}</div>`; return; }
  const skipped = res.skipped.map(s => `${LABEL[s.code]}（${state.useSyn ? '最早' : '真實資料最早'}可從 ${s.availableFrom} 開始）`);
  const anySyn = res.results.some(r => r.stats.syntheticShare > 0);
  let html = '';
  if (skipped.length) html += `<div class="warn">這段期間缺資料，已略過：${skipped.join('、')}</div>`;
  if (!res.results.length) { $('results').innerHTML = html; return; }

  const poor = res.results.filter(r => r.stats.lots0 === 0);
  if (poor.length) html += `<div class="warn">整張交易（一張 1000 股）：投入金額買不起一張 ${poor.map(r => `${SHORT[r.code]}（${money(r.stats.lotPrice)}）`).join('、')}，那幾檔整段都是現金。</div>`;
  html += `<div class="cards">${res.results.map(r => {
    const s = r.stats;
    return `<article class="acard" style="--c:${color(r.code)}">
      <div class="name"><span>${LABEL[r.code]}</span>${s.syntheticShare > 0 ? `<span class="badge">模擬 ${pct(s.syntheticShare, 0)}</span>` : ''}</div>
      <div class="big ${cls(s.cagr)}">${pct(s.cagr, 1, true)}</div>
      <div class="cap">年化報酬</div>
      <dl class="kv">
        <dt>總報酬</dt><dd class="${cls(s.total)}">${pct(s.total, 1, true)}</dd>
        <dt>最大回撤</dt><dd class="neg">${pct(s.mdd)}</dd>
        <dt>最長套牢</dt><dd>${uwShort(s)}</dd>
        <dt>期末金額</dt><dd>${money(s.final)}</dd>
        ${s.lots0 != null ? `<dt>期初買進</dt><dd>${s.lots0 > 0 ? `${s.lots0.toLocaleString()} 張` : '<span class="neg">錢不夠買一張</span>'}<br><small style="color:var(--muted)">一張 ${money(s.lotPrice)}</small></dd>` : ''}
      </dl>
      <details class="more"><summary>更多指標</summary>
        <dl class="kv">
          <dt>年化波動</dt><dd>${pct(s.vol)}</dd>
          <dt>夏普</dt><dd>${num2(s.sharpe)}</dd>
          <dt>索提諾</dt><dd>${num2(s.sortino)}</dd>
          <dt>卡瑪</dt><dd>${num2(s.calmar)}</dd>
          <dt>最好年度</dt><dd class="${cls(s.bestYear)}">${pct(s.bestYear, 1, true)}</dd>
          <dt>最差年度</dt><dd class="${cls(s.worstYear)}">${pct(s.worstYear, 1, true)}</dd>
          ${mddDetail(s)}
        </dl>
      </details>
    </article>`;
  }).join('')}</div>`;

  const list = res.results.map(r => r.code);
  html += `<section class="card">
      <div class="chart-head"><h3>資產成長</h3>
        <div class="seg" id="scaleSeg"><button type="button" data-log="1" aria-pressed="${state.log}">對數</button><button type="button" data-log="0" aria-pressed="${!state.log}">一般</button></div></div>
      <div class="chart-box" id="cGrowth"></div>
      ${legendHtml(list, anySyn)}
    </section>
    <section class="card"><h3>回撤</h3><div class="chart-box short" id="cDD"></div></section>`;

  // 年度報酬表
  const years = res.results[0].stats.yearly.map(y => y.year);
  html += `<section class="card"><details><summary><b>逐年報酬</b></summary><div class="tbl-wrap"><table>
    <thead><tr><th>年度</th>${list.map(c => `<th><span class="dot" style="background:${color(c)}"></span>${SHORT[c]}</th>`).join('')}</tr></thead><tbody>
    ${years.map((y, k) => `<tr><td>${y}${k === 0 || k === years.length - 1 ? '<small style="color:var(--muted)">（部分）</small>' : ''}</td>${res.results.map(r => { const v = r.stats.yearly[k]?.ret; return `<td class="n ${cls(v)}">${pct(v, 1, true)}</td>`; }).join('')}</tr>`).join('')}
    </tbody></table></div></details></section>`;

  $('results').innerHTML = html;
  $('scaleSeg').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    state.log = b.dataset.log === '1'; save(); run();
  });
  growthChart(res); drawdownChart(res);
}

// ---------- 多區間 ----------
const METRICS = {
  cagr: { label: '年化報酬', sign: true },
  mdd: { label: '最大回撤', sign: false },
  total: { label: '總報酬', sign: true },
};

const openShare = (rows, c, k) => { const g = rows.filter(r => r.code === c); return g.filter(r => r[k]).length / g.length; };

function renderMulti(rows, title) {
  destroyCharts();
  const list = codes().filter(c => rows.some(r => r.code === c));
  if (!rows.length) {
    $('results').innerHTML = `<div class="warn">沒有符合條件的區間。${state.useSyn ? '' : '只用真實資料時可用的期間較短，試試縮短長度或開啟模擬資料。'}</div>`;
    return;
  }
  const m = state.metric, M = METRICS[m];
  const d = E.describe(rows, list, m);
  const dC = m === 'cagr' ? d : E.describe(rows, list, 'cagr');
  const dD = m === 'mdd' ? d : E.describe(rows, list, 'mdd');
  const dU = E.describe(rows, list, 'uw');
  const counts = list.map(c => d[c].count);
  const synShare = Object.fromEntries(list.map(c => {
    const g = rows.filter(r => r.code === c);
    return [c, g.reduce((s, r) => s + r.syntheticShare, 0) / g.length];
  }));

  let html = `<section class="card"><h3>${esc(title)}</h3>
    <p class="hint">共 ${Math.max(...counts)} 段${new Set(counts).size > 1 ? `（各標的可用段數不同：${list.map(c => `${SHORT[c]} ${d[c].count}`).join('、')}）` : ''}。
    ${list.some(c => synShare[c] > 0) ? `平均含模擬資料：${list.map(c => `${SHORT[c]} ${pct(synShare[c], 0)}`).join('、')}。` : ''}</p>
    <div class="chart-head" style="margin-top:12px"><b style="font-size:14px">分布</b>
      <div class="seg" id="metricSeg">${Object.entries(METRICS).map(([k, v]) => `<button type="button" data-m="${k}" aria-pressed="${k === m}">${v.label}</button>`).join('')}</div></div>
    ${rangesHtml(d, list, M)}
  </section>`;

  // 分布表
  const row = (lbl, f, em) => `<tr class="${em ? 'em' : ''}"><td class="lbl">${lbl}</td>${list.map(c => f(c)).join('')}</tr>`;
  const grp = t => `<tr class="grp"><td colspan="${list.length + 1}">${t}</td></tr>`;
  const cell = (v, sign) => `<td class="n ${cls(v)}">${pct(v, 1, sign)}</td>`;
  html += `<section class="card"><h3>統計表</h3><div class="tbl-wrap"><table>
    <thead><tr><th></th>${list.map(c => `<th><span class="dot" style="background:${color(c)}"></span>${SHORT[c]}</th>`).join('')}</tr></thead><tbody>
    ${grp('年化報酬')}
    ${row('中位數', c => cell(dC[c].p50, true), true)}
    ${row('平均', c => cell(dC[c].mean, true))}
    ${row('最差', c => cell(dC[c].min, true))}
    ${row('5%', c => cell(dC[c].p5, true))}
    ${row('25%', c => cell(dC[c].p25, true))}
    ${row('75%', c => cell(dC[c].p75, true))}
    ${row('95%', c => cell(dC[c].p95, true))}
    ${row('最好', c => cell(dC[c].max, true))}
    ${row('虧損機率', c => `<td class="n">${pct(dC[c].lossProb)}</td>`, true)}
    ${grp('最大回撤')}
    ${row('中位數', c => cell(dD[c].p50), true)}
    ${row('最差', c => cell(dD[c].min))}
    ${grp('最長套牢')}
    ${row('中位數', c => `<td class="n">${dur(dU[c].p50)}</td>`, true)}
    ${row('95%', c => `<td class="n">${dur(dU[c].p95)}</td>`)}
    ${row('最長', c => `<td class="n">${dur(dU[c].max)}</td>`)}
    ${row('期末還在套牢', c => `<td class="n">${pct(openShare(rows, c, 'uwOpen'), 0)}</td>`)}
    </tbody></table></div><p class="hint" style="margin-top:10px">${UW_HINT}「期末還在套牢」= 最長那次到期末還沒結束的區間比例。</p>`;
  if (list.includes('0050') && list.length > 1) {
    const others = list.filter(c => c !== '0050');
    html += `<p class="hint" style="margin-top:10px">年化報酬勝過 0050 的比例：${others.map(c => `${SHORT[c]} <b>${pct(E.winRate(rows, c, '0050', 'cagr'), 0)}</b>`).join('、')}</p>`;
  }
  html += `</section>`;

  // 散布圖
  html += `<section class="card"><h3>${M.label}（依起始日）</h3>
    <div class="chart-box" id="cScatter"></div>${legendHtml(list, false)}</section>`;

  // 最差與最好
  const wb = E.worstBest(rows, list, m === 'mdd' ? 'mdd' : 'cagr');
  html += `<section class="card"><h3>最差與最好的區間</h3><div class="wb">
    ${list.map(c => `<div class="wb-item" style="--c:${color(c)}"><div class="t">${LABEL[c]}</div>
      ${['worst', 'best'].map(k => { const r = wb[c][k]; return `<div class="wb-row">
        <span class="wb-k">${k === 'worst' ? '最差' : '最好'}</span>
        <span class="num wb-d">${r.start} ～ ${r.end}</span>
        <span class="num ${cls(r.cagr)}">${pct(r.cagr, 1, true)}</span>
        <span class="num neg">${pct(r.mdd, 0)}</span></div>`; }).join('')}
      </div>`).join('')}
  </div><p class="hint">每列依序為：期間、年化報酬、期間內最大回撤</p>
  </div></section>`;

  $('results').innerHTML = html;
  $('metricSeg').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    state.metric = b.dataset.m; save(); run();
  });
  charts.scatter = new ScatterChart($('cScatter'), {
    series: list.map(c => ({
      name: SHORT[c], color: color(c),
      pts: rows.filter(r => r.code === c).map(r => ({ x: E.isoToDay(r.start) * DAY_MS, y: r[m] * 100, label: `${r.start} ～ ${r.end}` })),
    })),
    yFmt: v => Math.round(v) + '%', tipFmt: v => (M.sign && v > 0 ? '+' : '') + v.toFixed(1) + '%',
    ariaLabel: `${M.label}散布圖`,
  });
}

function rangesHtml(d, list, M) {
  return rangeBars(list.map(c => ({ label: LABEL[c], color: color(c), s: d[c] })), M);
}
function rangeBars(items, M) {
  const vals = items.flatMap(it => [it.s.min, it.s.max]);
  let lo = Math.min(...vals, 0), hi = Math.max(...vals, 0);
  const pad = (hi - lo) * 0.04; lo -= pad; hi += pad;
  const x = v => ((v - lo) / (hi - lo)) * 100;
  const step = [0.01, 0.02, 0.05, 0.1, 0.2, 0.25, 0.5].find(s => (hi - lo) / s <= 7) ?? 1;
  const ticks = [];
  for (let t = Math.ceil(lo / step) * step; t <= hi + 1e-9; t += step) ticks.push(t);
  return `<div class="ranges">${items.map(it => {
    const s = it.s;
    return `<div class="range-row" style="--c:${it.color}">
      <div class="rname"><span>${it.label}</span><span>中位數 ${pct(s.p50, 1, M.sign)}</span></div>
      <div class="track-r" title="最差 ${pct(s.min)}｜5% ${pct(s.p5)}｜25% ${pct(s.p25)}｜中位數 ${pct(s.p50)}｜75% ${pct(s.p75)}｜95% ${pct(s.p95)}｜最好 ${pct(s.max)}">
        <span class="axis0" style="left:${x(0)}%"></span>
        <span class="w" style="left:${x(s.min)}%;width:${x(s.max) - x(s.min)}%;opacity:.18"></span>
        <span class="w" style="left:${x(s.p5)}%;width:${x(s.p95) - x(s.p5)}%"></span>
        <span class="b" style="left:${x(s.p25)}%;width:${Math.max(0.6, x(s.p75) - x(s.p25))}%"></span>
        <span class="m" style="left:${x(s.p50)}%"></span>
      </div></div>`;
  }).join('')}
  <div class="scale">${ticks.map(t => `<span style="left:${x(t)}%">${Math.round(t * 100)}%</span>`).join('')}</div>
  <div class="range-legend">粗條 = 中間一半（25%～75%）· 細線 = 5%～95% · 淡線 = 最差～最好 · 黑線 = 中位數</div></div>`;
}

// ---------- 均線趨勢：自訂區間 ----------
const ACT_LABEL = { 1: '轉回續抱', 2: '接刀', 3: '出場' };
const ACT_SHAPE = { 1: 'dot', 2: 'up', 3: 'down' };

function renderTrendPeriod(res) {
  destroyCharts();
  if (res.error) { $('results').innerHTML = `<div class="warn">${res.error}</div>`; return; }
  let html = '';
  const skipped = res.skipped.map(s => `${LABEL[s.code]}（${state.useSyn ? '最早' : '真實資料最早'}可從 ${s.availableFrom} 開始）`);
  if (skipped.length) html += `<div class="warn">這段期間缺資料，已略過：${skipped.join('、')}</div>`;
  if (!res.results.length) { $('results').innerHTML = html; return; }
  const R = res.results;
  const shifted = R.filter(r => r.shiftedFrom);
  if (shifted.length) html += `<div class="warn">均線要先累積 ${Math.max(...shifted.map(r => Math.max(r.params.maFast, r.params.maSlow)))} 個交易日才算得出來，之前策略只能觀望，跟買進持有比不公平。所以這幾檔改從均線算得出來的那天開始（策略和買進持有同一天）：${shifted.map(r => `${SHORT[r.code]} ${r.shiftedFrom}`).join('、')}</div>`;
  const poor = R.filter(r => r.bh.lots0 === 0);
  if (poor.length) html += `<div class="warn">整張交易（一張 1000 股）：投入金額買不起一張 ${poor.map(r => `${SHORT[r.code]}（${money(r.bh.lotPrice)}）`).join('、')}，策略和買進持有都只能放現金，報酬是 0。請提高投入金額。</div>`;
  if (!R.some(r => r.code === state.chartAsset)) state.chartAsset = R[0].code;

  html += `<div class="cards trend-cards">${R.map(r => {
    const s = r.stats, b = r.bh, n = r.events.length;
    const line = (k, a, bb, f, signed) => `<span class="k">${k}</span><span class="v ${signed ? cls(a) : ''}">${f(a)}</span><span class="v bh">${f(bb)}</span>`;
    return `<article class="acard" style="--c:${color(r.code)}">
      <div class="name"><span>${LABEL[r.code]}</span>${s.syntheticShare > 0 ? `<span class="badge">模擬 ${pct(s.syntheticShare, 0)}</span>` : ''}</div>
      <div class="big ${cls(s.cagr)}">${pct(s.cagr, 1, true)}</div>
      <div class="cap">策略年化 <span class="vs">· 買進持有 ${pct(b.cagr, 1, true)}</span></div>
      <div class="cmp">
        <span></span><span class="h">策略</span><span class="h">買進持有</span>
        ${line('總報酬', s.total, b.total, totalShort, true)}
        ${line('最大回撤', s.mdd, b.mdd, x => pct(x, 1), false)}
        ${line('最長套牢', s, b, uwShort, false)}
        ${line('期末金額', s.final, b.final, moneyShort, false)}
      </div>
      <dl class="kv">
        <dt>進出次數</dt><dd>${n}</dd>
        <dt>持有股票的時間</dt><dd>${pct(s.inMarket, 0)}</dd>
        <dt>起始狀態</dt><dd style="font-family:inherit">${r.startStatus}</dd>
      </dl>
      <details class="more"><summary>更多指標</summary>
        <div class="cmp">
          <span></span><span class="h">策略</span><span class="h">買進持有</span>
          ${line('年化波動', s.vol, b.vol, x => pct(x), false)}
          ${line('夏普', s.sharpe, b.sharpe, num2, false)}
          ${line('卡瑪', s.calmar, b.calmar, num2, false)}
          ${line('最好年度', s.bestYear, b.bestYear, x => pct(x, 1, true), true)}
          ${line('最差年度', s.worstYear, b.worstYear, x => pct(x, 1, true), true)}
        </div>
        <dl class="kv">${mddDetail(s, '策略')}</dl>
      </details>
    </article>`;
  }).join('')}</div>`;

  const r = R.find(x => x.code === state.chartAsset);
  html += `<section class="card">
    <div class="chart-head"><h3>資產成長</h3>
      <div class="seg" id="scaleSeg"><button type="button" data-log="1" aria-pressed="${state.log}">對數</button><button type="button" data-log="0" aria-pressed="${!state.log}">一般</button></div></div>
    ${R.length > 1 ? `<div class="chips presets" id="chartAssetSeg" style="margin:4px 0 8px">${R.map(x => `<button class="chip" type="button" data-c="${x.code}" aria-pressed="${x.code === r.code}" style="color:var(--c-${x.code})"><span class="dot" style="background:var(--c-${x.code})"></span><span style="color:var(--text)">${SHORT[x.code]}</span></button>`).join('')}</div>` : ''}
    <div class="chart-box" id="cGrowth"></div>
    <div class="legend"><span><i style="background:${color(r.code)}"></i>${SHORT[r.code]} 策略</span><span><i style="background:${css('--muted')}"></i>買進持有</span>
      ${r.events.length > 40 ? `<span>進出 ${r.events.length} 次太多，圖上不標記；縮短區間就看得到</span>` : '<span>▼ 出場</span><span>▲ 接刀</span><span>● 轉回續抱</span>'}${r.stats.syntheticShare > 0 ? '<span><i class="dash"></i>虛線 = 模擬資料</span>' : ''}</div>
  </section>
  <section class="card"><h3>回撤</h3><div class="chart-box short" id="cDD"></div></section>`;

  // 進出紀錄
  const base = r.equity[0];
  const evRows = r.events.map(e => `<tr><td class="num">${e.date}</td><td>${ACT_LABEL[e.act]}${e.act === 2 ? ` 第 ${e.layer} 層` : ''}</td><td class="n">${e.price.toFixed(2)}</td><td class="n">${Math.round(e.lots).toLocaleString()}</td><td class="n">${(e.value / base).toFixed(2)}×</td></tr>`).join('');
  html += `<section class="card"><details ${r.events.length <= 12 ? 'open' : ''}><summary><b>${SHORT[r.code]} 進出紀錄（${r.events.length} 次）</b></summary>
    ${r.events.length ? `<div class="tbl-wrap"><table class="ev"><thead><tr><th>日期</th><th style="text-align:left">動作</th><th>收盤價</th><th>持有張數</th><th>當時淨值</th></tr></thead><tbody>${evRows}</tbody></table></div>`
      : '<p class="hint">這段期間沒有任何進出。</p>'}
    <p class="hint">參數：快線 ${r.params.maFast}、慢線 ${r.params.maSlow}、出場乘數 ${r.params.exitBuffer}、接刀間距 ${r.params.pyramidGap}、${r.params.pyramidLevels} 層、轉回斜率 ${r.params.recoverSlope}、強反彈 ${r.params.recoverStrong}</p>
  </details></section>`;

  $('results').innerHTML = html;
  $('scaleSeg').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; state.log = b.dataset.log === '1'; save(); run(); });
  $('chartAssetSeg')?.addEventListener('click', e => { const b = e.target.closest('.chip'); if (!b) return; state.chartAsset = b.dataset.c; save(); run(); });

  const x = Float64Array.from(r.dayIdx, d => d * DAY_MS);
  const dash = r.stats.syntheticUntil >= 0 ? r.dayIdx[r.stats.syntheticUntil] * DAY_MS : undefined;
  const evByDate = new Map(r.events.map(e => [e.date, ACT_LABEL[e.act] + (e.act === 2 ? ` 第 ${e.layer} 層` : '')]));
  const fmt = v => (v >= 10 ? v.toFixed(0) : v >= 1 ? v.toFixed(1) : v.toFixed(2)).replace(/\.0$/, '') + '×';
  charts.growth = new LineChart($('cGrowth'), {
    series: [
      { name: '買進持有', color: css('--muted'), x, y: Float64Array.from(r.bhEquity, v => v / r.bhEquity[0]), dashUntil: dash },
      { name: '策略', color: color(r.code), x, y: Float64Array.from(r.equity, v => v / base), dashUntil: dash },
    ],
    markers: r.events.length > 40 ? [] : r.events.map(e => ({ x: data_ms(e.i), y: e.value / base, color: color(r.code), shape: ACT_SHAPE[e.act] })),
    log: state.log, yFmt: fmt, tipFmt: v => v.toFixed(2) + ' 倍', tipNote: d => evByDate.get(d), ariaLabel: '策略與買進持有的資產成長',
  });
  const ddSeries = (eq, name, col) => {
    const n = eq.length, step = Math.max(1, Math.ceil(n / 1200)), xs = [], ys = [];
    let peak = -Infinity, m = 0, mv = Infinity;
    for (let i = 0; i < n; i++) {
      peak = Math.max(peak, eq[i]); const dd = eq[i] / peak - 1;
      if (dd < mv) { mv = dd; m = i; }
      if ((i + 1) % step === 0 || i === n - 1) { xs.push(r.dayIdx[m] * DAY_MS); ys.push(mv * 100); mv = Infinity; }
    }
    return { name, color: col, x: Float64Array.from(xs), y: Float64Array.from(ys) };
  };
  charts.dd = new LineChart($('cDD'), {
    series: [ddSeries(r.bhEquity, '買進持有', css('--muted')), ddSeries(r.equity, '策略', color(r.code))],
    yMax: 0, width: 1.2, yFmt: v => Math.round(v) + '%', tipFmt: v => v.toFixed(1) + '%', ariaLabel: '回撤圖',
  });
}
const data_ms = i => DATA.days[i] * DAY_MS;

// ---------- 均線趨勢：多區間 ----------
function renderTrendMulti(rows, title) {
  destroyCharts();
  const list = codes().filter(c => rows.some(r => r.code === c));
  if (!rows.length) {
    $('results').innerHTML = `<div class="warn">沒有符合條件的區間。${state.useSyn ? '' : '只用真實資料時可用的期間較短，加上均線要先累積 240 天，試試縮短長度或開啟模擬資料。'}</div>`;
    return;
  }
  const m = state.metric, M = METRICS[m];
  const bhKey = { cagr: 'bhCagr', mdd: 'bhMdd', total: 'bhTotal' };
  const asBh = rows.map(r => ({ code: r.code, start: r.start, end: r.end, cagr: r.bhCagr, mdd: r.bhMdd, total: r.bhTotal, uw: r.bhUw }));
  const ds = { cagr: E.describe(rows, list, 'cagr'), mdd: E.describe(rows, list, 'mdd'), total: E.describe(rows, list, 'total'), uw: E.describe(rows, list, 'uw') };
  const db = { cagr: E.describe(asBh, list, 'cagr'), mdd: E.describe(asBh, list, 'mdd'), total: E.describe(asBh, list, 'total'), uw: E.describe(asBh, list, 'uw') };
  const counts = list.map(c => ds.cagr[c].count);
  const win = Object.fromEntries(list.map(c => {
    const g = rows.filter(r => r.code === c);
    return [c, { cagr: g.filter(r => r.cagr > r.bhCagr).length / g.length, mdd: g.filter(r => r.mdd > r.bhMdd).length / g.length }];
  }));
  const syn = Object.fromEntries(list.map(c => { const g = rows.filter(r => r.code === c); return [c, g.reduce((a, r) => a + r.syntheticShare, 0) / g.length]; }));

  let html = `<section class="card"><h3>${esc(title)}</h3>
    <p class="hint">共 ${Math.max(...counts)} 段${new Set(counts).size > 1 ? `（各標的可用段數不同：${list.map(c => `${SHORT[c]} ${ds.cagr[c].count}`).join('、')}）` : ''}。
    ${list.some(c => syn[c] > 0) ? `平均含模擬資料：${list.map(c => `${SHORT[c]} ${pct(syn[c], 0)}`).join('、')}。` : ''}</p>
    <p class="hint">策略年化贏過買進持有：${list.map(c => `${SHORT[c]} <b>${pct(win[c].cagr, 0)}</b>`).join('、')}；
      最大回撤比較小：${list.map(c => `${SHORT[c]} <b>${pct(win[c].mdd, 0)}</b>`).join('、')}</p>
    <div class="chart-head" style="margin-top:12px"><b style="font-size:14px">分布</b>
      <div class="seg" id="metricSeg">${Object.entries(METRICS).map(([k, v]) => `<button type="button" data-m="${k}" aria-pressed="${k === m}">${v.label}</button>`).join('')}</div></div>
    ${rangeBars(list.flatMap(c => [
      { label: `${SHORT[c]} 策略`, color: color(c), s: ds[m][c] },
      { label: `${SHORT[c]} 買進持有`, color: css('--muted'), s: db[m][c] },
    ]), M)}
  </section>`;

  const pair = (a, b, sign) => `<td class="n pair"><b class="${cls(a)}">${pct(a, 1, sign)}</b><small>${pct(b, 1, sign)}</small></td>`;
  const pairT = (a, b) => `<td class="n pair"><b>${a}</b><small>${b}</small></td>`;
  const row = (lbl, f, em) => `<tr class="${em ? 'em' : ''}"><td class="lbl">${lbl}</td>${list.map(c => f(c)).join('')}</tr>`;
  const grp = t => `<tr class="grp"><td colspan="${list.length + 1}">${t}</td></tr>`;
  html += `<section class="card"><h3>統計表</h3><p class="hint">每格上面是策略，下面灰色是同一段期間的買進持有。</p><div class="tbl-wrap"><table>
    <thead><tr><th></th>${list.map(c => `<th><span class="dot" style="background:${color(c)}"></span>${SHORT[c]}</th>`).join('')}</tr></thead><tbody>
    ${grp('年化報酬')}
    ${row('中位數', c => pair(ds.cagr[c].p50, db.cagr[c].p50, true), true)}
    ${row('平均', c => pair(ds.cagr[c].mean, db.cagr[c].mean, true))}
    ${row('最差', c => pair(ds.cagr[c].min, db.cagr[c].min, true))}
    ${row('5%', c => pair(ds.cagr[c].p5, db.cagr[c].p5, true))}
    ${row('25%', c => pair(ds.cagr[c].p25, db.cagr[c].p25, true))}
    ${row('75%', c => pair(ds.cagr[c].p75, db.cagr[c].p75, true))}
    ${row('95%', c => pair(ds.cagr[c].p95, db.cagr[c].p95, true))}
    ${row('最好', c => pair(ds.cagr[c].max, db.cagr[c].max, true))}
    ${row('虧損機率', c => `<td class="n pair"><b>${pct(ds.cagr[c].lossProb)}</b><small>${pct(db.cagr[c].lossProb)}</small></td>`, true)}
    ${grp('最大回撤')}
    ${row('中位數', c => pair(ds.mdd[c].p50, db.mdd[c].p50), true)}
    ${row('最差', c => pair(ds.mdd[c].min, db.mdd[c].min))}
    ${grp('最長套牢')}
    ${row('中位數', c => pairT(dur(ds.uw[c].p50), dur(db.uw[c].p50)), true)}
    ${row('95%', c => pairT(dur(ds.uw[c].p95), dur(db.uw[c].p95)))}
    ${row('最長', c => pairT(dur(ds.uw[c].max), dur(db.uw[c].max)))}
    ${row('期末還在套牢', c => pairT(pct(openShare(rows, c, 'uwOpen'), 0), pct(openShare(rows, c, 'bhUwOpen'), 0)))}
    </tbody></table></div><p class="hint" style="margin-top:10px">${UW_HINT}「期末還在套牢」= 最長那次到期末還沒結束的區間比例。</p></section>`;

  const diffLabel = { cagr: '策略年化 − 買進持有年化（百分點）', mdd: '策略回撤 − 買進持有回撤（百分點，正 = 回撤較小）', total: '策略總報酬 − 買進持有總報酬（百分點）' }[m];
  html += `<section class="card"><h3>策略多賺（少賠）多少，依起始日</h3><p class="hint">${diffLabel}。0 以上 = 策略比較好。</p>
    <div class="chart-box" id="cScatter"></div>${legendHtml(list, false)}</section>`;

  const wb = E.worstBest(rows, list, m === 'mdd' ? 'mdd' : 'cagr');
  html += `<section class="card"><h3>策略最差與最好的區間</h3><div class="wb">
    ${list.map(c => `<div class="wb-item" style="--c:${color(c)}"><div class="t">${LABEL[c]}</div>
      ${['worst', 'best'].map(k => { const r = wb[c][k]; return `<div class="wb-row">
        <span class="wb-k">${k === 'worst' ? '最差' : '最好'}</span>
        <span class="num wb-d">${r.start} ～ ${r.end}</span>
        <span class="num ${cls(r.cagr)}">${pct(r.cagr, 1, true)}</span>
        <span class="num neg">${pct(r.mdd, 0)}</span></div>
        <div class="wb-row" style="padding-top:0"><span></span><span class="wb-d">同期買進持有</span>
        <span class="num wb-d">${pct(r.bhCagr, 1, true)}</span><span class="num wb-d">${pct(r.bhMdd, 0)}</span></div>`; }).join('')}
    </div>`).join('')}
  </div><p class="hint">每列依序為：期間、年化報酬、期間內最大回撤</p></section>`;

  $('results').innerHTML = html;
  $('metricSeg').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; state.metric = b.dataset.m; save(); run(); });
  charts.scatter = new ScatterChart($('cScatter'), {
    series: list.map(c => ({
      name: SHORT[c], color: color(c),
      pts: rows.filter(r => r.code === c).map(r => ({ x: E.isoToDay(r.start) * DAY_MS, y: (r[m] - r[bhKey[m]]) * 100, label: `${r.start} ～ ${r.end}` })),
    })),
    yFmt: v => Math.round(v), tipFmt: v => (v > 0 ? '+' : '') + v.toFixed(1) + ' 點', ariaLabel: '策略減買進持有散布圖',
  });
}

// ---------- 參數穩健性 ----------
const PNAME = { maFast: '快線', maSlow: '慢線', exitBuffer: '出場乘數', pyramidGap: '接刀間距', pyramidLevels: '接刀層數', recoverSlope: '轉回斜率', recoverStrong: '強反彈' };
// better：1 = 越大越好、−1 = 越小越好（熱力圖藍色越濃越好）；good = 說明文字「什麼叫好」
const ROB_METRICS = {
  cagr: { label: '年化', fmt: v => pct(v, 1), better: 1, good: '年化越高' },
  mdd: { label: '最大回撤', fmt: v => pct(v, 0), better: 1, good: '跌得越少（例如 −45% 比 −60% 好）' },
  calmar: { label: '報酬回撤比', fmt: num2, better: 1, good: '報酬回撤比越高' },
  rollWin: { label: '10 年贏持有', fmt: v => pct(v, 0), better: 1, good: '贏的比例越高' },
  uw: { label: '最長套牢', fmt: dur, better: -1, good: '套牢越短' },
};
const OBJ_LABEL = { cagr: '年化', calmar: '報酬回撤比' };
const comboText = (sw, c) => sw.names.map(k => `${PNAME[k]} ${c[k]}`).join('、');
const objFmt = (obj, v) => obj === 'cagr' ? pct(v, 1) : num2(v);
// 分界、起點不合理時自動調整（同 scripts/robustness.py）：樣本內外兩段都要至少 3 年；walk-forward 第一次挑之前要至少 3 年
function robDates(sw) {
  const d0 = sw.days[0], d1 = sw.days[sw.days.length - 1], notes = [];
  const y0 = new Date(d0 * DAY_MS).getUTCFullYear();
  let split = state.robSplit, ws = state.robWfStart;
  if (!(E.isoToDay(split) >= E.addMonths(d0, 36) && E.isoToDay(split) <= E.addMonths(d1, -36))) {
    split = `${new Date((d0 + (d1 - d0) / 2) * DAY_MS).getUTCFullYear()}-01-01`;
    notes.push(`樣本內外分界改成 ${split}`);
  }
  const minWs = `${y0 + 4}-01-01`;
  if (ws < minWs || E.isoToDay(ws) > E.addMonths(d1, -12)) { ws = minWs; notes.push(`walk-forward 改從 ${ws} 開始`); }
  return { split, ws, notes };
}

function renderRobust() {
  destroyCharts();
  const code = state.robAsset, obj = state.robObj;
  const sw = E.paramSweep(DATA, code, opts(), state.trendCustom, state.robGrid);
  const full = E.sweepTable(sw);
  const { split, ws, notes } = robDates(sw);
  const sp = E.sweepSplit(sw, split, obj);
  const wf = E.sweepWalkForward(sw, ws, state.robWfStep, obj);
  const rows = full.rows, N = rows.length, def = sw.def;
  const g = E.ROBUST_GRIDS[state.robGrid];
  const fixed = Object.keys(PNAME).filter(k => !sw.names.includes(k)).map(k => `${PNAME[k]} ${sw.base[k]}`).join('、');
  const rankFull = rows.map(r => r[obj]);
  const defRank = def >= 0 ? 1 + rankFull.filter(v => v > rankFull[def]).length : null;
  const beat = rows.filter(r => r.diff > 0).length;
  const corr = sp.corr;
  const verdict = !Number.isFinite(corr) ? '－' : corr >= 0.5 ? '一致：前段好的參數後段也好' : corr >= 0.2 ? '弱：有一點參考價值' : '沒關係或相反：用歷史挑這兩個參數沒有用';
  const c = color(code);
  let html = '';
  if (notes.length) html += `<div class="warn">策略從 ${full.start} 開始，${notes.join('；')}。</div>`;
  html += `<section class="card"><h3>${LABEL[code]} · ${g.label}（${N} 組）</h3>
    <p class="hint">${full.start} ～ ${full.end}，每組都從同一天開始。其他參數照你的設定：${esc(fixed)}。${def >= 0 ? `你的設定（${esc(comboText(sw, sw.combos[def]))}）在格子上標 ★。` : '<b>你的設定不在格子上</b>，排名與對照只看得到格子裡的組合。'}</p>
    <div class="kpis">
      <div class="kpi" style="--c:${c}"><div class="t">全期年化贏買進持有</div><div class="v">${beat} / ${N}</div><div class="s">買進持有年化 ${pct(full.bh.cagr, 1)}、回撤 ${pct(full.bh.mdd, 0)}</div></div>
      ${def >= 0 ? `<div class="kpi" style="--c:${c}"><div class="t">你的設定全期${OBJ_LABEL[obj]}排第</div><div class="v">${defRank} / ${N}</div><div class="s">${OBJ_LABEL[obj]} ${objFmt(obj, rows[def][obj])}；最好的 ${objFmt(obj, Math.max(...rankFull.filter(Number.isFinite)))}</div></div>` : ''}
      <div class="kpi" style="--c:${c}"><div class="t">樣本內外排名相關係數</div><div class="v ${corr < 0.2 ? 'neg' : ''}">${Number.isFinite(corr) ? (corr > 0 ? '+' : '') + corr.toFixed(2) : '－'}</div><div class="s">${verdict}</div></div>
      <div class="kpi" style="--c:${c}"><div class="t">walk-forward 年化</div><div class="v">${pct(wf.summary.wf.cagr, 1)}</div><div class="s">${wf.summary.def ? `一直用你的設定 ${pct(wf.summary.def.cagr, 1)}、` : ''}買進持有 ${pct(wf.summary.bh.cagr, 1)}（${ws} 起）</div></div>
    </div></section>`;

  // 熱力圖
  const M = ROB_METRICS[state.robMetric];
  const vals = rows.map(r => r[state.robMetric]).filter(Number.isFinite);
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const shade = v => { if (!Number.isFinite(v) || hi === lo) return 8; const f = (v - lo) / (hi - lo); return Math.round(6 + 40 * (M.better > 0 ? f : 1 - f)); };
  const tip = r => [comboText(sw, r), `年化 ${pct(r.cagr, 1)}（比持有 ${pct(r.diff, 1, true)}）`, `最大回撤 ${pct(r.mdd, 0)}`, `報酬回撤比 ${num2(r.calmar)}`,
    `最長套牢 ${dur(r.uw)}`, `10 年贏持有 ${pct(r.rollWin, 0)}`, `最差 10 年年化 ${pct(r.rollWorst, 1)}`, `進出 ${r.trades} 次`].join('\n');
  const best = rows.reduce((k, r, i) => (Number.isFinite(r[obj]) && (k < 0 || r[obj] > rows[k][obj]) ? i : k), -1);
  const nb = i => { const xi = Math.floor(i / sw.ys.length), yi = i % sw.ys.length, out = [];
    for (const [dx, dy] of [[0, 0], [-1, 0], [1, 0], [0, -1], [0, 1]]) { const x = xi + dx, y = yi + dy;
      if (x >= 0 && x < sw.xs.length && y >= 0 && y < sw.ys.length) out.push(rows[x * sw.ys.length + y][obj]); }
    const f = out.filter(Number.isFinite); return f.reduce((a, b) => a + b, 0) / f.length; };
  html += `<section class="card"><div class="chart-head"><h3>熱力圖：每一格是一組參數</h3>
      <div class="seg" id="robMetricSeg">${Object.entries(ROB_METRICS).map(([k, m]) => `<button type="button" data-m="${k}" aria-pressed="${k === state.robMetric}">${m.label}</button>`).join('')}</div></div>
    <div class="tbl-wrap"><table class="heat"><thead><tr><th>${PNAME[sw.names[0]]} ＼ ${PNAME[sw.names[1]]}</th>${sw.ys.map(y => `<th>${y}</th>`).join('')}</tr></thead><tbody>
    ${sw.xs.map((x, xi) => `<tr><td class="lbl">${x}</td>${sw.ys.map((y, yi) => { const i = xi * sw.ys.length + yi, r = rows[i];
      return `<td data-i="${i}" class="${i === def ? 'me' : ''}" style="background:color-mix(in srgb, var(--accent) ${shade(r[state.robMetric])}%, transparent)" title="${esc(tip(r))}">${M.fmt(r[state.robMetric])}${i === def ? ' ★' : ''}</td>`; }).join('')}</tr>`).join('')}
    </tbody></table></div>
    <p class="hint" id="robCell" style="white-space:pre-line">點一格看那組的所有數字。</p>
    <p class="hint"><b>藍色越濃 = 越好</b>（${M.good}）。好的參數附近應該是一片顏色差不多的高原；只有一格特別濃、旁邊都很淡 = 尖峰，八成是運氣。</p>
    ${best >= 0 ? `<p class="hint">全期${OBJ_LABEL[obj]}最高：${esc(comboText(sw, rows[best]))} = ${objFmt(obj, rows[best][obj])}，跟上下左右鄰居平均 ${objFmt(obj, nb(best))}${def >= 0 ? `；你的設定 ${objFmt(obj, rows[def][obj])}，鄰居平均 ${objFmt(obj, nb(def))}` : ''}。</p>` : ''}
    <p class="hint">「10 年贏持有」= ${full.windows} 個 10 年區間（每月一個起點）裡，策略年化比買進持有高的比例${full.windows < 36 ? '（區間太少，參考就好）' : ''}。</p></section>`;

  // 樣本內外
  const med = (t, k) => E.quantile(t.rows.map(r => r[k]).filter(Number.isFinite).sort((a, b) => a - b), 0.5);
  const spRow = (name, i, cls = '') => { const a = sp.ins.rows[i], b = sp.oos.rows[i];
    return `<tr class="${cls}"><td>${name}<br><small style="color:var(--muted)">${esc(comboText(sw, a))}</small></td><td>${objFmt(obj, a[obj])}</td><td>${pct(b.cagr, 1)}</td><td>${pct(b.mdd, 0)}</td><td>${num2(b.calmar)}</td><td>${Math.trunc(sp.rOut[i])} / ${N}</td></tr>`; };
  html += `<section class="card"><h3>樣本內外：前段挑、後段驗證</h3>
    <p class="hint">樣本內 ${sp.ins.start} ～ ${sp.ins.end}，樣本外 ${sp.oos.start} ～ ${sp.oos.end}，用${OBJ_LABEL[obj]}挑。排名相關係數 <b>${Number.isFinite(corr) ? corr.toFixed(2) : '－'}</b>：${verdict}。</p>
    <div class="tbl-wrap"><table><thead><tr><th></th><th>樣本內${OBJ_LABEL[obj]}</th><th>樣本外年化</th><th>回撤</th><th>報酬回撤比</th><th>樣本外排名</th></tr></thead><tbody>
      ${spRow('樣本內最好的', sp.best, 'em')}
      ${def >= 0 && def !== sp.best ? spRow('你的設定', def) : ''}
      <tr><td>所有組合中位數</td><td>${objFmt(obj, med(sp.ins, obj))}</td><td>${pct(med(sp.oos, 'cagr'), 1)}</td><td>${pct(med(sp.oos, 'mdd'), 0)}</td><td>${num2(med(sp.oos, 'calmar'))}</td><td></td></tr>
      <tr><td>買進持有</td><td>${objFmt(obj, sp.ins.bh[obj])}</td><td>${pct(sp.oos.bh.cagr, 1)}</td><td>${pct(sp.oos.bh.mdd, 0)}</td><td>${num2(sp.oos.bh.calmar)}</td><td></td></tr>
    </tbody></table></div>
    <div class="chart-box" id="cRobSplit" style="margin-top:12px"></div>
    <div class="legend"><span><i style="background:${c}"></i>每一組參數</span>${def >= 0 ? `<span><i style="background:${css('--text')}"></i>你的設定</span>` : ''}<span><i style="background:${css('--c-alt')}"></i>樣本內最好的</span></div>
    <p class="hint">橫軸 = 樣本內${OBJ_LABEL[obj]}、縱軸 = 樣本外${OBJ_LABEL[obj]}。點由左下往右上排 = 前段好的後段也好；散成一團或往右下 = 前段挑的沒用。${def >= 0 ? '預設參數是看過 2010 年後的行情才設的，它在樣本外表現好不算真正的驗證，walk-forward 才公平。' : ''}</p></section>`;

  // walk-forward
  const S = wf.summary;
  const sumRow = (name, s) => `<tr><td>${name}</td><td>${pct(s.cagr, 1)}</td><td>${pct(s.mdd, 0)}</td><td>${num2(s.calmar)}</td><td>${dur(s.uw)}</td></tr>`;
  html += `<section class="card"><h3>walk-forward：每 ${state.robWfStep} 年用之前的歷史重挑</h3>
    <p class="hint">每段開始那天，用「到前一天為止的全部歷史」挑${OBJ_LABEL[obj]}最高的組合，接下來 ${state.robWfStep} 年照用。這是當時的人做得到的最佳化。</p>
    <div class="chart-box" id="cRobWf"></div>
    <div class="legend"><span><i style="background:${css('--c-alt')}"></i>walk-forward</span>${S.def ? `<span><i style="background:${c}"></i>一直用你的設定</span>` : ''}<span><i style="background:${css('--muted')}"></i>買進持有</span></div>
    <div class="tbl-wrap" style="margin-top:10px"><table><thead><tr><th></th><th>年化</th><th>最大回撤</th><th>報酬回撤比</th><th>最長套牢</th></tr></thead><tbody>
      ${sumRow('walk-forward', S.wf)}${S.def ? sumRow('一直用你的設定', S.def) : ''}${sumRow('買進持有', S.bh)}</tbody></table></div>
    <div class="tbl-wrap" style="margin-top:10px"><table><thead><tr><th>期間</th><th>選了</th><th>這段年化</th><th>你的設定</th><th>買進持有</th></tr></thead><tbody>
      ${wf.blocks.map(b => `<tr><td>${b.start}<br><small style="color:var(--muted)">～ ${b.end}</small></td><td>${esc(comboText(sw, b.combo))}${b.isDef ? ' ★' : ''}</td><td class="${cls(b.cagr)}">${pct(b.cagr, 1, true)}</td><td>${pct(b.defCagr, 1, true)}</td><td>${pct(b.bhCagr, 1, true)}</td></tr>`).join('')}
    </tbody></table></div>
    <p class="hint">各段績效從各組參數同一條淨值切出來，不含每段期初買、期末賣的成本；換參數那天也不算調整部位的成本。</p></section>`;

  $('results').innerHTML = html;
  $('robMetricSeg').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; state.robMetric = b.dataset.m; save(); renderRobust(); });
  document.querySelector('table.heat').addEventListener('click', e => { const td = e.target.closest('td[data-i]'); if (td) $('robCell').textContent = tip(rows[+td.dataset.i]); });

  const sc = v => obj === 'cagr' ? v * 100 : v, scFmt = v => obj === 'cagr' ? +v.toFixed(1) + '%' : +v.toFixed(2) + '';
  const pt = i => ({ x: sc(sp.ins.rows[i][obj]), y: sc(sp.oos.rows[i][obj]), label: `${comboText(sw, sw.combos[i])}；樣本內 ${objFmt(obj, sp.ins.rows[i][obj])}` });
  const okPt = p => Number.isFinite(p.x) && Number.isFinite(p.y);
  charts.robSplit = new ScatterChart($('cRobSplit'), {
    series: [{ name: '參數組合', color: c, pts: sw.combos.map((_, i) => pt(i)).filter(okPt) },
      ...(def >= 0 ? [{ name: '你的設定', color: css('--text'), pts: [pt(def)].filter(okPt) }] : []),
      { name: '樣本內最好的', color: css('--c-alt'), pts: [pt(sp.best)].filter(okPt) }],
    xNumeric: true, free: true, xFmt: scFmt, yFmt: scFmt, xLabel: `樣本內${OBJ_LABEL[obj]} →`, yLabel: `↑ 樣本外${OBJ_LABEL[obj]}`,
    tipFmt: v => obj === 'cagr' ? v.toFixed(1) + '%' : v.toFixed(2), ariaLabel: '樣本內與樣本外績效散布圖',
  });
  const x = Float64Array.from(wf.days, d => d * DAY_MS);
  charts.robWf = new LineChart($('cRobWf'), {
    series: [{ name: 'walk-forward', color: css('--c-alt'), x, y: wf.curves.wf },
      ...(wf.curves.def ? [{ name: '你的設定', color: c, x, y: wf.curves.def }] : []),
      { name: '買進持有', color: css('--muted'), x, y: wf.curves.bh }],
    log: true, yFmt: v => (v >= 10 ? v.toFixed(0) : v >= 1 ? v.toFixed(1) : v.toFixed(2)).replace(/\.0$/, '') + '×',
    tipFmt: v => v.toFixed(2) + ' 倍', ariaLabel: 'walk-forward 資產成長圖',
  });
}

// ---------- 蒙地卡羅 ----------
const BLOCK_LABEL = { 1: '每天打亂', 20: '約 1 個月', 60: '約 3 個月', 120: '約半年', 250: '約 1 年' };
function mcKey(compare) {
  return JSON.stringify([compare, state.strategy, state.strategy === 'rebal' ? rbCfg() : 0, codes(), state.useSyn, state.excess, state.signalPrice, state.trendCustom, state.capital,
    state.discount, state.mcN, state.mcYears, state.mcSeed, compare ? 0 : state.mcBlock]);
}
function renderMCIdle() {
  destroyCharts();
  $('status').textContent = '';
  if (mcLast && mcLast.key === mcKey(mcLast.compare)) {
    if (mcLast.rebal) { mcLast.compare ? renderRbMCCompare(mcLast) : renderRbMC(mcLast); } else { mcLast.compare ? renderMCCompare(mcLast) : renderMC(mcLast); }
    return;
  }
  const sec = state.strategy === 'rebal' ? state.mcN * state.mcYears / 5000 : state.mcN * codes().length * state.mcYears / 12000;
  $('results').innerHTML = `<div class="card"><p class="hint" style="margin:0">設定好之後按「開始模擬」。${state.mcN.toLocaleString()} 條大約要 ${Math.max(1, Math.round(sec))} 秒（手機會慢一點）。最多 ${MC_MAX.toLocaleString()} 條；「比較各種區塊長度」要跑 5 組，每組最多 ${state.strategy === 'rebal' ? 500 : 1000} 條。</p></div>`;
}

async function runMC(compare) {
  if (state.strategy === 'rebal') return runRbMC(compare);
  if (!codes().length) { $('results').innerHTML = '<div class="warn">請至少選一檔 0050、00631L 或 00675L。</div>'; return; }
  const token = ++mcToken; mcRunning = { key: mcKey(compare), compare };
  const blocks = compare ? [1, 20, 60, 120, 250] : [state.mcBlock];
  const n = compare ? Math.min(state.mcN, 1000) : state.mcN;
  const jobs = blocks.flatMap(b => codes().map(c => [b, c]));
  destroyCharts();
  $('results').innerHTML = `<div class="card"><b>模擬中…</b><div class="progress"><i id="mcBar"></i></div><p class="hint" id="mcProg"></p></div>`;
  $('mcRun').disabled = $('mcCompare').disabled = true;
  const t0 = performance.now(), out = [];
  try {
    for (let j = 0; j < jobs.length; j++) {
      const [block, code] = jobs[j];
      const res = await E.monteCarlo(DATA, code, opts(), state.trendCustom,
        { n, years: state.mcYears, block, seed: state.mcSeed + block }, f => {
          if (token !== mcToken) return false;
          $('mcBar').style.width = `${((j + f) / jobs.length) * 100}%`;
          $('mcProg').textContent = `${SHORT[code]} · 每段${BLOCK_LABEL[block] ?? block + ' 天'} · ${Math.round(f * n)} / ${n}`;
        });
      if (!res || token !== mcToken) return;
      out.push({ block, ...res });
    }
  } catch (err) {
    $('results').innerHTML = `<div class="warn">${esc(err.message)}</div>`; return;
  } finally {
    $('mcRun').disabled = $('mcCompare').disabled = false;
    if (token === mcToken) mcRunning = null;
  }
  mcLast = { key: mcKey(compare), compare, out, n, years: state.mcYears, block: state.mcBlock };
  $('status').textContent = `模擬 ${out.length * n} 條，${(Math.round(performance.now() - t0) / 1000).toFixed(1)} 秒`;
  compare ? renderMCCompare(mcLast) : renderMC(mcLast);
}

async function runRbMC(compare) {
  let cfg;
  try { cfg = rbCfg(); E.normWeights(cfg.weights); } catch (err) { $('results').innerHTML = `<div class="warn">${esc(err.message)}</div>`; return; }
  const token = ++mcToken; mcRunning = { key: mcKey(compare), compare };
  const blocks = compare ? [1, 20, 60, 120, 250] : [state.mcBlock];
  const n = compare ? Math.min(state.mcN, 500) : state.mcN;
  destroyCharts();
  $('results').innerHTML = `<div class="card"><b>模擬中…</b><div class="progress"><i id="mcBar"></i></div><p class="hint" id="mcProg"></p></div>`;
  $('mcRun').disabled = $('mcCompare').disabled = true;
  const t0 = performance.now(), out = [];
  try {
    for (let j = 0; j < blocks.length; j++) {
      const block = blocks[j];
      const res = await E.rebalMonteCarlo(DATA, cfg, opts(), state.trendCustom, { n, years: state.mcYears, block, seed: state.mcSeed + block }, f => {
        if (token !== mcToken) return false;
        $('mcBar').style.width = `${((j + f) / blocks.length) * 100}%`;
        $('mcProg').textContent = `每段${BLOCK_LABEL[block]} · ${Math.round(f * n)} / ${n}（每條同時算再平衡、對照組）`;
      });
      if (!res || token !== mcToken) return;
      out.push({ block, ...res });
    }
  } catch (err) { $('results').innerHTML = `<div class="warn">${esc(err.message)}</div>`; return; }
  finally { $('mcRun').disabled = $('mcCompare').disabled = false; if (token === mcToken) mcRunning = null; }
  mcLast = { key: mcKey(compare), compare, rebal: true, cfg, out, n, years: state.mcYears, block: state.mcBlock };
  $('status').textContent = `模擬 ${out.length * n} 條，${(Math.round(performance.now() - t0) / 1000).toFixed(1)} 秒`;
  compare ? renderRbMCCompare(mcLast) : renderRbMC(mcLast);
}
const RB_MC_KEYS = [['main', 'cagr', 'mdd', 'uw'], ['noTr', 'noTrCagr', 'noTrMdd', 'noTrUw'], ['flat', 'flatCagr', 'flatMdd', 'flatUw'], ['bh50', 'bhCagr', 'bhMdd', 'bhUw'], ['tr631', 'trCagr', 'trMdd', 'trUw']];
function renderRbMC(m) {
  destroyCharts();
  const o = m.out[0], rows = o.rows, n = rows.length;
  const keys = RB_MC_KEYS.filter(([, c]) => rows[0]?.[c] !== undefined);   // 沒搭配均線時沒有「不搭配均線」那一組
  const sets = keys.map(([k, c, d, u]) => ({ k, cagr: rows.map(r => r[c]), mdd: rows.map(r => r[d]), uw: rows.map(r => r[u]) }));
  const share = f => pct(rows.filter(f).length / n, 0);
  const vs = keys.slice(1).map(([k, c, d, u]) => `${rbLabel(k)}：報酬贏 <b>${share(r => r.cagr > r[c])}</b>、回撤小 <b>${share(r => r.mdd > r[d])}</b>、套牢短 <b>${share(r => r.uw < r[u])}</b>`).join('<br>');
  $('results').innerHTML = `<section class="card"><h3>${n.toLocaleString()} 條 ${m.years} 年模擬行情 · 每段${BLOCK_LABEL[m.block]}</h3>
    <p class="hint">${esc(cfgLabel(m.cfg))} · 取樣 ${o.from}～${o.to}${state.useSyn ? '（含上市前模擬）' : '（只用真實資料）'}。模擬行情沒有日曆，「每季」用 63 個交易日近似。</p>
    <p class="hint">你的設定 vs ${vs}</p>
    ${rebalCompareTable(sets)}</section>
    <section class="card"><h3>每一條模擬：0050 買進持有 vs 再平衡策略（年化報酬）</h3><div class="chart-box" id="cScatter"></div>
    <p class="hint">虛線上方 = 那條行情再平衡策略賺得比 0050 買進持有多。</p></section>`;
  const step = Math.max(1, Math.ceil(n / 2000));
  charts.scatter = new ScatterChart($('cScatter'), {
    series: [{ name: '再平衡', color: css('--text'), pts: rows.filter((_, i) => i % step === 0).map(r => ({ x: r.bhCagr * 100, y: r.cagr * 100, label: `0050 持有 ${(r.bhCagr * 100).toFixed(1)}%` })) }],
    xNumeric: true, square: true, diagonal: true, xFmt: v => Math.round(v) + '%', yFmt: v => Math.round(v) + '%',
    xLabel: '0050 持有年化 →', yLabel: '↑ 再平衡年化', tipFmt: v => (v > 0 ? '+' : '') + v.toFixed(1) + '%', ariaLabel: '散布圖',
  });
}
function renderRbMCCompare(m) {
  destroyCharts();
  const pc = (rows, f) => pct(rows.filter(f).length / rows.length, 0);
  const q = (a, p) => E.quantile([...a].sort((x, y) => x - y), p);
  $('results').innerHTML = `<section class="card"><h3>各種區塊長度比較（每組 ${m.n.toLocaleString()} 條 ${m.years} 年）</h3>
    <p class="hint">${esc(cfgLabel(m.cfg))}。「你的設定」那欄：年化中位數，下面是回撤中位數與最長套牢中位數；其他欄：報酬贏過對照組的機率，下面是回撤比較小、套牢比較短的機率。</p>
    <div class="tbl-wrap"><table class="cmp-tbl"><thead><tr><th>每段</th><th>你的設定</th>${m.out[0].rows[0]?.noTrCagr !== undefined ? '<th>vs 不搭配均線</th>' : ''}<th>vs 不再平衡</th><th>vs 0050 持有</th><th>vs 00631L 均線</th></tr></thead><tbody>
    ${m.out.map(o => { const r = o.rows; return `<tr><td class="lbl">${BLOCK_LABEL[o.block]}</td>
      <td class="n pair"><b>${pct(q(r.map(x => x.cagr), .5), 1, true)}</b><small>${pct(q(r.map(x => x.mdd), .5), 0)} · ${dur(q(r.map(x => x.uw), .5))}</small></td>
      ${[...(r[0]?.noTrCagr !== undefined ? [['noTrCagr', 'noTrMdd', 'noTrUw']] : []), ['flatCagr', 'flatMdd', 'flatUw'], ['bhCagr', 'bhMdd', 'bhUw'], ['trCagr', 'trMdd', 'trUw']].map(([c, d, u]) => `<td class="n pair"><b>${pc(r, x => x.cagr > x[c])}</b><small>回撤小 ${pc(r, x => x.mdd > x[d])}<br>套牢短 ${pc(r, x => x.uw < x[u])}</small></td>`).join('')}</tr>`; }).join('')}
    </tbody></table></div></section>`;
}

function renderMC(m) {
  destroyCharts();
  const { out, n, years, block } = m;
  const list = out.map(o => o.code);
  if (!list.includes(state.chartAsset)) state.chartAsset = list[0];
  const sums = Object.fromEntries(out.map(o => [o.code, E.mcSummary(o.rows)]));
  const src = out[0].source;
  const metric = state.mcMetric;
  const asRows = (o, bh) => o.rows.map(r => {
    const c = bh ? r.bhCagr : r.cagr;
    return { code: o.code, cagr: c, mdd: bh ? r.bhMdd : r.mdd, total: (1 + c) ** years - 1 };
  });
  let html = `<section class="card"><h3>${n.toLocaleString()} 條 ${years} 年模擬行情 · 每段${BLOCK_LABEL[block] ?? block + ' 天'}</h3>
    <p class="hint">取樣歷史：${out.map(o => `${SHORT[o.code]} ${o.source.from}～${o.source.to}`).join('、')}${state.useSyn ? '（含上市前模擬）' : '（只用真實資料）'}。每條都扣手續費與證交稅。</p>
    ${list.map(c => { const s = sums[c]; return `<div style="margin-top:14px"><b style="font-size:14px">${LABEL[c]}</b><div class="kpis">
      <div class="kpi" style="--c:${color(c)}"><div class="t">策略報酬贏的機率</div><div class="v">${pct(s.win, 0)}</div><div class="s">${years} 年後年化報酬比較高</div></div>
      <div class="kpi" style="--c:${color(c)}"><div class="t">年化多賺（中位數）</div><div class="v ${cls(s.diff50)}">${(s.diff50 * 100 > 0 ? '+' : '') + (s.diff50 * 100).toFixed(1)}</div><div class="s">百分點；5%～95%：${(s.diff5 * 100).toFixed(1)}～${(s.diff95 * 100).toFixed(1)}</div></div>
      <div class="kpi" style="--c:${color(c)}"><div class="t">最大回撤比較小的機率</div><div class="v">${pct(s.mddBetter, 0)}</div><div class="s">平均每年進出 ${(s.trades / years).toFixed(1)} 次</div></div>
      <div class="kpi" style="--c:${color(c)}"><div class="t">${years} 年後還虧錢的機率</div><div class="v">${pct(s.loss, 0)}</div><div class="s">買進持有 ${pct(s.bhLoss, 0)}</div></div>
      <div class="kpi" style="--c:${color(c)}"><div class="t">最長套牢（中位數）</div><div class="v">${dur(s.uw50)}</div><div class="s">買進持有 ${dur(s.bhUw50)}；最慘 5%：${dur(s.uw95)} vs ${dur(s.bhUw95)}</div></div>
      <div class="kpi" style="--c:${color(c)}"><div class="t">套牢比較短的機率</div><div class="v">${pct(s.uwBetter, 0)}</div><div class="s">最長套牢比買進持有短</div></div>
    </div></div>`; }).join('')}
    <p class="hint" style="margin-top:12px">${UW_HINT}模擬行情沒有日期，時間用抽到的那幾天實際經過的日曆時間加總。</p>
  </section>`;

  const M = METRICS[metric];
  const dS = Object.fromEntries(out.map(o => [o.code, E.describe(asRows(o, false), [o.code], metric)[o.code]]));
  const dB = Object.fromEntries(out.map(o => [o.code, E.describe(asRows(o, true), [o.code], metric)[o.code]]));
  html += `<section class="card"><div class="chart-head"><h3>分布</h3>
      <div class="seg" id="mcMetricSeg">${['cagr', 'mdd'].map(k => `<button type="button" data-m="${k}" aria-pressed="${k === metric}">${METRICS[k].label}</button>`).join('')}</div></div>
    ${rangeBars(list.flatMap(c => [{ label: `${SHORT[c]} 策略`, color: color(c), s: dS[c] }, { label: `${SHORT[c]} 買進持有`, color: css('--muted'), s: dB[c] }]), M)}
  </section>`;

  html += `<section class="card"><h3>每一條模擬：買進持有 vs 策略（年化報酬）</h3>
    ${list.length > 1 ? `<div class="chips presets" id="chartAssetSeg" style="margin:4px 0 8px">${list.map(c => `<button class="chip" type="button" data-c="${c}" aria-pressed="${c === state.chartAsset}" style="color:var(--c-${c})"><span class="dot" style="background:var(--c-${c})"></span><span style="color:var(--text)">${SHORT[c]}</span></button>`).join('')}</div>` : ''}
    <div class="chart-box" id="cScatter"></div>
    <p class="hint">每個點是一條模擬行情。虛線上方 = 那條行情策略賺得比較多；越往左（買進持有很差的行情），策略通常越有幫助。</p></section>`;

  $('results').innerHTML = html;
  $('mcMetricSeg').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; state.mcMetric = b.dataset.m; save(); renderMC(m); });
  $('chartAssetSeg')?.addEventListener('click', e => { const b = e.target.closest('.chip'); if (!b) return; state.chartAsset = b.dataset.c; save(); renderMC(m); });
  const o = out.find(x => x.code === state.chartAsset);
  const step = Math.max(1, Math.ceil(o.rows.length / 2000));
  charts.scatter = new ScatterChart($('cScatter'), {
    series: [{ name: SHORT[o.code], color: color(o.code), pts: o.rows.filter((_, i) => i % step === 0).map(r => ({ x: r.bhCagr * 100, y: r.cagr * 100, label: `買進持有 ${(r.bhCagr * 100).toFixed(1)}%` })) }],
    xNumeric: true, square: true, diagonal: true, xFmt: v => Math.round(v) + '%', yFmt: v => Math.round(v) + '%',
    xLabel: '買進持有年化 →', yLabel: '↑ 策略年化', tipFmt: v => (v > 0 ? '+' : '') + v.toFixed(1) + '%', ariaLabel: '策略與買進持有年化報酬散布圖',
  });
}

function renderMCCompare(m) {
  destroyCharts();
  const { out, n, years } = m;
  const list = [...new Set(out.map(o => o.code))];
  const blocks = [...new Set(out.map(o => o.block))];
  const cell = (b, c) => { const o = out.find(x => x.block === b && x.code === c); const s = E.mcSummary(o.rows);
    return `<td class="n pair"><b>${pct(s.win, 0)}</b><small>${(s.diff50 > 0 ? '+' : '') + (s.diff50 * 100).toFixed(1)} 點 · 回撤小 ${pct(s.mddBetter, 0)} · 套牢短 ${pct(s.uwBetter, 0)}</small></td>`; };
  $('results').innerHTML = `<section class="card"><h3>各種區塊長度比較（每組 ${n.toLocaleString()} 條 ${years} 年）</h3>
    <p class="hint">每格上面是「策略報酬贏的機率」，下面是年化多賺的中位數、「最大回撤比較小的機率」與「最長套牢比較短的機率」。</p>
    <div class="tbl-wrap"><table><thead><tr><th>每段平均長度</th>${list.map(c => `<th><span class="dot" style="background:${color(c)}"></span>${SHORT[c]}</th>`).join('')}</tr></thead>
    <tbody>${blocks.map(b => `<tr><td class="lbl">${BLOCK_LABEL[b]}${b === 1 ? '<br><small>沒有趨勢（對照）</small>' : ''}</td>${list.map(c => cell(b, c)).join('')}</tr>`).join('')}</tbody></table></div>
    <p class="hint" style="margin-top:10px">怎麼看：每天打亂時，行情裡沒有趨勢，策略的報酬優勢應該消失；區塊越長、保留越多趨勢，策略越容易贏。真實台股在 1～6 個月的尺度上有趨勢延續，「約 3 個月」到「約半年」那兩列最接近現實。回撤比較小這件事在每一列都成立，是這個策略最穩的好處。</p></section>`;
}

// ---------- 版本檢查 ----------
// 打開中的網頁回到前景、或每 30 分鐘問一次 version.json；換版了：能換就自動重新整理（設定都有存），不能換（正在輸入、蒙地卡羅跑到一半）就跳提示
let newBuild = '';
function updateSafeNow() {
  const tag = document.activeElement?.tagName;
  return !(tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') && !mcRunning;
}
async function checkForUpdate() {
  if (!BUILD_HASH) return;
  try {
    const res = await fetch('version.json?t=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) return;
    const j = await res.json();
    if (j?.hash && j.hash !== BUILD_HASH) {
      newBuild = j.hash;
      let tried = null; try { tried = sessionStorage.getItem('twbt.autoUpdate'); } catch (_) { /* 無痕模式 */ }
      if (updateSafeNow() && tried !== newBuild) {            // 同一個新版只自動換一次（快取沒換掉時不會一直重新整理）
        try { sessionStorage.setItem('twbt.autoUpdate', newBuild); } catch (_) { /* 忽略 */ }
        location.reload(); return;
      }
      $('updateBanner').hidden = false;
    }
  } catch (_) { /* 離線或暫時連不上，下次再問 */ }
}

// ---------- 啟動 ----------
async function main() {
  restore();
  $('buildVer').textContent = BUILD_HASH ? `網頁版本 ${BUILD_DATE} · ${BUILD_HASH}` : '網頁版本（未標記）';
  $('updateBanner').addEventListener('click', () => location.reload());
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkForUpdate(); });
  setInterval(checkForUpdate, 30 * 60 * 1000);
  try {
    const res = await fetch('data/returns.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    DATA = E.prepare(await res.json());
  } catch (err) {
    $('updated').textContent = '資料載入失敗';
    $('results').innerHTML = `<div class="warn">讀不到資料檔 data/returns.json（${esc(err.message)}）。請稍後重新整理。</div>`;
    return;
  }
  $('updated').textContent = `資料更新至 ${DATA.updated}`;
  $('calibration').textContent = DATA.calibration;
  buildControls();
  run();
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => run());
}
main();
