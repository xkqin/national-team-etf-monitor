import {
  REFRESH_MS,
  BAR_TIMES,
  chinaNow,
  parseQuotes,
  aggregate,
  marketState,
  signalFor,
  volumeComparison,
  completeDays,
  minuteToFiveMinute,
} from "./core.js";

const $ = (id) => document.getElementById(id);
const money = (value) =>
  Number.isFinite(value) ? (value / 1e8).toFixed(2) : "—";
const decimal = (value, places = 2) =>
  Number.isFinite(value) ? value.toFixed(places) : "—";
const signed = (value, formatter = decimal) =>
  Number.isFinite(value) ? `${value > 0 ? "+" : ""}${formatter(value)}` : "—";
const tone = (value) => (value > 0 ? "positive" : value < 0 ? "negative" : "");
const escape = (text) =>
  String(text).replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ],
  );
const state = {
  pool: [],
  quotes: {},
  history: {},
  summary: null,
  paused: false,
  loading: false,
  historyLoading: false,
  lastAttempt: 0,
  lastHistoryAttempt: 0,
  source: "snapshot",
  quoteError: "",
  historyErrors: 0,
  snapshotError: false,
  range: 63,
  group: "全部",
  search: "",
  sort: "amount",
  direction: -1,
  snapshotAt: "",
};

async function fetchText(url, timeout = 12_000) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(timeout),
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const bytes = await response.arrayBuffer();
  const utf8 = new TextDecoder("utf-8").decode(bytes);
  return utf8.includes("\uFFFD")
    ? new TextDecoder("gb18030").decode(bytes)
    : utf8;
}

async function refreshQuotes() {
  if (state.loading || !state.pool.length) return;
  state.loading = true;
  state.lastAttempt = Date.now();
  $("refresh").classList.add("loading");
  try {
    const text = await fetchText(
      `https://qt.gtimg.cn/q=${state.pool.map((fund) => fund.symbol).join(",")}&_=${Date.now()}`,
    );
    const quotes = parseQuotes(text);
    const summary = aggregate(state.pool, quotes, state.history);
    if (!summary.rows.length) throw new Error("行情格式异常");
    state.quotes = quotes;
    state.source = "live";
    state.quoteError = "";
  } catch (error) {
    state.quoteError =
      error.name === "TimeoutError" ? "实时接口请求超时" : "实时接口连接失败";
  } finally {
    state.loading = false;
    $("refresh").classList.remove("loading");
    render();
  }
}

async function syncSnapshot() {
  const snapshot = JSON.parse(
    await fetchText(`./data/snapshot.json?_=${Date.now()}`),
  );
  if (!snapshot.generatedAt || !snapshot.history)
    throw new Error("云端历史格式异常");
  if (snapshot.generatedAt !== state.snapshotAt) {
    state.history = snapshot.history;
    state.snapshotAt = snapshot.generatedAt;
    if (state.source !== "live") state.quotes = snapshot.quotes || {};
  }
  state.snapshotError = false;
}

async function fetchMinute(fund) {
  const url = `https://web.ifzq.gtimg.cn/appstock/app/minute/query?code=${fund.symbol}&_=${Date.now()}`;
  const payload = JSON.parse(await fetchText(url, 15_000));
  const minute = payload.data?.[fund.symbol]?.data;
  if (!minute?.date || !Array.isArray(minute.data))
    throw new Error("分时数据为空");
  return {
    date: `${minute.date.slice(0, 4)}-${minute.date.slice(4, 6)}-${minute.date.slice(6, 8)}`,
    bars: minuteToFiveMinute(minute.date, minute.data),
  };
}

