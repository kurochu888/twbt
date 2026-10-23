// 輕量 SVG 圖表：折線圖（可對數刻度、模擬段虛線）與散布圖，支援滑鼠與觸控提示。
// 不依賴任何外部程式庫。

const NS = 'http://www.w3.org/2000/svg';
const el = (tag, attrs = {}, parent) => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (parent) parent.appendChild(e);
  return e;
};

function niceLinearTicks(lo, hi, target = 5) {
  const span = hi - lo || 1;
  const raw = span / target, mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => span / s <= target + 1);
  const ticks = [];
  for (let t = Math.ceil(lo / step) * step; t <= hi + step * 1e-9; t += step) ticks.push(+t.toFixed(10));
  return ticks;
}
function logTicks(lo, hi) {
  const out = [];
  for (let k = Math.floor(Math.log10(lo)); k <= Math.ceil(Math.log10(hi)); k++)
    for (const m of [1, 2, 5]) { const v = m * 10 ** k; if (v >= lo * 0.999 && v <= hi * 1.001) out.push(v); }
  // 刻度太多時只留 10 的次方
  return out.length > 8 ? out.filter(v => Math.abs(Math.log10(v) - Math.round(Math.log10(v))) < 1e-9) : out;
}
function yearTicks(x0, x1) {
  const DAY = 86400000, y0 = new Date(x0).getUTCFullYear(), y1 = new Date(x1).getUTCFullYear();
  const span = y1 - y0;
  const step = [1, 2, 5, 10].find(s => span / s <= 7) ?? 10;
  const out = [];
  for (let y = Math.ceil(y0 / step) * step; y <= y1; y += step) {
    const t = Date.UTC(y, 0, 1);
    if (t >= x0 && t <= x1) out.push(t);
  }
  if (!out.length) out.push(x0, x1);
  return { ticks: out, fmt: t => (span < 2 ? new Date(t).toISOString().slice(0, 7) : String(new Date(t + DAY).getUTCFullYear())) };
}

class Base {
  constructor(box, opts) {
    this.box = box; this.opts = opts;
    box.innerHTML = '';
    box.style.position = 'relative';
    this.svg = el('svg', { width: '100%', height: '100%', role: 'img' }, box);
    if (opts.ariaLabel) this.svg.setAttribute('aria-label', opts.ariaLabel);
    this.tip = document.createElement('div');
    this.tip.className = 'tip'; this.tip.hidden = true;
    box.appendChild(this.tip);
    this.ro = new ResizeObserver(() => this.render());
    this.ro.observe(box);
    const move = e => this.hover(e);
    this.svg.addEventListener('pointermove', move);
    this.svg.addEventListener('pointerdown', move);
    this.svg.addEventListener('pointerleave', () => this.clear());
  }
  destroy() { this.ro.disconnect(); this.box.innerHTML = ''; }
  frame() {
    const w = this.box.clientWidth, h = this.box.clientHeight;
    const m = { l: this.opts.left ?? 46, r: 10, t: 8, b: 24 };
    return { w, h, m, iw: Math.max(10, w - m.l - m.r), ih: Math.max(10, h - m.t - m.b) };
  }
  axes(g, f, yTicks, yPos, yFmt, xTicks, xPos, xFmt, zeroY) {
    const grid = el('g', { class: 'grid' }, g);
    for (const t of yTicks) {
      const y = yPos(t);
      el('line', { x1: f.m.l, x2: f.m.l + f.iw, y1: y, y2: y, class: 'gl' }, grid);
      const tx = el('text', { x: f.m.l - 6, y: y + 4, class: 'tick', 'text-anchor': 'end' }, grid);
      tx.textContent = yFmt(t);
    }
    if (zeroY !== undefined) el('line', { x1: f.m.l, x2: f.m.l + f.iw, y1: zeroY, y2: zeroY, class: 'zero' }, grid);
    for (const t of xTicks) {
      const x = xPos(t);
      const tx = el('text', { x, y: f.m.t + f.ih + 17, class: 'tick', 'text-anchor': 'middle' }, grid);
      tx.textContent = xFmt(t);
      el('line', { x1: x, x2: x, y1: f.m.t + f.ih, y2: f.m.t + f.ih + 4, class: 'gl' }, grid);
    }
  }
  showTip(html, px, py) {
    this.tip.innerHTML = html; this.tip.hidden = false;
    const bw = this.box.clientWidth, tw = this.tip.offsetWidth, th = this.tip.offsetHeight;
    let x = px + 12; if (x + tw > bw) x = px - tw - 12; if (x < 0) x = 0;
    let y = py - th - 10; if (y < 0) y = py + 14;
    this.tip.style.left = x + 'px'; this.tip.style.top = y + 'px';
  }
  clear() { this.tip.hidden = true; if (this.cursor) this.cursor.setAttribute('visibility', 'hidden'); }
}

