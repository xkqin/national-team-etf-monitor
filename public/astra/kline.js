'use strict';
// Astra K-line: daily candles (unadjusted, same basis as the fill prices) from Eastmoney, drawn as SVG with MA5/MA20,
// volume, the position's cost / stop / support lines, its entry day and every saved order.
// Requested only after the snapshot is unlocked; only the stock code leaves the browser.
window.AstraKline = (() => {
  const cache = new Map();
  const TTL = 60_000;
  const UP = '#e3342f', DOWN = '#0e9b6a';

  // "600519", "SH600519", "sh600519", "600519.SH", "600519.SS" → Eastmoney secid
  function secid(code) {
    const text = String(code || '').trim().toUpperCase();
    if (/^[01]\.\d{6}$/.test(text)) return text; // already an Eastmoney secid, e.g. 1.000300 (CSI 300)
    const digits = (text.match(/\d{6}/) || [])[0];
    if (!digits) return null;
    let market = /SH|SS/.test(text) ? '1' : /SZ|BJ/.test(text) ? '0' : null;
    if (!market) market = /^[569]/.test(digits) ? '1' : '0';
    return `${market}.${digits}`;
  }

  async function load(code, count = 160) {
    const id = secid(code);
    if (!id) throw new Error('无法识别的证券代码');
    const key = `${id}|${count}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < TTL) return hit.bars;
    const url = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${id}&klt=101&fqt=0&end=20500101&lmt=${count + 20}&fields1=f1,f2,f3&fields2=f51,f52,f53,f54,f55,f56,f57&_=${Date.now()}`;
    const response = await fetch(url, { cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(12_000) });
    if (!response.ok) throw new Error(`行情接口 HTTP ${response.status}`);
    const payload = await response.json();
    const lines = payload?.data?.klines;
    if (!Array.isArray(lines) || !lines.length) throw new Error('行情接口没有返回 K 线');
    const bars = lines
      .map((line) => {
        const [date, open, close, high, low, volume, amount] = line.split(',');
        return { date, open: +open, close: +close, high: +high, low: +low, volume: +volume, amount: +amount };
      })
      .filter((bar) => bar.open > 0 && bar.high > 0 && bar.low > 0 && bar.close > 0);
    cache.set(key, { at: Date.now(), bars, name: payload.data.name });
    return bars;
  }

  const ma = (bars, n) => bars.map((_, i) => (i + 1 < n ? null : bars.slice(i + 1 - n, i + 1).reduce((s, b) => s + b.close, 0) / n));
  const fmt = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '—');
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // opts: { show: 60|120, cost, stop, support, entryDate, orders: [{day, side, price, quantity, filled, state}] }
  function render(container, allBars, opts = {}) {
    const show = Math.min(opts.show || 120, allBars.length);
    const ma5All = ma(allBars, 5);
    const ma20All = ma(allBars, 20);
    const offset = allBars.length - show;
    const bars = allBars.slice(offset);
    const ma5 = ma5All.slice(offset);
    const ma20 = ma20All.slice(offset);
    const width = Math.max(320, Math.round(container.clientWidth || 720));
    const compact = width < 560;
    const m = { l: 8, r: compact ? 46 : 58, t: 14 };
    const hP = compact ? 200 : 260;
    const gap = 18;
    const hV = compact ? 52 : 70;
    const yV0 = m.t + hP + gap;
    const height = yV0 + hV + 24;
    const iw = width - m.l - m.r;
    const step = iw / bars.length;
    const cw = Math.max(1, Math.min(10, step * 0.66));
    const x = (i) => m.l + step * (i + 0.5);
    const levels = [opts.cost, opts.stop, opts.support].filter((v) => Number.isFinite(v) && v > 0);
    const visibleOrders = (opts.orders || []).filter((o) => o.day >= bars[0].date && Number.isFinite(o.price));
    let lo = Math.min(...bars.map((b) => b.low));
    let hi = Math.max(...bars.map((b) => b.high));
    // Include reference lines only when they are near the visible range, so a far stop does not flatten the candles.
    for (const v of [...levels, ...visibleOrders.map((o) => o.price)]) {
      if (v >= lo * 0.85 && v <= hi * 1.15) {
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
      }
    }
    const pad = (hi - lo) * 0.08 || hi * 0.02;
    lo -= pad;
    hi += pad;
    const y = (v) => m.t + ((hi - v) / (hi - lo)) * hP;
    const vMax = Math.max(...bars.map((b) => b.volume)) || 1;
    const yv = (v) => yV0 + hV - (v / vMax) * hV;
    const f = (n) => n.toFixed(1);

    let svg = `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="日 K 线">`;
    for (let k = 0; k <= 4; k++) {
      const v = hi - ((hi - lo) * k) / 4;
      svg += `<line class="k-grid" x1="${m.l}" x2="${width - m.r}" y1="${f(y(v))}" y2="${f(y(v))}"/><text class="k-axis" x="${width - m.r + 6}" y="${f(y(v) + 3.5)}">${fmt(v)}</text>`;
    }
    svg += `<line class="k-grid" x1="${m.l}" x2="${width - m.r}" y1="${yV0 + hV}" y2="${yV0 + hV}"/>`;
    // month labels
    let lastMonth = '';
    bars.forEach((b, i) => {
      const month = b.date.slice(0, 7);
      if (month !== lastMonth && i > 2) svg += `<text class="k-axis" x="${f(x(i))}" y="${height - 6}" text-anchor="middle">${b.date.slice(5, 7)}月</text>`;
      lastMonth = month;
    });
    // volume
    bars.forEach((b, i) => {
      const up = b.close >= b.open;
      svg += `<rect x="${f(x(i) - cw / 2)}" y="${f(yv(b.volume))}" width="${f(cw)}" height="${f(yV0 + hV - yv(b.volume))}" fill="${up ? UP : DOWN}" opacity=".35"/>`;
    });
    // entry day band
    if (opts.entryDate) {
      const i = bars.findIndex((b) => b.date >= opts.entryDate);
      if (i >= 0) svg += `<rect x="${f(x(i) - step / 2)}" y="${m.t}" width="${f(width - m.r - (x(i) - step / 2))}" height="${hP}" fill="rgba(10,102,214,.045)"/><text class="k-tag" x="${f(x(i) - step / 2 + 4)}" y="${m.t + 12}" fill="#0a66d6">建仓 ${esc(opts.entryDate.slice(5))}</text>`;
    }
    // candles
    bars.forEach((b, i) => {
      const up = b.close >= b.open;
      const color = up ? UP : DOWN;
      const top = y(Math.max(b.open, b.close));
      const bottom = y(Math.min(b.open, b.close));
      svg += `<line x1="${f(x(i))}" x2="${f(x(i))}" y1="${f(y(b.high))}" y2="${f(y(b.low))}" stroke="${color}" stroke-width="1"/>`;
      svg += `<rect x="${f(x(i) - cw / 2)}" y="${f(top)}" width="${f(cw)}" height="${f(Math.max(1, bottom - top))}" fill="${up ? '#fff' : color}" stroke="${color}" stroke-width="1"/>`;
    });
    const path = (values, color) => {
      const d = values.map((v, i) => (v === null ? '' : `${values[i - 1] == null ? 'M' : 'L'}${f(x(i))} ${f(y(v))}`)).join('');
      return d ? `<path d="${d}" fill="none" stroke="${color}" stroke-width="1.3"/>` : '';
    };
    svg += path(ma5, '#f59e0b') + path(ma20, '#6d4aff');
    // reference lines; their right-axis tags (and the last-price tag) are spread so none overlap
    const last = bars.at(-1);
    const lastColor = last.close >= (bars.at(-2)?.close ?? last.open) ? UP : DOWN;
    const tags = [];
    const line = (v, label, color, dash) => {
      if (!(Number.isFinite(v) && v > lo && v < hi)) return '';
      tags.push({ y: y(v), label, color });
      return `<line x1="${m.l}" x2="${width - m.r}" y1="${f(y(v))}" y2="${f(y(v))}" stroke="${color}" stroke-width="1.2" stroke-dasharray="${dash}"/>`;
    };
    svg += line(opts.stop, '止损', DOWN, '4 4') + line(opts.support, '支撑', '#7b8a9d', '2 3') + line(opts.cost, '成本', '#0a66d6', '6 3');
    svg += `<line x1="${m.l}" x2="${width - m.r}" y1="${f(y(last.close))}" y2="${f(y(last.close))}" stroke="${lastColor}" stroke-width=".8" opacity=".6"/>`;
    tags.push({ y: y(last.close), label: fmt(last.close), color: lastColor, last: true });
    tags.sort((a, b) => a.y - b.y);
    for (let k = 1; k < tags.length; k++) tags[k].y = Math.max(tags[k].y, tags[k - 1].y + 17);
    const overflow = tags.length ? tags.at(-1).y - (m.t + hP - 8) : 0;
    if (overflow > 0) for (const tag of tags) tag.y -= overflow;
    const tagSvg = tags.map((t) => `<rect x="${width - m.r + 1}" y="${f(t.y - 8)}" width="${m.r - 2}" height="16" rx="4" fill="${t.color}"/><text class="k-tag" x="${width - m.r + m.r / 2}" y="${f(t.y + 4)}" text-anchor="middle" fill="#fff">${t.label}</text>`).join('');
    // orders: ▲ buy below the low, ▼ sell above the high
    const index = new Map(bars.map((b, i) => [b.date, i]));
    const stacked = new Map();
    visibleOrders.forEach((o) => {
      const i = index.get(o.day);
      if (i === undefined) return;
      const n = (stacked.get(`${o.day}${o.side}`) || 0) + 1;
      stacked.set(`${o.day}${o.side}`, n);
      const buy = o.side === 'BUY';
      const filled = o.filled > 0;
      const yy = buy ? y(bars[i].low) + 10 + (n - 1) * 11 : y(bars[i].high) - 10 - (n - 1) * 11;
      const color = buy ? UP : DOWN;
      const tri = buy ? `M${f(x(i))} ${f(yy - 5)}L${f(x(i) - 5)} ${f(yy + 4)}L${f(x(i) + 5)} ${f(yy + 4)}Z` : `M${f(x(i))} ${f(yy + 5)}L${f(x(i) - 5)} ${f(yy - 4)}L${f(x(i) + 5)} ${f(yy - 4)}Z`;
      svg += `<path d="${tri}" fill="${filled ? color : '#fff'}" stroke="${color}" stroke-width="1.4"/>`;
    });
    svg += tagSvg;
    svg += `<line class="k-cursor" x1="0" x2="0" y1="${m.t}" y2="${yV0 + hV}" visibility="hidden"/><rect class="k-hit" x="${m.l}" y="${m.t}" width="${iw}" height="${yV0 + hV - m.t}" fill="transparent"/></svg>`;
    container.innerHTML = `<div class="k-legend"><span><i style="background:#f59e0b"></i>MA5 <b data-k="ma5">${fmt(ma5.at(-1))}</b></span><span><i style="background:#6d4aff"></i>MA20 <b data-k="ma20">${fmt(ma20.at(-1))}</b></span>${Number.isFinite(opts.cost) ? `<span><i class="dash" style="border-color:#0a66d6"></i>成本 ${fmt(opts.cost)}</span>` : ''}${Number.isFinite(opts.stop) ? `<span><i class="dash" style="border-color:${DOWN}"></i>止损 ${fmt(opts.stop)}</span>` : ''}<span><b class="tri up">▲</b>买 <b class="tri down">▼</b>卖 · 实心=有成交</span></div>${svg}<div class="k-tip" hidden></div>`;

    const svgEl = container.querySelector('svg');
    const tip = container.querySelector('.k-tip');
    const cursor = svgEl.querySelector('.k-cursor');
    const move = (event) => {
      const rect = svgEl.getBoundingClientRect();
      const px = ((event.clientX - rect.left) / rect.width) * width;
      const i = Math.max(0, Math.min(bars.length - 1, Math.floor((px - m.l) / step)));
      const b = bars[i];
      const prev = i ? bars[i - 1].close : allBars[offset - 1]?.close;
      const change = prev ? (b.close / prev - 1) * 100 : null;
      cursor.setAttribute('x1', x(i));
      cursor.setAttribute('x2', x(i));
      cursor.setAttribute('visibility', 'visible');
      const dayOrders = visibleOrders.filter((o) => o.day === b.date);
      tip.innerHTML = `<b>${esc(b.date)}</b><div class="row"><span>开 / 收</span><span>${fmt(b.open)} / ${fmt(b.close)}</span></div><div class="row"><span>高 / 低</span><span>${fmt(b.high)} / ${fmt(b.low)}</span></div><div class="row"><span>涨跌</span><span class="${change > 0 ? 'positive' : change < 0 ? 'negative' : ''}">${change === null ? '—' : (change > 0 ? '+' : '') + change.toFixed(2) + '%'}</span></div><div class="row"><span>成交额</span><span>${(b.amount / 1e8).toFixed(2)} 亿</span></div>${dayOrders.map((o) => `<div class="row"><span>${o.side === 'BUY' ? '买入' : '卖出'} ${esc(o.quantity)} 股</span><span>${fmt(o.price)}${o.filled > 0 ? ' · 成交 ' + esc(o.filled) : ' · 未成交'}</span></div>`).join('')}`;
      tip.hidden = false;
      const left = ((x(i) / width) * rect.width) + (x(i) / width > 0.6 ? -tip.offsetWidth - 12 : 12);
      tip.style.left = `${Math.max(0, left)}px`;
      tip.style.top = `${Math.max(0, ((event.clientY - rect.top) - tip.offsetHeight / 2))}px`;
    };
    const hit = svgEl.querySelector('.k-hit');
    hit.addEventListener('pointermove', move);
    hit.addEventListener('pointerdown', move);
    hit.addEventListener('pointerleave', () => {
      tip.hidden = true;
      cursor.setAttribute('visibility', 'hidden');
    });
    return { last, change: bars.at(-2) ? (last.close / bars.at(-2).close - 1) * 100 : null };
  }

  // Live prices for many codes in one request: Map(secid → {price, prev, change, time}).
  async function quotes(codes) {
    const ids = [...new Set(codes.map(secid).filter(Boolean))];
    if (!ids.length) return new Map();
    const url = `https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&invt=2&secids=${ids.join(',')}&fields=f2,f3,f12,f13,f18,f124&_=${Date.now()}`;
    const response = await fetch(url, { cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`实时行情 HTTP ${response.status}`);
    const payload = await response.json();
    const out = new Map();
    for (const row of payload?.data?.diff || []) {
      const price = Number(row.f2);
      const prev = Number(row.f18);
      if (!(price > 0)) continue; // suspended or no trade yet
      out.set(`${row.f13}.${row.f12}`, { price, prev: prev > 0 ? prev : null, change: Number(row.f3), time: Number(row.f124) * 1000 });
    }
    return out;
  }

  return { load, render, secid, quotes };
})();