async function refreshHistory(force = false) {
  if (state.historyLoading || !state.pool.length) return;
  if (!force && Date.now() - state.lastHistoryAttempt < 60_000) return;
  state.historyLoading = true;
  state.lastHistoryAttempt = Date.now();
  try {
    await syncSnapshot();
  } catch {
    state.snapshotError = true;
  }
  const summary = aggregate(state.pool, state.quotes, state.history);
  if (
    summary.comparisonLagMinutes === null ||
    summary.comparisonLagMinutes <= 10
  ) {
    state.historyErrors = 0;
    state.historyLoading = false;
    render();
    return;
  }
  let failures = 0;
  // Bound simultaneous public-interface requests.
  for (let start = 0; start < state.pool.length; start += 4) {
    const batch = state.pool.slice(start, start + 4);
    const results = await Promise.allSettled(batch.map(fetchMinute));
    results.forEach((result, index) => {
      const fund = batch[index];
      if (result.status === "fulfilled") {
        const { date, bars } = result.value;
        state.history[fund.symbol] ??= {};
        if (bars.length) {
          const previous = (state.history[fund.symbol].fiveMinute || []).filter(
            ([time]) => time.slice(0, 10) !== date,
          );
          state.history[fund.symbol].fiveMinute = [...previous, ...bars];
        }
      } else {
        failures++;
      }
    });
  }
  state.historyErrors = failures;
  state.historyLoading = false;
  render();
}

function renderMetric(id, value, unit, className = "") {
  $(id).className = `metric-value ${className}`;
  $(id).innerHTML = `${value}<small>${unit}</small>`;
}

function render() {
  const summary = aggregate(state.pool, state.quotes, state.history);
  state.summary = summary;
  const market = marketState(summary.time);
  const signal = signalFor(summary, market);
  $("conclusion-headline").textContent = signal.headline;
  $("conclusion-summary").textContent = signal.evidence || signal.detail;
  const period =
    summary.date === chinaNow().slice(0, 10)
      ? "今日结论"
      : `${summary.date} 结论`;
  $("conclusion-context").textContent = summary.date
    ? `${period} · 量价推断`
    : "等待有效数据";
  $("market-badge").textContent = market.label;
  $("market-badge").className =
    `status-badge ${market.session && market.fresh ? "live" : market.session ? "delayed" : ""}`;
  $("signal-title").textContent = signal.title;
  $("signal-badge").textContent = signal.label;
  $("signal-badge").className = `pill ${signal.level}`;
  $("session-note").textContent = market.session
    ? "盘中观察"
    : `${summary.date || ""} · 最近行情`;
  $("signal-detail").textContent = signal.detail;
  $("coverage").textContent =
    `${summary.rows.length} / ${state.pool.length} 只 ETF 已取得行情`;
  $("baseline-note").textContent =
    summary.ratio !== null
      ? `量能截至 ${summary.cutoff} · 最少 ${summary.days} 日样本`
      : "同刻基线待就绪";
  $("ring-value").textContent =
    summary.ratio === null ? "—" : `${decimal(summary.ratio)}×`;
  $("activity-ring").style.setProperty(
    "--ring-angle",
    `${(Math.min(summary.ratio || 0, 3) / 3) * 300}deg`,
  );
  renderMetric(
    "total-amount",
    summary.rows.length ? money(summary.amount) : "—",
    "亿元",
  );
  renderMetric("volume-ratio", decimal(summary.ratio), "×");
  renderMetric(
    "net-flow",
    signed(summary.flow, money),
    "亿元",
    tone(summary.flow),
  );
  renderMetric(
    "weighted-change",
    signed(summary.change),
    "%",
    tone(summary.change),
  );
  $("amount-note").textContent =
    `${summary.complete ? "全池" : "可用子集"}累计 · ${summary.time ? formatTime(summary.time) : "等待数据"}`;
  $("ratio-note").textContent =
    summary.ratio === null
      ? "等待完整五分钟区间"
      : `截至 ${summary.cutoff} · 基线 ${money(summary.baseline)} 亿`;
  $("update-time").textContent = summary.time
    ? `行情 ${summary.date} ${formatTime(summary.time)}`
    : "尚未取得有效行情";
  $("source-state").textContent =
    `${state.source === "live" ? "行情直连 · 腾讯财经" : "云端快照 · 腾讯财经"} / 历史 · 云端快照 / 分时 · 腾讯${state.historyErrors ? `（${state.historyErrors} 只分时更新失败）` : ""}`;
  $("snapshot-time").textContent = state.snapshotAt
    ? `云端快照 ${chinaNow(new Date(state.snapshotAt))}（北京时间）`
    : "云端快照尚未加载";
  const alerts = [];
  if (state.quoteError)
    alerts.push(
      `${state.quoteError}，保留最近可用行情。可点击右上角刷新重试。`,
    );
  if (market.session && !market.fresh)
    alerts.push("行情时间已落后，当前展示历史数据，综合信号暂停。");
  if (!summary.complete)
    alerts.push(
      `行情覆盖 ${summary.rows.length}/${state.pool.length} 只，成交额为可用子集合计。`,
    );
  if (state.historyErrors)
    alerts.push(
      `${state.historyErrors} 只 ETF 的当日分时更新失败，量能沿用最近可用区间。`,
    );
  if (state.snapshotError)
    alerts.push("云端历史同步暂不可用，保留已有历史基线，将自动重试。");
  $("connection-alert").hidden = !alerts.length;
  $("connection-alert").textContent = alerts.join(" ");
  renderGroups(summary);
  renderTable();
  renderCharts();
}

