// 介面：讀設定 → 呼叫 engine.js 計算 → 畫結果
import * as E from './engine.js';
import { LineChart, ScatterChart } from './plot.js';

const ORDER = ['TAIEX', '0050', '00631L', '00675L'];
const LABEL = { TAIEX: '大盤（含息）', '0050': '0050', '00631L': '00631L 台灣50正2', '00675L': '00675L 加權正2' };
const SHORT = { TAIEX: '大盤', '0050': '0050', '00631L': '00631L', '00675L': '00675L' };
const DAY_MS = 86400000;
const STORE_KEY = 'twbt.settings.v1';

const $ = id => document.getElementById(id);
const state = {
  mode: 'period', assets: new Set(ORDER), capital: 1_000_000, discount: 1, useSyn: true, excess: true,
  start: '2000-01-01', end: '', rollYears: 10, rndN: 500, rndMin: 5, rndMax: 15, seed: 42,
  metric: 'cagr', log: true,
  strategy: 'bh', trendCustom: { 1: {}, 2: {} }, signalPrice: 'raw', chartAsset: '00631L',
  mcN: 1000, mcYears: 10, mcSeed: 1, mcBlock: 120, mcMetric: 'cagr',
};
let mcLast = null, mcToken = 0;   // 上一次蒙地卡羅結果（設定一樣才顯示）、執行中的代號（換設定就作廢）
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
    });
  } catch (_) { /* 忽略 */ }
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
  const bindNum = (id, key, lo, hi) => $(id).addEventListener('input', () => {
    const v = Number($(id).value); if (Number.isFinite(v) && v >= lo && v <= hi) { state[key] = v; changed(); }
  });
  $('start').addEventListener('change', () => { state.start = $('start').value; changed(); });
  $('end').addEventListener('change', () => { state.end = $('end').value; changed(); });
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
  syncStrategyUI();

  // 蒙地卡羅：改設定不自動跑（比較久），按按鈕才跑
  for (const [id, key, lo, hi] of [['mcN', 'mcN', 100, 5000], ['mcYears', 'mcYears', 1, 30], ['mcSeed', 'mcSeed', -1e9, 1e9]]) {
    $(id).value = state[key];
    $(id).addEventListener('input', () => { const v = Number($(id).value); if (Number.isFinite(v) && v >= lo && v <= hi) { state[key] = Math.round(v); save(); run(); } });
  }
  $('mcBlock').value = String(state.mcBlock);
  $('mcBlock').addEventListener('change', () => { state.mcBlock = +$('mcBlock').value; save(); run(); });
  $('mcRun').addEventListener('click', () => runMC(false));
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
    const lev = +inp.dataset.lev, v = Number(inp.value);
    if (!Number.isFinite(v) || v < lo || v > hi) return;
    const int = ['maFast', 'maSlow', 'pyramidLevels'].includes(k);
    const vv = int ? Math.round(v) : v;
    if (vv === D[lev][k]) delete state.trendCustom[lev][k]; else state.trendCustom[lev][k] = vv;
    inp.classList.toggle('changed', state.trendCustom[lev][k] !== undefined);
    changed();
  };
}

function syncStrategyUI() {
  const trend = state.strategy === 'trend';
  $('stratName').textContent = trend ? '均線趨勢（接刀）' : '買進持有';
  $('strategySeg').querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', b.dataset.s === state.strategy));
  $('mcTab').hidden = !trend;
  if (!trend && state.mode === 'mc') { state.mode = 'period'; showMode(); }
  $('trendCard').hidden = !trend;
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
    if (state.strategy === 'trend') runTrend();
    else if (state.mode === 'period') renderPeriod(E.period(DATA, codes(), state.start, state.end, opts()));
    else if (state.mode === 'rolling') {
      const rows = E.rolling(DATA, codes(), state.rollYears, opts());
      renderMulti(rows, `${state.rollYears} 年滾動區間（每個月初一個起點）`);
    } else {
      const lo = Math.min(state.rndMin, state.rndMax), hi = Math.max(state.rndMin, state.rndMax);
      const rows = E.randomWindows(DATA, codes(), state.rndN, lo, hi, state.seed, opts());
      renderMulti(rows, `隨機 ${state.rndN} 個區間，長度 ${lo}～${hi} 年（種子 ${state.seed}）`);
    }
    if (!(state.strategy === 'trend' && state.mode === 'mc')) $('status').textContent = `計算 ${Math.round(performance.now() - t0)} 毫秒`;
  } catch (err) {
    $('results').innerHTML = `<div class="warn">${esc(err.message)}</div>`;
    $('status').textContent = '';
    console.error(err);
  }
}

