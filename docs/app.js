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
};
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
    if (s) Object.assign(state, s, { assets: new Set(s.assets?.length ? s.assets : ORDER) });
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

  document.querySelectorAll('.tabs button').forEach(b => b.addEventListener('click', () => {
    state.mode = b.dataset.mode; showMode(); changed();
  }));
  showMode();

  if (DATA.params?.gap_0050 !== undefined) $('gapText').textContent = pct(DATA.params.gap_0050, 2);
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
    cost: E.makeCost({ discount: state.discount }),
  };
}
const codes = () => ORDER.filter(c => state.assets.has(c));

function run() {
  $('excessRow').classList.toggle('disabled', !state.useSyn);
  const t0 = performance.now();
  try {
    if (state.mode === 'period') renderPeriod(E.period(DATA, codes(), state.start, state.end, opts()));
    else if (state.mode === 'rolling') {
      const rows = E.rolling(DATA, codes(), state.rollYears, opts());
      renderMulti(rows, `${state.rollYears} 年滾動區間（每個月初一個起點）`);
    } else {
      const lo = Math.min(state.rndMin, state.rndMax), hi = Math.max(state.rndMin, state.rndMax);
      const rows = E.randomWindows(DATA, codes(), state.rndN, lo, hi, state.seed, opts());
      renderMulti(rows, `隨機 ${state.rndN} 個區間，長度 ${lo}～${hi} 年（種子 ${state.seed}）`);
    }
    $('status').textContent = `計算 ${Math.round(performance.now() - t0)} 毫秒`;
  } catch (err) {
    $('results').innerHTML = `<div class="warn">${esc(err.message)}</div>`;
    $('status').textContent = '';
    console.error(err);
  }
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
  const vals = list.flatMap(c => [d[c].min, d[c].max]);
  let lo = Math.min(...vals, 0), hi = Math.max(...vals, 0);
  const pad = (hi - lo) * 0.04; lo -= pad; hi += pad;
  const x = v => ((v - lo) / (hi - lo)) * 100;
  const step = [0.01, 0.02, 0.05, 0.1, 0.2, 0.25, 0.5].find(s => (hi - lo) / s <= 7) ?? 1;
  const ticks = [];
  for (let t = Math.ceil(lo / step) * step; t <= hi + 1e-9; t += step) ticks.push(t);
  return `<div class="ranges">${list.map(c => {
    const s = d[c];
    return `<div class="range-row" style="--c:${color(c)}">
      <div class="rname"><span>${LABEL[c]}</span><span>中位數 ${pct(s.p50, 1, M.sign)}</span></div>
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