function formatTime(time) {
  return `${time.slice(8, 10)}:${time.slice(10, 12)}:${time.slice(12, 14)}`;
}

function renderGroups(summary) {
  const groups = [...new Set(state.pool.map((fund) => fund.group))];
  $("group-cards").innerHTML = groups
    .map((group) => {
      const rows = summary.rows.filter((row) => row.group === group);
      const amount = rows.reduce((sum, row) => sum + row.amount, 0);
      const change = amount
        ? rows.reduce((sum, row) => sum + row.change * row.amount, 0) / amount
        : null;
      const points = dailySeries(rows.map((row) => row.symbol))
        .slice(-10)
        .map((row) => row.amount);
      return `<button class="group-card ${state.group === group ? "selected" : ""}" data-group="${escape(group)}" aria-pressed="${state.group === group}"><div class="group-top"><strong>${escape(group)}</strong><span>${rows.length} 只</span></div><p class="group-amount">${rows.length ? money(amount) : "—"}<small>亿</small></p><div class="group-bottom"><span class="${tone(change)}">${signed(change)}%</span>${sparkline(points, change)}</div></button>`;
    })
    .join("");
  $("filters").innerHTML = ["全部", ...groups]
    .map(
      (group) =>
        `<button data-group="${escape(group)}" class="${state.group === group ? "active" : ""}" aria-pressed="${state.group === group}">${escape(group)}</button>`,
    )
    .join("");
}

function sparkline(values, change) {
  if (values.length < 2) return "";
  const min = Math.min(...values);
  const span = Math.max(...values) - min || 1;
  const points = values
    .map(
      (value, index) =>
        `${(index / (values.length - 1)) * 40},${15 - ((value - min) / span) * 13}`,
    )
    .join(" ");
  return `<svg viewBox="0 0 40 16" aria-hidden="true"><polyline points="${points}" fill="none" stroke="${change >= 0 ? "#e9a48b" : "#83b9aa"}" stroke-width="1.4"/></svg>`;
}