function runTrend() {
  if (state.mode === 'mc') { mcToken++; renderMCIdle(); return; }
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

// ---------- 自訂區間 ----------
function renderPeriod(res) {
  destroyCharts();
  if (res.error) { $('results').innerHTML = `<div class="warn">${res.error}</div>`; return; }
  const skipped = res.skipped.map(s => `${LABEL[s.code]}（${state.useSyn ? '最早' : '真實資料最早'}可從 ${s.availableFrom} 開始）`);
  const anySyn = res.results.some(r => r.stats.syntheticShare > 0);
  let html = '';
  if (skipped.length) html += `<div class="warn">這段期間缺資料，已略過：${skipped.join('、')}</div>`;
  if (!res.results.length) { $('results').innerHTML = html; return; }

  html += `<div class="cards">${res.results.map(r => {
    const s = r.stats;
    return `<article class="acard" style="--c:${color(r.code)}">
      <div class="name"><span>${LABEL[r.code]}</span>${s.syntheticShare > 0 ? `<span class="badge">模擬 ${pct(s.syntheticShare, 0)}</span>` : ''}</div>
      <div class="big ${cls(s.cagr)}">${pct(s.cagr, 1, true)}</div>
      <div class="cap">年化報酬</div>
      <dl class="kv">
        <dt>總報酬</dt><dd class="${cls(s.total)}">${pct(s.total, 1, true)}</dd>
        <dt>最大回撤</dt><dd class="neg">${pct(s.mdd)}</dd>
        <dt>期末金額</dt><dd>${money(s.final)}</dd>
      </dl>
      <details class="more"><summary>更多指標</summary>
        <dl class="kv">
          <dt>年化波動</dt><dd>${pct(s.vol)}</dd>
          <dt>夏普</dt><dd>${num2(s.sharpe)}</dd>
          <dt>索提諾</dt><dd>${num2(s.sortino)}</dd>
          <dt>卡瑪</dt><dd>${num2(s.calmar)}</dd>
          <dt>最好年度</dt><dd class="${cls(s.bestYear)}">${pct(s.bestYear, 1, true)}</dd>
          <dt>最差年度</dt><dd class="${cls(s.worstYear)}">${pct(s.worstYear, 1, true)}</dd>
          <dt>回撤高點</dt><dd>${s.mddTop}</dd>
          <dt>回撤低點</dt><dd>${s.mddTrough}</dd>
          <dt>回到前高</dt><dd>${s.mddRecovery ?? '尚未'}</dd>
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
    </tbody></table></div>`;
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
  if (!R.some(r => r.code === state.chartAsset)) state.chartAsset = R[0].code;

  html += `<div class="cards">${R.map(r => {
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
        <dl class="kv"><dt>策略回撤</dt><dd>${s.mddTop} → ${s.mddTrough}</dd><dt>回到前高</dt><dd>${s.mddRecovery ?? '尚未'}</dd></dl>
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
  const evRows = r.events.map(e => `<tr><td class="num">${e.date}</td><td>${ACT_LABEL[e.act]}${e.act === 2 ? ` 第 ${e.layer} 層` : ''}</td><td class="n">${(e.value / base).toFixed(2)}×</td></tr>`).join('');
  html += `<section class="card"><details ${r.events.length <= 12 ? 'open' : ''}><summary><b>${SHORT[r.code]} 進出紀錄（${r.events.length} 次）</b></summary>
    ${r.events.length ? `<div class="tbl-wrap"><table class="ev"><thead><tr><th>日期</th><th style="text-align:left">動作</th><th>當時淨值</th></tr></thead><tbody>${evRows}</tbody></table></div>`
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
  const asBh = rows.map(r => ({ code: r.code, start: r.start, end: r.end, cagr: r.bhCagr, mdd: r.bhMdd, total: r.bhTotal }));
  const ds = { cagr: E.describe(rows, list, 'cagr'), mdd: E.describe(rows, list, 'mdd'), total: E.describe(rows, list, 'total') };
  const db = { cagr: E.describe(asBh, list, 'cagr'), mdd: E.describe(asBh, list, 'mdd'), total: E.describe(asBh, list, 'total') };
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
    </tbody></table></div></section>`;

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

// ---------- 蒙地卡羅 ----------
const BLOCK_LABEL = { 1: '每天打亂', 20: '約 1 個月', 60: '約 3 個月', 120: '約半年', 250: '約 1 年' };
function mcKey(compare) {
  return JSON.stringify([compare, codes(), state.useSyn, state.excess, state.signalPrice, state.trendCustom, state.capital,
    state.discount, state.mcN, state.mcYears, state.mcSeed, compare ? 0 : state.mcBlock]);
}
function renderMCIdle() {
  destroyCharts();
  $('status').textContent = '';
  if (mcLast && mcLast.key === mcKey(mcLast.compare)) { mcLast.compare ? renderMCCompare(mcLast) : renderMC(mcLast); return; }
  $('results').innerHTML = `<div class="card"><p class="hint" style="margin:0">設定好之後按「開始模擬」。${state.mcN} 條大約要 ${Math.max(1, Math.round(state.mcN * codes().length * state.mcYears / 12000))} 秒（手機會慢一點）。</p></div>`;
}

async function runMC(compare) {
  if (!codes().length) { $('results').innerHTML = '<div class="warn">請至少選一檔 0050、00631L 或 00675L。</div>'; return; }
  const token = ++mcToken;
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
  }
  mcLast = { key: mcKey(compare), compare, out, n, years: state.mcYears, block: state.mcBlock };
  $('status').textContent = `模擬 ${out.length * n} 條，${(Math.round(performance.now() - t0) / 1000).toFixed(1)} 秒`;
  compare ? renderMCCompare(mcLast) : renderMC(mcLast);
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
    </div></div>`; }).join('')}
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
    return `<td class="n pair"><b>${pct(s.win, 0)}</b><small>${(s.diff50 > 0 ? '+' : '') + (s.diff50 * 100).toFixed(1)} 點 · 回撤小 ${pct(s.mddBetter, 0)}</small></td>`; };
  $('results').innerHTML = `<section class="card"><h3>各種區塊長度比較（每組 ${n.toLocaleString()} 條 ${years} 年）</h3>
    <p class="hint">每格上面是「策略報酬贏的機率」，下面是年化多賺的中位數與「最大回撤比較小的機率」。</p>
    <div class="tbl-wrap"><table><thead><tr><th>每段平均長度</th>${list.map(c => `<th><span class="dot" style="background:${color(c)}"></span>${SHORT[c]}</th>`).join('')}</tr></thead>
    <tbody>${blocks.map(b => `<tr><td class="lbl">${BLOCK_LABEL[b]}${b === 1 ? '<br><small>沒有趨勢（對照）</small>' : ''}</td>${list.map(c => cell(b, c)).join('')}</tr>`).join('')}</tbody></table></div>
    <p class="hint" style="margin-top:10px">怎麼看：每天打亂時，行情裡沒有趨勢，策略的報酬優勢應該消失；區塊越長、保留越多趨勢，策略越容易贏。真實台股在 1～6 個月的尺度上有趨勢延續，「約 3 個月」到「約半年」那兩列最接近現實。回撤比較小這件事在每一列都成立，是這個策略最穩的好處。</p></section>`;
}

// ---------- 啟動 ----------
async function main() {
  restore();
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