// series: [{name, color, x: Float64Array(ms), y: Float64Array, dashUntil: ms}]
export class LineChart extends Base {
  render() {
    const o = this.opts, f = this.frame();
    this.svg.innerHTML = '';
    this.f = f;
    const S = o.series.filter(s => s.x.length);
    if (!S.length) return;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const s of S) {
      x0 = Math.min(x0, s.x[0]); x1 = Math.max(x1, s.x[s.x.length - 1]);
      for (const v of s.y) if (Number.isFinite(v) && (!o.log || v > 0)) { y0 = Math.min(y0, v); y1 = Math.max(y1, v); }
    }
    if (o.yMax !== undefined) y1 = Math.max(o.yMax, y0 + 1e-9);
    if (o.log) { y0 /= 1.08; y1 *= 1.08; } else { const p = (y1 - y0) * 0.05 || 1; y0 -= p; if (o.yMax === undefined) y1 += p; }
    const L = v => (o.log ? Math.log(v) : v);
    const X = t => f.m.l + ((t - x0) / (x1 - x0 || 1)) * f.iw;
    const Y = v => f.m.t + f.ih - ((L(v) - L(y0)) / (L(y1) - L(y0) || 1)) * f.ih;
    this.X = X; this.x0 = x0; this.x1 = x1; this.Y = Y;
    const yt = o.log ? logTicks(y0, y1) : niceLinearTicks(y0, y1);
    const xt = yearTicks(x0, x1);
    const g = el('g', {}, this.svg);
    this.axes(g, f, yt, Y, o.yFmt, xt.ticks, X, xt.fmt, !o.log && y0 < 0 && y1 > 0 ? Y(0) : undefined);
    // 每個像素最多畫一點，避免路徑太長
    for (const s of S) {
      const parts = [['', []], ['dash', []]];
      let lastPx = -1;
      for (let i = 0; i < s.x.length; i++) {
        const px = X(s.x[i]);
        if (i !== s.x.length - 1 && Math.abs(px - lastPx) < 0.6 && i !== 0) continue;
        lastPx = px;
        const v = s.y[i];
        if (!Number.isFinite(v) || (o.log && v <= 0)) continue;
        const pt = `${px.toFixed(1)},${Y(v).toFixed(1)}`;
        if (s.dashUntil !== undefined && s.x[i] <= s.dashUntil) parts[1][1].push(pt);
        else { if (!parts[0][1].length && parts[1][1].length) parts[0][1].push(parts[1][1][parts[1][1].length - 1]); parts[0][1].push(pt); }
      }
      for (const [k, pts] of parts) if (pts.length > 1)
        el('polyline', { points: pts.join(' '), fill: 'none', stroke: s.color, 'stroke-width': o.width ?? 1.7,
          'stroke-linejoin': 'round', 'stroke-dasharray': k ? '5 4' : 'none' }, g);
    }
    // 事件標記：{x, y, color, shape: 'down' | 'up' | 'dot'}
    if (o.markers?.length) {
      const gm = el('g', { class: 'markers' }, g);
      for (const mk of o.markers) {
        if (!Number.isFinite(mk.y) || (o.log && mk.y <= 0) || mk.x < x0 || mk.x > x1) continue;
        const cx = X(mk.x), cy = Y(mk.y), r = 4.5;
        const attrs = { fill: mk.color, stroke: 'var(--surface)', 'stroke-width': 1.2 };
        if (mk.shape === 'dot') el('circle', { cx, cy, r: 3.6, ...attrs }, gm);
        else {
          const d = mk.shape === 'down' ? 1 : -1, oy = cy - d * 7;   // 三角形畫在線的上方（出場）或下方（接刀）
          el('path', { d: `M${cx - r},${oy - d * r} L${cx + r},${oy - d * r} L${cx},${oy + d * r * 0.9} Z`, ...attrs }, gm);
        }
      }
    }
    this.cursor = el('g', { visibility: 'hidden' }, this.svg);
    el('line', { y1: f.m.t, y2: f.m.t + f.ih, class: 'cur' }, this.cursor);
    this.dots = S.map(s => el('circle', { r: 3.5, fill: s.color, stroke: 'var(--surface)', 'stroke-width': 1.5 }, this.cursor));
    this.S = S;
  }
  hover(e) {
    if (!this.S) return;
    const r = this.svg.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top;
    const f = this.f;
    if (px < f.m.l || px > f.m.l + f.iw) { this.clear(); return; }
    const t = this.x0 + ((px - f.m.l) / f.iw) * (this.x1 - this.x0);
    const rows = [];
    let cx = px;
    this.S.forEach((s, k) => {
      let lo = 0, hi = s.x.length - 1;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (s.x[mid] < t) lo = mid + 1; else hi = mid; }
      if (lo > 0 && Math.abs(s.x[lo - 1] - t) < Math.abs(s.x[lo] - t)) lo--;
      const v = s.y[lo];
      cx = this.X(s.x[lo]);
      if (Number.isFinite(v) && (!this.opts.log || v > 0)) {
        this.dots[k].setAttribute('cx', cx); this.dots[k].setAttribute('cy', this.Y(v)); this.dots[k].setAttribute('visibility', 'visible');
        rows.push(`<div><i style="background:${s.color}"></i>${s.name}<b>${this.opts.tipFmt(v)}</b></div>`);
      } else this.dots[k].setAttribute('visibility', 'hidden');
      if (k === 0) this.tipDate = s.x[lo];
    });
    const line = this.cursor.querySelector('line');
    line.setAttribute('x1', cx); line.setAttribute('x2', cx);
    this.cursor.setAttribute('visibility', 'visible');
    const iso = new Date(this.tipDate).toISOString().slice(0, 10);
    const note = this.opts.tipNote?.(iso);
    this.showTip(`<div class="tip-h">${iso}</div>${rows.join('')}${note ? `<div class="tip-h">${note}</div>` : ''}`, px, py);
  }
}