function renderTable() {
  const summary = state.summary;
  if (!summary) return;
  const query = state.search.trim().toLowerCase();
  const rows = state.pool
    .filter(
      (fund) =>
        (state.group === "全部" || fund.group === state.group) &&
        `${fund.name}${fund.code}${fund.group}`.toLowerCase().includes(query),
    )
    .map((fund) => {
      const quote = summary.rows.find((row) => row.symbol === fund.symbol);
      const comparison = quote
        ? volumeComparison(
            quote,
            state.history[fund.symbol],
            summary.cutoff || undefined,
          )
        : null;
      return { ...fund, ...(quote || {}), ratio: comparison?.ratio ?? null };
    })
    .sort((left, right) => {
      const a = left[state.sort];
      const b = right[state.sort];
      if (a === null || a === undefined)
        return b === null || b === undefined ? 0 : 1;
      if (b === null || b === undefined) return -1;
      return (a - b) * state.direction;
    });
  $("fund-rows").innerHTML = rows.length
    ? rows
        .map(
          (row) =>
            `<tr><td><a href="https://gu.qq.com/${row.symbol}" target="_blank" rel="noopener noreferrer">${escape(row.name)} <span class="muted">↗</span></a><small>${row.code} · ${row.symbol.startsWith("sh") ? "SH" : "SZ"}</small></td><td><span class="index-tag">${escape(row.group)}</span></td><td>${decimal(row.price, 3)}</td><td class="${tone(row.change)}">${signed(row.change)}${Number.isFinite(row.change) ? "%" : ""}</td><td>${money(row.amount)}${Number.isFinite(row.amount) ? " 亿" : ""}</td><td><span class="ratio-pill ${row.ratio >= 1.3 ? "hot" : ""}">${decimal(row.ratio)}${Number.isFinite(row.ratio) ? "×" : ""}</span></td><td class="${tone(row.flow)}">${signed(row.flow, money)}${Number.isFinite(row.flow) ? " 亿" : ""}</td><td class="time-cell">${row.time ? formatTime(row.time) : "数据缺失"}</td></tr>`,
        )
        .join("")
    : '<tr><td colspan="8" class="empty-state">没有找到匹配的 ETF，试试其他名称或代码。</td></tr>';
  $("row-count").textContent = `显示 ${rows.length} / ${state.pool.length} 只`;
  const labels = {
    price: "最新价",
    change: "涨跌幅",
    amount: "成交额",
    ratio: "同刻倍数",
    flow: "外内盘差估算",
  };
  $("table-summary").textContent =
    `${state.pool.length} 只核心宽基 ETF · 按${labels[state.sort]}${state.direction === -1 ? "降序" : "升序"}`;
  document.querySelectorAll("[data-sort]").forEach((button) => {
    const selected = button.dataset.sort === state.sort;
    button.querySelector("span").textContent = selected
      ? state.direction === -1
        ? "↓"
        : "↑"
      : "↕";
    button
      .closest("th")
      .setAttribute(
        "aria-sort",
        selected
          ? state.direction === -1
            ? "descending"
            : "ascending"
          : "none",
      );
  });
}

function dailySeries(symbols = state.pool.map((fund) => fund.symbol)) {
  if (!symbols.length) return [];
  const dates = new Map();
  symbols.forEach((symbol) => {
    const records = new Map(
      (state.history[symbol]?.daily || []).map((row) => [row[0], row[1]]),
    );
    const quote = state.summary?.rows.find((row) => row.symbol === symbol);
    if (quote) records.set(quote.date, quote.amount);
    records.forEach((amount, date) => {
      if (!dates.has(date)) dates.set(date, { amount: 0, count: 0 });
      const item = dates.get(date);
      item.amount += amount;
      item.count++;
    });
  });
  return [...dates]
    .filter(([, item]) => item.count === symbols.length)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, item]) => ({ date, amount: item.amount }));
}

const plot = {
  width: 620,
  height: 260,
  left: 43,
  right: 11,
  top: 20,
  bottom: 33,
};
const innerWidth = plot.width - plot.left - plot.right;
const innerHeight = plot.height - plot.top - plot.bottom;

function axes(max, labels) {
  const y = (value) => plot.top + innerHeight * (1 - value / max);
  let svg = "";
  for (let index = 0; index <= 4; index++) {
    const value = (max * index) / 4;
    svg += `<line class="grid-line" x1="${plot.left}" x2="${plot.width - plot.right}" y1="${y(value)}" y2="${y(value)}"/><text class="axis-label" x="${plot.left - 11}" y="${y(value) + 3}" text-anchor="end">${value >= 10 ? value.toFixed(0) : value.toFixed(1)}</text>`;
  }
  labels.forEach((label) => {
    svg += `<text class="axis-label" x="${plot.left + innerWidth * label.position}" y="${plot.height - 9}" text-anchor="${label.position === 0 ? "start" : label.position === 1 ? "end" : "middle"}">${escape(label.text)}</text>`;
  });
  return svg;
}

