import fs from 'fs';
import * as E from './engine.mjs';
const data = E.prepare(JSON.parse(fs.readFileSync(process.argv[3])));
const ref = JSON.parse(fs.readFileSync(process.argv[2]));
const NAMES = { TAIEX: '大盤（含息）', '0050': '0050', '00631L': '00631L 台灣50正2', '00675L': '00675L 加權正2' };
let n = 0, bad = [];
const close = (a, b) => { n++; return Math.abs(a - b) / Math.max(1, Math.abs(b)) < 1e-6; };
const q50 = a => E.quantile([...a].sort((x, y) => x - y), 0.5);
for (const x of ref) {
  const c = x.case;
  if (x.error) { bad.push(['python 例外', x.error]); continue; }
  const opts = { useSynthetic: c.syn, tw50Excess: c.excess, cost: E.makeCost({ discount: c.disc }), capital: c.capital, signalPrice: c.sp };
  const custom = { 1: c.custom['1'], 2: c.custom['2'] };
  try {
    if (c.type === 'bh') {
      const r = E.period(data, ['TAIEX', '0050', '00631L', '00675L'], c.start, c.end, opts);
      for (const code of ['TAIEX', '0050', '00631L', '00675L']) {
        const py = x.period[code], js = r.results?.find(y => y.code === code);
        if (!py !== !js) { bad.push(['bh 有無不同', code, c, py, !!js]); continue; }
        if (!py) continue;
        if (js.stats.start !== py[0] || !close(js.stats.final, py[1]) || !close(js.stats.mdd, py[2])) bad.push(['bh', code, c.start, c.end, js.stats.start, py[0], js.stats.final, py[1]]);
      }
      if (c.roll) { const rows = E.rolling(data, ['TAIEX', '0050', '00631L', '00675L'], c.roll, opts);
        for (const [code, nm] of Object.entries(NAMES)) { const g = rows.filter(r => r.code === code), py = x.roll[nm];
          if ((g.length || 0) !== (py ? py[0] : 0) || (py && !close(q50(g.map(r => r.cagr)), py[1]))) bad.push(['bh roll', code, g.length, py]); } }
    } else if (c.type === 'trend') {
      const r = E.trendPeriod(data, ['0050', '00631L', '00675L'], c.start, c.end, opts, custom);
      for (const code of ['0050', '00631L', '00675L']) {
        const py = x.period[code], js = r.results?.find(y => y.code === code);
        if (!py !== !js) { bad.push(['trend 有無不同', code, c.start, c.end, c.custom, py, js ? js.stats.start : r.error]); continue; }
        if (!py) continue;
        if (js.stats.start !== py[0] || !close(js.stats.final, py[1]) || !close(js.stats.mdd, py[2]) || js.events.length !== py[3]) bad.push(['trend', code, c.start, c.end, js.stats.start, py[0], js.stats.final, py[1], js.events.length, py[3]]);
      }
      if (c.roll) { const rows = E.trendWindows(data, ['0050', '00631L', '00675L'], E.rollingWins(data, c.roll), opts, custom);
        for (const code of ['0050', '00631L', '00675L']) { const g = rows.filter(r => r.code === code), py = x.roll[NAMES[code]];
          if ((g.length || 0) !== (py ? py[0] : 0) || (py && !close(q50(g.map(r => r.cagr)), py[1]))) bad.push(['trend roll', code, c.roll, g.length, py]); } }
    } else {
      const cfg = { weights: c.weights, freq: c.freq, band: c.band, cashRate: c.cash, trend: c.rtrend };
      const r = E.rebalPeriod(data, cfg, c.start, c.end, opts, custom);
      const py = x.period;
      if (!py !== !!r.error) bad.push(['rebal 有無不同', c.start, c.end, py, r.error]);
      else if (py) {
        const js = [E.dayToIso(r.dayIdx[0]), r.main.eq[r.main.eq.length - 1], r.stats.mdd, r.main.trades, r.flat.eq[r.flat.eq.length - 1]];
        if (js[0] !== py[0] || !close(js[1], py[1]) || !close(js[2], py[2]) || js[3] !== py[3] || !close(js[4], py[4])) bad.push(['rebal', JSON.stringify(cfg), c.start, js, py]);
      }
      if (c.roll) { const rows = E.rebalWindows(data, cfg, E.rollingWins(data, c.roll), opts, custom);
        if (rows.length !== x.roll[0] || (rows.length && !close(q50(rows.map(r => r.cagr)), x.roll[1]))) bad.push(['rebal roll', rows.length, x.roll]); }
    }
  } catch (e) { bad.push(['js 例外', c.type, e.message, c]); }
}
console.log(`隨機 ${ref.length} 組、比對 ${n} 個數字，不一致 ${bad.length} 個`);
for (const b of bad.slice(0, 12)) console.log(' ', JSON.stringify(b).slice(0, 400));