// series: [{name, color, pts: [{x, y, label}]}]
export class ScatterChart extends Base {
  render() {
    const o = this.opts, f = this.frame();
    this.svg.innerHTML = ''; this.f = f;
    const all = o.series.flatMap(s => s.pts);
    if (!all.length) return;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const p of all) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y); }
    y0 = Math.min(y0, 0); y1 = Math.max(y1, 0);
    if (o.square) { x0 = y0 = Math.min(x0, y0); x1 = y1 = Math.max(x1, y1); }   // 兩軸同刻度（畫對角線用）
    const pad = (y1 - y0) * 0.06 || 1; y0 -= pad; y1 += pad;
    if (o.square) { x0 = y0; x1 = y1; }
    const X = t => f.m.l + ((t - x0) / (x1 - x0 || 1)) * f.iw;
    const Y = v => f.m.t + f.ih - ((v - y0) / (y1 - y0)) * f.ih;
    const xt = o.xNumeric ? { ticks: niceLinearTicks(x0, x1), fmt: o.xFmt || (v => v) } : yearTicks(x0, x1);
    const g = el('g', {}, this.svg);
    this.axes(g, f, niceLinearTicks(y0, y1), Y, o.yFmt, xt.ticks, X, xt.fmt, Y(0));
    if (o.diagonal) {
      const a = Math.max(x0, y0), b = Math.min(x1, y1);
      el('line', { x1: X(a), y1: Y(a), x2: X(b), y2: Y(b), class: 'zero', 'stroke-dasharray': '4 3' }, g);
    }
    if (o.xLabel) { const t = el('text', { x: f.m.l + f.iw, y: f.m.t + f.ih - 6, class: 'tick', 'text-anchor': 'end' }, g); t.textContent = o.xLabel; }
    if (o.yLabel) { const t = el('text', { x: f.m.l + 6, y: f.m.t + 12, class: 'tick' }, g); t.textContent = o.yLabel; }
    const r = all.length > 1500 ? 1.7 : 2.3;
    this.P = [];
    for (const s of o.series) {
      const gs = el('g', { fill: s.color, 'fill-opacity': 0.8 }, g);
      for (const p of s.pts) {
        const cx = X(p.x), cy = Y(p.y);
        el('circle', { cx: cx.toFixed(1), cy: cy.toFixed(1), r }, gs);
        this.P.push({ cx, cy, p, s });
      }
    }
    this.cursor = el('circle', { r: 5, fill: 'none', 'stroke-width': 2, visibility: 'hidden' }, this.svg);
  }
  hover(e) {
    if (!this.P) return;
    const r = this.svg.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top;
    let best = null, bd = 18 ** 2;
    for (const q of this.P) { const d = (q.cx - px) ** 2 + (q.cy - py) ** 2; if (d < bd) { bd = d; best = q; } }
    if (!best) { this.clear(); return; }
    this.cursor.setAttribute('cx', best.cx); this.cursor.setAttribute('cy', best.cy);
    this.cursor.setAttribute('stroke', best.s.color); this.cursor.setAttribute('visibility', 'visible');
    this.showTip(`<div><i style="background:${best.s.color}"></i>${best.s.name}<b>${this.opts.tipFmt(best.p.y)}</b></div><div class="tip-h">${best.p.label}</div>`, best.cx, best.cy);
  }
}