function niceMax(value) {
  if (!value || !Number.isFinite(value)) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  return (Math.ceil(((value * 1.1) / magnitude) * 2) / 2) * magnitude;
}

function pathFor(values, max, length) {
  return values
    .map(
      (value, index) =>
        `${index ? "L" : "M"}${plot.left + (index / Math.max(length - 1, 1)) * innerWidth},${plot.top + innerHeight * (1 - value / max)}`,
    )
    .join(" ");
}

function setChart(id, markup, records, content) {
  const container = $(id);
  container.innerHTML = `<svg viewBox="0 0 ${plot.width} ${plot.height}" role="img" aria-label="${escape(container.getAttribute("aria-label"))}">${markup}<line class="hover-line" y1="${plot.top}" y2="${plot.top + innerHeight}" stroke="#ccd2dc" stroke-dasharray="3 3" visibility="hidden"/></svg><div class="chart-tooltip"></div>`;
  const tooltip = container.querySelector(".chart-tooltip");
  const line = container.querySelector(".hover-line");
  container.onpointermove = (event) => {
    if (!records.length) return;
    const rect = container.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * plot.width;
    const fraction = Math.max(0, Math.min(1, (x - plot.left) / innerWidth));
    const index = Math.round(fraction * (records.length - 1));
    tooltip.innerHTML = content(records[index]);
    tooltip.style.display = "block";
    tooltip.style.left = `${Math.max(75, Math.min(rect.width - 75, event.clientX - rect.left))}px`;
    tooltip.style.top = `${Math.max(0, event.clientY - rect.top - 70)}px`;
    const lineX =
      plot.left + (index / Math.max(records.length - 1, 1)) * innerWidth;
    line.setAttribute("x1", lineX);
    line.setAttribute("x2", lineX);
    line.setAttribute("visibility", "visible");
  };
  container.onpointerleave = () => {
    tooltip.style.display = "none";
    line.setAttribute("visibility", "hidden");
  };
}

function emptyChart(id, message) {
  $(id).innerHTML =
    `<div class="chart-empty">${escape(message)}<br><small>数据可用后自动恢复</small></div>`;
  $(id).onpointermove = null;
  $(id).onpointerleave = null;
}

function renderCharts() {
  const summary = state.summary;
  if (!summary?.date) {
    emptyChart("intraday-chart", "等待当日五分钟数据");
    emptyChart("history-chart", "等待历史成交额");
    return;
  }
  const times = ["09:30", ...BAR_TIMES];
  const historical = state.pool.map((fund) =>
    completeDays(state.history[fund.symbol]?.fiveMinute, summary.date),
  );
  const today = state.pool.map(
    (fund) =>
      new Map(
        (state.history[fund.symbol]?.fiveMinute || [])
          .filter(([time]) => time.slice(0, 10) === summary.date)
          .map(([time, amount]) => [time.slice(11, 16), amount]),
      ),
  );
  const hasBaseline = historical.every((days) => days.length >= 5);
  if (hasBaseline) {
    const reference = [0];
    const current = [0];
    let currentComplete = true;
    for (const time of times.slice(1)) {
      const baselineAmount = historical.reduce(
        (sum, days) =>
          sum +
          days.reduce(
            (dailySum, [, items]) => dailySum + (items.get(time) || 0),
            0,
          ) /
            days.length,
        0,
      );
      reference.push(reference.at(-1) + baselineAmount / 1e8);
      currentComplete =
        currentComplete &&
        today.every((items) => items.has(time)) &&
        time <= (summary.cutoff || "00:00");
      if (currentComplete)
        current.push(
          current.at(-1) +
            today.reduce((sum, items) => sum + items.get(time), 0) / 1e8,
        );
    }
    const max = niceMax(Math.max(...reference, ...current));
    const labels = [
      { position: 0, text: "09:30" },
      { position: 0.25, text: "10:30" },
      { position: 0.5, text: "11:30 / 13:00" },
      { position: 0.75, text: "14:00" },
      { position: 1, text: "15:00" },
    ];
    let svg =
      '<defs><linearGradient id="volume-area" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stop-color="#0071e3" stop-opacity=".18"/><stop offset="100%" stop-color="#0071e3" stop-opacity=".01"/></linearGradient></defs>' +
      axes(max, labels);
    svg += `<path d="${pathFor(reference, max, times.length)}" fill="none" stroke="#b5becb" stroke-width="1.8" stroke-dasharray="5 5"/>`;
    if (current.length > 1) {
      const lastX =
        plot.left + ((current.length - 1) / (times.length - 1)) * innerWidth;
      const lastY = plot.top + innerHeight * (1 - current.at(-1) / max);
      svg += `<path d="${pathFor(current, max, times.length)} L${lastX},${plot.top + innerHeight} L${plot.left},${plot.top + innerHeight} Z" fill="url(#volume-area)"/><path d="${pathFor(current, max, times.length)}" fill="none" stroke="#0071e3" stroke-width="2.4" stroke-linejoin="round"/><circle cx="${lastX}" cy="${lastY}" r="3.5" fill="#0071e3" stroke="#fff" stroke-width="2"/>`;
    }
    const records = times.map((time, index) => ({
      time,
      current: current[index],
      reference: reference[index],
    }));
    setChart(
      "intraday-chart",
      svg,
      records,
      (row) =>
        `<b>${summary.date} ${row.time}</b><br>当日累计 ${decimal(row.current)} 亿<br>历史同刻 ${decimal(row.reference)} 亿`,
    );
    const minDays = Math.min(...historical.map((days) => days.length));
    $("intraday-foot").textContent =
      `五分钟口径 · 当日数据截至 ${summary.cutoff || "待更新"} · 各 ETF 前 ${minDays === 20 ? "20" : `${minDays}—20`} 个完整交易日同刻均值`;
  } else {
    emptyChart("intraday-chart", "历史同刻样本暂不足");
    $("intraday-foot").textContent =
      "至少需要各 ETF 的 5 个完整历史交易日，历史更新失败时可稍后重试。";
  }
  const all = dailySeries();
  const daily = all.slice(-state.range);
  if (!daily.length) {
    emptyChart("history-chart", "历史成交额暂不可用");
    return;
  }
  const previous = all.filter((row) => row.date < summary.date).slice(-20);
  const average = previous.length
    ? previous.reduce((sum, row) => sum + row.amount, 0) / previous.length / 1e8
    : 0;
  const max = niceMax(
    Math.max(average, ...daily.map((row) => row.amount / 1e8)),
  );
  const labelIndices = [
    ...new Set([
      0,
      Math.floor((daily.length - 1) / 3),
      Math.floor(((daily.length - 1) * 2) / 3),
      daily.length - 1,
    ]),
  ];
  const labels = labelIndices.map((index) => ({
    position: daily.length > 1 ? index / (daily.length - 1) : 0,
    text: daily[index].date.slice(5).replace("-", "/"),
  }));
  let svg = axes(max, labels);
  const barWidth = (innerWidth / daily.length) * 0.61;
  daily.forEach((row, index) => {
    const height = (row.amount / 1e8 / max) * innerHeight;
    const x = plot.left + ((index + 0.5) / daily.length) * innerWidth;
    const partial =
      row.date === chinaNow().slice(0, 10) &&
      chinaNow().slice(11, 16) < "15:00";
    svg += `<rect x="${x - barWidth / 2}" y="${plot.top + innerHeight - height}" width="${barWidth}" height="${height}" rx="1" fill="${partial ? "#d8e7fb" : row.date === summary.date ? "#0071e3" : "#acc7ee"}"/>`;
  });
  if (average) {
    const y = plot.top + innerHeight * (1 - average / max);
    svg += `<line x1="${plot.left}" x2="${plot.width - plot.right}" y1="${y}" y2="${y}" stroke="#aeb8c7" stroke-dasharray="4 4" stroke-width="1.2"/>`;
  }
  setChart(
    "history-chart",
    svg,
    daily,
    (row) =>
      `<b>${row.date}</b><br>池内成交额 ${money(row.amount)} 亿<br>前 ${previous.length} 日均值 ${decimal(average)} 亿`,
  );
  $("history-foot").textContent =
    `${daily[0].date} — ${daily.at(-1).date} · ${daily.length} 个交易日 · 前 ${previous.length} 日均值 ${decimal(average)} 亿 · 浅色柱为当日盘中累计`;
}

function selectGroup(group, scroll) {
  state.group = group;
  renderGroups(state.summary);
  renderTable();
  if (scroll) $("funds").scrollIntoView({ behavior: "smooth", block: "start" });
}

$("refresh").addEventListener("click", () => {
  refreshQuotes();
  refreshHistory(true);
});
$("pause").addEventListener("click", () => {
  state.paused = !state.paused;
  $("pause").textContent = state.paused ? "继续刷新" : "暂停刷新";
  $("pause").setAttribute("aria-pressed", String(state.paused));
  if (!state.paused) {
    refreshQuotes();
    refreshHistory();
  }
});
$("search").addEventListener("input", (event) => {
  state.search = event.target.value;
  renderTable();
});
$("group-cards").addEventListener("click", (event) => {
  const button = event.target.closest("[data-group]");
  if (button) selectGroup(button.dataset.group, true);
});
$("filters").addEventListener("click", (event) => {
  const button = event.target.closest("[data-group]");
  if (button) selectGroup(button.dataset.group, false);
});
document.querySelectorAll("[data-sort]").forEach((button) =>
  button.addEventListener("click", () => {
    state.direction =
      state.sort === button.dataset.sort ? -state.direction : -1;
    state.sort = button.dataset.sort;
    renderTable();
  }),
);
document.querySelectorAll("[data-range]").forEach((button) =>
  button.addEventListener("click", () => {
    state.range = Number(button.dataset.range);
    document.querySelectorAll("[data-range]").forEach((item) => {
      item.classList.toggle("active", item === button);
      item.setAttribute("aria-pressed", String(item === button));
    });
    renderCharts();
  }),
);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && !state.paused) {
    refreshQuotes();
    refreshHistory();
  }
});
window.addEventListener("online", () => {
  if (!state.paused) {
    refreshQuotes();
    refreshHistory(true);
  }
});

setInterval(() => {
  if (document.hidden || !state.pool.length) return;
  const remaining = Math.max(
    0,
    Math.ceil((REFRESH_MS - (Date.now() - state.lastAttempt)) / 1000),
  );
  $("countdown").textContent = state.paused
    ? "自动刷新已暂停 · 可手动刷新"
    : state.loading
      ? "正在更新行情…"
      : `${remaining} 秒后刷新行情 · 量能每 5 分钟`;
  if (!state.paused && !remaining && !state.loading) refreshQuotes();
  if (!state.paused) refreshHistory();
}, 1000);

async function init() {
  try {
    state.pool = JSON.parse(await fetchText("./pool.json"));
    try {
      await syncSnapshot();
    } catch {
      state.snapshotError = true;
    }
    render();
    refreshQuotes();
    refreshHistory();
  } catch {
    $("conclusion-headline").textContent = "数据暂不可用。";
    $("conclusion-summary").textContent =
      "请检查网络连接，或稍后重新加载页面。";
    $("signal-title").textContent = "页面配置加载失败";
    $("signal-detail").textContent = "请检查网络连接，或稍后重新加载页面。";
    $("market-badge").textContent = "连接失败";
  }
}

init();
