import {
  chinaNow,
  parseQuotes,
  marketState,
  signalFor,
  liveSummary,
  parseMinuteLines,
  parseTrendLines,
  poolMinutes,
  fundPulses,
  profileAt,
  minuteShape,
  sessionPhase,
  tradingMinute,
  LIVE_MIN_MINUTE,
  minuteFeedMode,
} from "./core.js?v=20261106g";

// Minute lines change once a minute; the chart's live tip moves every second from the quotes.
const MINUTE_MS = 60_000;
const SNAPSHOT_MS = 10 * 60_000;
// Funds whose last five days of minute data define the within-bar minute shape.
const SHAPE_FUNDS = ["sh510300", "sh510500", "sh512100", "sz159915", "sh588080", "sh510050"];
const INDEXES = [
  { symbol: "sh000001", name: "上证指数" },
  { symbol: "sh000300", name: "沪深300" },
  { symbol: "sh000016", name: "上证50" },
  { symbol: "sh000905", name: "中证500" },
  { symbol: "sh000852", name: "中证1000" },
  { symbol: "sz399006", name: "创业板指" },
  { symbol: "sh000688", name: "科创50" },
];
const GROUP_INDEX = {
  沪深300: "sh000300",
  上证50: "sh000016",
  中证500: "sh000905",
  中证1000: "sh000852",
  科创50: "sh000688",
  创业板: "sz399006",
};
const CORE_GROUP = "沪深300";
const CHART_INDEX = "sh000300";
// Evidence thresholds (site rules, shown next to every item).
const EVIDENCE = { volume: 1.3, core: 1.5, skew: 0.03, premium: 0.1 };

const $ = (id) => document.getElementById(id);
const escape = (text) =>
  String(text).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
const finite = Number.isFinite;
const yi = (value, places) =>
  finite(value)
    ? (value / 1e8).toFixed(places ?? (Math.abs(value) >= 1e10 ? 1 : 2))
    : "—";
const signedYi = (value, places) =>
  finite(value) ? `${value > 0 ? "+" : ""}${yi(value, places)}` : "—";
const pct = (value, places = 2) =>
  finite(value) ? `${value > 0 ? "+" : ""}${value.toFixed(places)}%` : "—";
const times = (value) => (finite(value) ? `${value.toFixed(2)}×` : "—");
const tone = (value) => (value > 0 ? "up" : value < 0 ? "down" : "");
const levelOf = (ratio) =>
  !finite(ratio) ? "" : ratio >= 1.8 ? "strong" : ratio >= 1.3 ? "watch" : "";
const hms = (time) =>
  time ? `${time.slice(8, 10)}:${time.slice(10, 12)}:${time.slice(12, 14)}` : "";

const state = {
  pool: [],
  quotes: {},
  history: {},
  minutes: {},
  snapshotAt: "",
  source: "snapshot",
  quoteError: "",
  snapshotError: false,
  minuteErrors: 0,
  loading: false,
  minuteLoading: false,
  shape: null,
  shapeLoading: false,
  sourceStatus: {},
  sourceDown: {},
  sourceFailures: {},
  holiday: "",
  quoteSignature: "",
  hover: null,
  ticks: 0,
  lastQuote: 0,
  lastQuoteOk: 0,
  lastMinute: 0,
  lastSnapshot: 0,
  group: "全部",
  search: "",
  sort: "amount",
  direction: -1,
  summary: null,
  view: null,
  seen: new Set(),
  firstFeed: true,
  headline: "",
};

/* ---------------- Data ---------------- */
async function fetchText(url, timeout = 12_000, cache = "no-store") {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeout), cache });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const bytes = await response.arrayBuffer();
  const utf8 = new TextDecoder("utf-8").decode(bytes);
  return utf8.includes("�") ? new TextDecoder("gb18030").decode(bytes) : utf8;
}

// Quotes are polled every second while the exchange is trading. The page re-renders only when
// a quote actually changed (Level-1 snapshots update every ~3 s), so animations stay smooth.
async function refreshQuotes() {
  if (state.loading || !state.pool.length) return;
  state.loading = true;
  state.lastQuote = Date.now();
  let changed = false;
  const hadError = Boolean(state.quoteError);
  try {
    const symbols = [...state.pool.map((fund) => fund.symbol), ...INDEXES.map((item) => item.symbol)];
    const fresh = parseQuotes(await fetchText(`https://qt.gtimg.cn/q=${symbols.join(",")}&_=${Date.now()}`, 5_000));
    const valid = state.pool.filter((fund) => (fresh[fund.symbol]?.length || 0) > 37);
    if (!valid.length) throw new Error("行情格式异常");
    // Different quote servers can be a second or two apart; never step a fund back in time.
    const quotes = { ...fresh };
    if (state.source === "live") {
      for (const symbol of symbols) {
        const old = state.quotes[symbol];
        const now = fresh[symbol];
        if (old && (!now || (/^\d{14}$/.test(old[30] || "") && /^\d{14}$/.test(now[30] || "") && now[30] < old[30])))
          quotes[symbol] = old;
      }
    }
    const signature = symbols.map((symbol) => `${quotes[symbol]?.[30]}:${quotes[symbol]?.[37]}:${quotes[symbol]?.[3]}`).join("|");
    changed = signature !== state.quoteSignature || state.source !== "live";
    state.quoteSignature = signature;
    state.quotes = quotes;
    state.source = "live";
    state.quoteError = "";
    state.lastQuoteOk = Date.now();
    detectHoliday();
  } catch (error) {
    state.quoteError = error.name === "TimeoutError" ? "实时行情请求超时" : "实时行情连接失败";
  } finally {
    state.loading = false;
    if (changed || hadError !== Boolean(state.quoteError)) render();
    else renderStatus();
  }
}

// A weekday on which the exchange does not open: during trading hours the quotes keep an
// older date. Polling then stops for the day.
function detectHoliday() {
  const phase = sessionPhase();
  if (phase.phase !== "open") return;
  const local = chinaNow();
  if (local.slice(11, 16) < "09:35") return;
  const dates = state.pool.map((fund) => state.quotes[fund.symbol]?.[30]?.slice(0, 8)).filter(Boolean).sort();
  const latest = dates.at(-1);
  if (latest && `${latest.slice(0, 4)}-${latest.slice(4, 6)}-${latest.slice(6, 8)}` < phase.date) state.holiday = phase.date;
}

function currentPhase() {
  const phase = sessionPhase();
  if (state.holiday === phase.date && phase.poll) return { ...phase, phase: "closed", label: "休市日", poll: 0 };
  return phase;
}

async function refreshShape() {
  if (state.shapeLoading) return;
  state.shapeLoading = true;
  try {
    // Five days of minute turnover per fund: Eastmoney first, Tencent's five-day feed as backup.
    const results = await Promise.allSettled(
      SHAPE_FUNDS.map(async (symbol) => {
        try {
          return [...(await trendDays(symbol, 5))].map(([date, records]) => ({ date, records }));
        } catch {
          const payload = JSON.parse(
            await fetchText(`https://web.ifzq.gtimg.cn/appstock/app/day/query?code=${symbol}&_=${Date.now()}`, 15_000),
          );
          return (payload.data?.[symbol]?.data || []).map((day) => ({
            date: `${day.date.slice(0, 4)}-${day.date.slice(4, 6)}-${day.date.slice(6, 8)}`,
            records: parseMinuteLines(day.data),
          }));
        }
      }),
    );
    const today = chinaNow().slice(0, 10);
    const days = results
      .filter((result) => result.status === "fulfilled")
      .flatMap((result) => result.value)
      .filter((day) => day.date < today)
      .map((day) => day.records);
    const shape = minuteShape(days);
    if (shape) state.shape = { ...shape, builtFor: today };
  } catch {
    /* fall back to linear interpolation */
  } finally {
    state.shapeLoading = false;
  }
}

// The history snapshot (~325 KB gzipped from github.io) only feeds the same-time baseline.
// github.io can be slow from mainland China, so a failed load is retried within seconds and,
// meanwhile, the baseline is rebuilt from Eastmoney's five-minute bars (the same raw data).
const SNAPSHOT_RETRY_MS = [5_000, 15_000, 30_000, 60_000, 120_000];
async function syncSnapshot() {
  if (state.snapshotLoading) return;
  state.snapshotLoading = true;
  state.lastSnapshot = Date.now();
  try {
    // A stable URL reuses Pages' ten-minute HTTP cache across visits and visitors.
    // The scheduler requests it again after that cache lifetime has elapsed.
    const snapshot = JSON.parse(await fetchText("./data/snapshot.json", 30_000, "default"));
    if (!snapshot.generatedAt || !snapshot.history) throw new Error("快照格式异常");
    if (snapshot.generatedAt !== state.snapshotAt) {
      state.history = snapshot.history;
      state.snapshotAt = snapshot.generatedAt;
      state.baselineSource = "云端快照";
      if (state.source !== "live") state.quotes = { ...snapshot.quotes };
    }
    state.snapshotError = false;
    state.snapshotLoaded = true;
    state.snapshotFails = 0;
  } catch {
    state.snapshotError = true;
    state.snapshotFails = (state.snapshotFails || 0) + 1;
    state.nextSnapshotTry = Date.now() + SNAPSHOT_RETRY_MS[Math.min(state.snapshotFails - 1, SNAPSHOT_RETRY_MS.length - 1)];
    if (!state.snapshotLoaded) loadBaselineDirect();
  } finally {
    state.snapshotLoading = false;
  }
}

async function loadBaselineDirect() {
  if (state.directLoading || state.snapshotLoaded) return;
  state.directLoading = true;
  const missing = state.pool.filter((fund) => !(state.history[fund.symbol]?.fiveMinute?.length >= 240));
  for (let start = 0; start < missing.length; start += 6) {
    const batch = missing.slice(start, start + 6);
    const results = await Promise.allSettled(
      batch.map(async (fund) => {
        const payload = JSON.parse(
          await fetchText(
            `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid(fund.symbol)}&fqt=0&end=20500101&klt=5&lmt=1100&fields1=f1&fields2=f51,f53,f57&_=${Date.now()}`,
            15_000,
          ),
        );
        const lines = payload.data?.klines;
        if (!Array.isArray(lines) || lines.length < 240) throw new Error("历史数据为空");
        return lines.map((line) => {
          const [time, close, amount] = line.split(",");
          return [time, Number(amount), Number(close)];
        });
      }),
    );
    if (state.snapshotLoaded) break;
    results.forEach((result, index) => {
      if (result.status === "fulfilled") state.history[batch[index].symbol] = { fiveMinute: result.value };
    });
  }
  if (!state.snapshotLoaded && state.pool.every((fund) => state.history[fund.symbol]?.fiveMinute?.length >= 240))
    state.baselineSource = "东方财富直连";
  state.directLoading = false;
  render();
}

// Prefer the browser-accessible feed. Repeated connection failures rest a host for five
// minutes, while a single fund with no records can still fall back to the other feed.
const SOURCE_COOLDOWN_MS = 5 * 60_000;
const secid = (symbol) => `${symbol.startsWith("sh") ? "1" : "0"}.${symbol.slice(2)}`;
const sourceUp = (name) => !(state.sourceDown?.[name] > Date.now());
function sourceFailed(name, error) {
  const connectionFailure = error.name === "TypeError" || error.name === "TimeoutError" || /^HTTP (429|5\d\d)$/.test(error.message);
  if (!connectionFailure) return;
  state.sourceFailures[name] = (state.sourceFailures[name] || 0) + 1;
  if (state.sourceFailures[name] >= 3) state.sourceDown[name] = Date.now() + SOURCE_COOLDOWN_MS;
}

async function minuteFromTencent(symbol) {
  const payload = JSON.parse(
    await fetchText(`https://web.ifzq.gtimg.cn/appstock/app/minute/query?code=${symbol}&_=${Date.now()}`, 8_000),
  );
  const minute = payload.data?.[symbol]?.data;
  if (!minute?.date || !Array.isArray(minute.data)) throw new Error("分时数据为空");
  return {
    date: `${minute.date.slice(0, 4)}-${minute.date.slice(4, 6)}-${minute.date.slice(6, 8)}`,
    records: parseMinuteLines(minute.data),
    source: "腾讯",
  };
}

async function trendDays(symbol, days) {
  const payload = JSON.parse(
    await fetchText(
      `https://push2his.eastmoney.com/api/qt/stock/trends2/get?secid=${secid(symbol)}&fields1=f1&fields2=f51,f52,f53,f56,f57&ndays=${days}&iscr=0&_=${Date.now()}`,
      10_000,
    ),
  );
  const lines = payload.data?.trends;
  if (!Array.isArray(lines) || !lines.length) throw new Error("分时数据为空");
  return parseTrendLines(lines);
}

async function minuteFromEastmoney(symbol) {
  const days = await trendDays(symbol, 1);
  const date = [...days.keys()].sort().at(-1);
  return { date, records: days.get(date), source: "东方财富" };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchMinute(symbol) {
  const order = ["eastmoney", "tencent"].filter(sourceUp);
  let lastError = new Error("分钟行情源暂处于重试冷却期");
  for (const name of order) {
    try {
      const result = await (name === "tencent" ? minuteFromTencent(symbol) : minuteFromEastmoney(symbol));
      if (!result.records?.length) throw new Error("分时数据为空");
      state.sourceFailures[name] = 0;
      state.sourceDown[name] = 0;
      state.sourceStatus[name] = { ok: Date.now(), error: state.sourceStatus[name]?.error || "" };
      return result;
    } catch (error) {
      lastError = error;
      sourceFailed(name, error);
      // fetch() rejects with a bare TypeError when CORS, an extension or the network blocks it.
      const reason =
        error.name === "TimeoutError" ? "请求超时" : error.name === "TypeError" ? "请求被拦截（跨域 / 扩展 / 网络）" : error.message || "失败";
      state.sourceStatus[name] = { ok: state.sourceStatus[name]?.ok || 0, error: reason, at: Date.now() };
    }
  }
  throw lastError;
}

// Minute lines every 60 s while trading; after a pause starts, keep fetching (60 s apart) only
// until the minute data has caught up with the last quote, then stop.
function minutesDue() {
  if (Date.now() - state.lastMinute < MINUTE_MS) return false;
  if (currentPhase().poll) return true;
  const summary = state.summary;
  if (!summary?.clock) return false;
  const item = state.minutes[state.pool[0]?.symbol];
  if (!item || item.date !== summary.date) return true;
  const last = item.records.at(-1)?.clock || "00:00";
  const target = summary.clock > "15:00" ? "15:00" : summary.clock > "11:30" && summary.clock < "13:00" ? "11:30" : summary.clock;
  return last < target;
}

async function refreshMinutes(force = false) {
  if (state.minuteLoading || !state.pool.length) return;
  if (!force && !minutesDue()) return;
  state.minuteLoading = true;
  state.lastMinute = Date.now();
  // Four at a time with a short gap (both hosts throttle bursts); funds that fail are retried
  // twice within the same round, 1.2 s and 2.4 s later, using hosts outside their cooldown.
  let pending = [...state.pool.map((fund) => fund.symbol), CHART_INDEX];
  for (let attempt = 0; attempt < 3 && pending.length; attempt++) {
    if (attempt) await sleep(1200 * attempt);
    const failed = [];
    for (let start = 0; start < pending.length; start += 4) {
      const batch = pending.slice(start, start + 4);
      const results = await Promise.allSettled(batch.map((symbol) => fetchMinute(symbol)));
      results.forEach((result, index) => {
        if (result.status === "fulfilled" && result.value.records?.length) state.minutes[batch[index]] = result.value;
        else failed.push(batch[index]);
      });
      if (start + 4 < pending.length) await sleep(150);
    }
    pending = failed;
  }
  state.minuteErrors = pending.length;
  state.minuteLoading = false;
  render();
}

// Funds whose minute lines trail the live quote by more than two trading minutes.
function staleMinuteFunds(summary) {
  if (!summary?.clock || !summary.date) return [];
  const now = tradingMinute(summary.clock);
  return state.pool.filter((fund) => {
    const item = state.minutes[fund.symbol];
    if (!item || item.date !== summary.date || !item.records.length) return true;
    return now - tradingMinute(item.records.at(-1).clock) > 2;
  });
}

/* ---------------- Derived view ---------------- */
function indexQuote(symbol) {
  const fields = state.quotes[symbol];
  if (!fields || fields.length < 33) return null;
  const price = Number(fields[3]);
  const prev = Number(fields[4]);
  const change = Number(fields[32]);
  if (!finite(price) || price <= 0) return null;
  return { symbol, price, prev, change, time: fields[30] };
}

function buildView() {
  const shape = state.shape;
  const summary = liveSummary(state.pool, state.quotes, state.history, shape);
  const market = marketState(summary.time);
  const signal = signalFor(summary, market);
  const profiles = Object.fromEntries(summary.rows.map((row) => [row.symbol, row.profile]));
  const date = summary.date;
  const minuteMap = {};
  const used = [];
  for (const fund of state.pool) {
    const item = state.minutes[fund.symbol];
    if (item?.date === date && item.records.length) {
      minuteMap[fund.symbol] = item.records;
      used.push(fund.symbol);
    }
  }
  let series = used.length ? poolMinutes(minuteMap, profiles, used, shape) : [];
  let coarse = false;
  // Last resort: both minute feeds unavailable in this browser → today's five-minute bars from
  // the cloud snapshot (refreshed by Actions every five minutes during the session).
  if (!series.length && date) {
    const barMap = {};
    for (const fund of state.pool) {
      let cumulative = 0;
      const records = (state.history[fund.symbol]?.fiveMinute || [])
        .filter(([time]) => time.slice(0, 10) === date)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([time, amount, price]) => {
          cumulative += amount;
          const clock = time.slice(11, 16);
          return { clock, minute: tradingMinute(clock), price, cumulative, amount };
        });
      if (records.length) barMap[fund.symbol] = records;
    }
    const barSymbols = state.pool.map((fund) => fund.symbol).filter((symbol) => barMap[symbol]);
    if (barSymbols.length === state.pool.length) {
      series = poolMinutes(barMap, profiles, barSymbols, null).map((point) => ({
        ...point,
        expected: point.expected === null ? null : point.expected * 5,
        multiple: point.expected ? point.amount / (point.expected * 5) : null,
        pulse: false,
        strong: false,
      }));
      used.splice(0, used.length, ...barSymbols);
      coarse = series.length > 0;
    }
  }
  const indexMinutes = state.minutes[CHART_INDEX]?.date === date ? state.minutes[CHART_INDEX].records : [];
  const hs300 = indexQuote(CHART_INDEX);
  const indexPrev = hs300?.prev;
  const indexByClock = new Map(
    indexMinutes.map((record) => [record.clock, indexPrev ? (record.price / indexPrev - 1) * 100 : null]),
  );
  series.forEach((point) => (point.index = indexByClock.get(point.clock) ?? null));

  const events = [];
  for (const fund of state.pool) {
    if (minuteMap[fund.symbol] && profiles[fund.symbol])
      events.push(...fundPulses(fund, minuteMap[fund.symbol], profiles[fund.symbol], shape));
  }
  events.sort((a, b) => b.minute - a.minute || b.multiple - a.multiple);

  const groups = [...new Set(state.pool.map((fund) => fund.group))].map((group) => {
    const rows = summary.rows.filter((row) => row.group === group);
    const amount = rows.reduce((sum, row) => sum + row.amount, 0);
    const expectedReady = rows.length && rows.every((row) => finite(row.expected));
    const expected = expectedReady ? rows.reduce((sum, row) => sum + row.expected, 0) : null;
    const flowReady = rows.length && rows.every((row) => row.flow !== null);
    return {
      group,
      count: state.pool.filter((fund) => fund.group === group).length,
      rows,
      amount,
      ratio:
        expected && summary.minute >= LIVE_MIN_MINUTE ? amount / expected : null,
      flow: flowReady ? rows.reduce((sum, row) => sum + row.flow, 0) : null,
      change: amount ? rows.reduce((sum, row) => sum + row.change * row.amount, 0) / amount : null,
      index: GROUP_INDEX[group] ? indexQuote(GROUP_INDEX[group]) : null,
    };
  });

  const core = groups.find((item) => item.group === CORE_GROUP);
  const skew = summary.flow !== null && summary.amount ? summary.flow / summary.amount : null;
  const buyPulses = series.filter((point) => point.pulse && point.move > 0);
  const defensePulses = buyPulses.filter((point) => point.index !== null && point.index < 0);
  const evidence = [
    {
      label: "全池放量",
      hit: finite(summary.ratio) ? summary.ratio >= EVIDENCE.volume : null,
      detail: finite(summary.ratio) ? `${times(summary.ratio)} · 需 ≥ ${EVIDENCE.volume}×` : "开盘 5 分钟后计算",
    },
    {
      label: "沪深300 主力放量",
      hit: finite(core?.ratio) ? core.ratio >= EVIDENCE.core : null,
      detail: finite(core?.ratio) ? `4 只合计 ${times(core.ratio)} · 需 ≥ ${EVIDENCE.core}×` : "等待基线",
    },
    {
      label: "主动买盘占优",
      hit: skew === null ? null : skew >= EVIDENCE.skew,
      detail: skew === null ? "外内盘数据不足" : `净买入占成交 ${pct(skew * 100, 1)} · 需 ≥ +${EVIDENCE.skew * 100}%`,
    },
    {
      label: "溢价走阔",
      hit: finite(summary.premium) ? summary.premium >= EVIDENCE.premium : null,
      detail: finite(summary.premium) ? `加权 ${pct(summary.premium)} · 需 ≥ +${EVIDENCE.premium.toFixed(2)}%` : "等待 IOPV",
    },
    {
      label: "跌势中放量拉升",
      hit: !coarse && series.length ? defensePulses.length > 0 : null,
      detail: coarse ? "等待逐分钟数据，五分钟快照暂不判定脉冲" : series.length
        ? defensePulses.length
          ? `${defensePulses.length} 次 · 最近 ${defensePulses.at(-1).clock}`
          : `指数翻绿时的买入脉冲 0 次`
        : "等待逐分钟数据",
    },
  ];
  const minuteMode = minuteFeedMode({ hasRecords: series.length > 0, coarse, attempted: state.lastMinute > 0, loading: state.minuteLoading });
  return { summary, market, signal, profiles, shape, series, coarse, minuteMode, used, indexMinutes, hs300, events, groups, core, skew, buyPulses, defensePulses, evidence };
}

/* ---------------- Render ---------------- */
function render() {
  if (!state.pool.length) return;
  const view = buildView();
  state.summary = view.summary;
  state.view = view;
  renderHero(view);
  renderTicker();
  renderGauge(view.summary.ratio, view.signal.level);
  renderKpis(view);
  renderAlerts(view);
  renderChart();
  renderFeed(view);
  renderGroups(view);
  renderTable();
  renderHealth(view);
  // Value flashes start after the first live render, so the snapshot → live switch is quiet.
  if (state.source === "live") state.bumpReady = true;
}

function heroSentence(view) {
  const { summary, signal, skew } = view;
  if (!finite(summary.ratio)) return { lede: signal.detail, note: "" };
  const ratio = summary.ratio.toFixed(2);
  const flow = signedYi(summary.flow, 2);
  const volume =
    summary.ratio >= 1.8
      ? `成交额达到历史同时点均值的 <b>${ratio} 倍</b>`
      : summary.ratio >= 1.3
        ? `成交额是历史同时点均值的 <b>${ratio} 倍</b>`
        : `成交额只有历史同时点均值的 <b>${ratio} 倍</b>`;
  const direction =
    summary.flow === null
      ? "主动买卖方向暂缺"
      : `主动净买入 <b>${flow} 亿元</b>${skew !== null ? `（占成交 ${pct(skew * 100, 1)}）` : ""}`;
  const mood =
    signal.level === "strong"
      ? "放量且买盘占优。"
      : signal.level === "watch"
        ? summary.flow > 0
          ? "放量，买盘偏强。"
          : "放量，但买盘没占上风。"
        : summary.flow > 0
          ? "量能平稳，略有买盘。"
          : "量价都平静。";
  const pulses = view.buyPulses.length
    ? `盘中 ${view.buyPulses.length} 次放量拉升${view.defensePulses.length ? `，其中 ${view.defensePulses.length} 次发生在指数下跌时` : ""}。`
    : "";
  const note =
    summary.progress !== null && summary.clock
      ? `${summary.clock} 历史平均已走完全天 ${(summary.progress * 100).toFixed(1)}%，分母已按同比例缩放；今日已达全天日均 ${times(summary.dayRatio)}。`
      : "";
  return { lede: `${volume}，${direction}，${mood}${pulses}`, note };
}

function renderHero(view) {
  const { summary, market, signal } = view;
  const today = summary.date === chinaNow().slice(0, 10);
  $("conclusion-context").textContent = !summary.date
    ? "等待有效数据"
    : today
      ? market.session
        ? "今日结论 · 实时跟踪"
        : `今日结论 · ${market.label}`
      : `${summary.date} 结论 · 最近交易日`;
  $("question").textContent = today || !summary.date ? "汪汪队今天进场了吗？" : `汪汪队 ${summary.date.slice(5).replace("-", " 月 ")} 日进场了吗？`;
  $("eyebrow-dot").className = `live-dot ${market.session && market.fresh ? "live" : ""}`;
  const headline = signal.headline.replace(/。$/, "");
  const element = $("conclusion-headline");
  element.className = `headline level-${signal.level}`;
  if (state.headline !== headline) {
    element.textContent = headline;
    void element.offsetWidth;
    element.classList.add("flash");
    state.headline = headline;
  }
  const sentence = heroSentence(view);
  $("conclusion-summary").innerHTML = sentence.lede;
  $("conclusion-note").textContent = sentence.note;
  $("overview").dataset.level = signal.level;
  $("signal-badge").textContent = signal.label;
  $("signal-badge").className = `tag level-${signal.level}`;
  $("coverage").textContent = `${summary.rows.length} / ${state.pool.length} 只 ETF 有行情`;
  $("baseline-note").textContent = summary.days
    ? `基线 · 前 ${summary.days} 个完整交易日同时点`
    : "同时点基线准备中";
  renderEvidence(view.evidence);
  renderStatus();
  document.title = finite(summary.ratio)
    ? `${times(summary.ratio)} ${headline} · 汪汪队 ETF 观察站`
    : "汪汪队 ETF 观察站 · 盘中实时";
}

// Status pill + timestamp, refreshed every second without re-rendering the page.
function renderStatus() {
  const summary = state.summary;
  const phase = currentPhase();
  const market = marketState(summary?.time);
  const live = phase.poll > 0 && state.source === "live" && !state.quoteError;
  const delayed = phase.phase === "open" && (!market.fresh || state.quoteError);
  $("live-pill").className = `live-pill ${delayed ? "delayed" : live ? "live" : ""}`;
  $("market-badge").textContent = delayed ? (state.quoteError ? "连接中断" : "行情延迟") : phase.label;
  $("live-rate").textContent =
    phase.poll === 1000
      ? "每秒刷新"
      : phase.poll
        ? "结算中"
        : phase.phase === "lunch"
          ? "13:00 自动恢复"
          : phase.phase === "pre"
            ? "09:15 自动开始"
            : "自动刷新已暂停";
  const age = state.lastQuoteOk ? Math.max(0, Math.round((Date.now() - state.lastQuoteOk) / 1000)) : null;
  $("update-time").textContent = summary?.time
    ? `行情时间 ${summary.date} ${hms(summary.time)} · ${state.source === "live" ? "腾讯直连" : "云端快照"}${age !== null && state.source === "live" ? ` · ${age === 0 ? "刚刚" : `${age} 秒前`}拉取` : ""}`
    : "尚未取得有效行情";
}

// Evidence lights are updated in place so a flip (e.g. 未命中 → 命中) animates.
function renderEvidence(evidence) {
  const list = $("evidence");
  if (list.children.length !== evidence.length) {
    list.innerHTML = evidence
      .map(() => '<li class="ev pending"><span class="ev-icon" aria-hidden="true"></span><span class="ev-text"><b></b><small></small></span><span class="sr-only"></span></li>')
      .join("");
  }
  evidence.forEach((item, index) => {
    const li = list.children[index];
    const status = item.hit === true ? "hit" : item.hit === false ? "miss" : "pending";
    const previous = li.dataset.status;
    li.querySelector("b").textContent = item.label;
    li.querySelector("small").textContent = item.detail;
    li.querySelector(".ev-icon").textContent = status === "hit" ? "✓" : status === "miss" ? "–" : "";
    li.querySelector(".sr-only").textContent = status === "hit" ? "命中" : status === "miss" ? "未命中" : "待定";
    if (previous !== status) {
      li.className = `ev ${status}`;
      if (previous && status === "hit") {
        void li.offsetWidth;
        li.classList.add("lit");
      }
      li.dataset.status = status;
    }
  });
  const hits = evidence.filter((item) => item.hit === true).length;
  const known = evidence.filter((item) => item.hit !== null).length;
  $("evidence-score").innerHTML = `命中 <span class="${hits ? "up" : ""}">${hits}</span> / ${evidence.length}${known < evidence.length ? `<small>（${evidence.length - known} 项待定）</small>` : ""}`;
}

// Tween a number inside an element; `format` returns the HTML for a value.
function tween(element, value, format, { bump = false, duration = 700 } = {}) {
  const from = Number(element.dataset.value);
  element.dataset.value = finite(value) ? value : "";
  if (!finite(value)) {
    element.innerHTML = format(value);
    return;
  }
  const card = bump && state.bumpReady ? element.closest(".kpi") : null;
  if (card && finite(from) && Math.abs(value - from) > Math.abs(from) * 0.005 + 1e-9) {
    card.classList.remove("bump-up", "bump-down");
    void card.offsetWidth;
    card.classList.add(value > from ? "bump-up" : "bump-down");
  }
  if (!finite(from) || from === value || matchMedia("(prefers-reduced-motion: reduce)").matches) {
    element.innerHTML = format(value);
    return;
  }
  const start = performance.now();
  const step = (now) => {
    if (element.dataset.value !== String(value)) return;
    const t = Math.min(1, (now - start) / duration);
    const eased = 1 - (1 - t) ** 3;
    element.innerHTML = format(from + (value - from) * eased);
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function renderTicker() {
  const items = INDEXES.map((item) => ({ ...item, quote: indexQuote(item.symbol) })).filter((item) => item.quote);
  $("ticker").innerHTML = items.length
    ? items
        .map(
          (item) =>
            `<span class="tick"><span class="tick-name">${item.name}</span><span class="tick-value">${item.quote.price.toFixed(2)}</span><span class="tick-change ${tone(item.quote.change)}">${pct(item.quote.change)}</span></span>`,
        )
        .join("")
    : '<span class="ticker-empty">指数行情暂不可用</span>';
}

function arcPoint(value, radius) {
  const angle = Math.PI * (1 - Math.min(Math.max(value, 0), 3) / 3);
  return [120 + radius * Math.cos(angle), 120 - radius * Math.sin(angle)];
}
function arcPath(from, to, radius) {
  const [x1, y1] = arcPoint(from, radius);
  const [x2, y2] = arcPoint(to, radius);
  return `M${x1.toFixed(2)} ${y1.toFixed(2)} A${radius} ${radius} 0 0 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`;
}
// The gauge is built once; updates only move the fill (dash length) and the needle, so both animate.
function renderGauge(ratio, level) {
  const r = 96;
  const gauge = $("gauge");
  if (!gauge.querySelector(".g-fill")) {
    const ticks = [1.3, 1.8].map((tick) => {
      const [x1, y1] = arcPoint(tick, r - 9);
      const [x2, y2] = arcPoint(tick, r + 9);
      return `<line class="g-tick" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`;
    });
    const labels = [[0, "0"], [1, "1×"], [1.3, "1.3"], [1.8, "1.8"], [3, "3×"]].map(([tick, text]) => {
      const [x, y] = arcPoint(tick, r + 20);
      return `<text class="g-label" x="${x.toFixed(1)}" y="${(y + 3).toFixed(1)}" text-anchor="middle">${text}</text>`;
    });
    gauge.innerHTML = `<defs>
        <linearGradient id="g-strong" x1="0" x2="1"><stop offset="0" stop-color="#ff8a3d"/><stop offset=".5" stop-color="#ff3d3d"/><stop offset="1" stop-color="#e0115f"/></linearGradient>
        <linearGradient id="g-watch" x1="0" x2="1"><stop offset="0" stop-color="#ffb020"/><stop offset="1" stop-color="#ff7a3d"/></linearGradient>
        <linearGradient id="g-calm" x1="0" x2="1"><stop offset="0" stop-color="#00a8d6"/><stop offset="1" stop-color="#0a66d6"/></linearGradient>
      </defs>
      <path class="g-track" d="${arcPath(0, 3, r)}"/>
      <path class="g-zone" d="${arcPath(1.3, 1.8, r)}" stroke="rgba(255,160,32,.22)"/>
      <path class="g-zone" d="${arcPath(1.8, 3, r)}" stroke="rgba(255,61,61,.16)"/>
      <path class="g-fill" d="${arcPath(0, 3, r)}" pathLength="100" stroke-dasharray="0 100" stroke="url(#g-calm)"/>
      ${ticks.join("")}${labels.join("")}
      <g class="g-needle-wrap" opacity="0"><line class="g-needle" x1="120" y1="120" x2="120" y2="${120 - r + 22}" transform="rotate(-90 120 120)"/><circle class="g-hub" cx="120" cy="120" r="5"/></g>`;
  }
  const value = finite(ratio) ? Math.min(ratio, 3) : 0;
  const fill = gauge.querySelector(".g-fill");
  fill.setAttribute("stroke", level === "strong" ? "url(#g-strong)" : level === "watch" ? "url(#g-watch)" : "url(#g-calm)");
  fill.style.strokeDasharray = `${((value / 3) * 100).toFixed(2)} 100`;
  fill.style.opacity = value > 0.01 ? "1" : "0";
  gauge.querySelector(".g-needle-wrap").setAttribute("opacity", finite(ratio) ? "1" : "0");
  // Needle: SVG-native rotation about the hub, eased by hand so it sweeps smoothly.
  const needle = gauge.querySelector(".g-needle");
  const target = -90 + (value / 3) * 180;
  const from = Number(needle.dataset.angle ?? -90);
  needle.dataset.angle = target;
  const start = performance.now();
  const sweep = (now) => {
    if (Number(needle.dataset.angle) !== target) return;
    const t = Math.min(1, (now - start) / 900);
    const angle = from + (target - from) * (1 - (1 - t) ** 3);
    needle.setAttribute("transform", `rotate(${angle.toFixed(2)} 120 120)`);
    if (t < 1) requestAnimationFrame(sweep);
  };
  requestAnimationFrame(sweep);
  tween($("gauge-value"), ratio, (v) => times(v));
  $("gauge-value").className = level === "strong" ? "up" : "";
}

function setKpi(id, value, unit, className = "", formatter = null) {
  $(id).className = `kpi-value ${className}`;
  if (formatter) {
    tween($(id), value, (v) => `${formatter(v)}${unit ? `<small>${unit}</small>` : ""}`, { bump: true });
    return;
  }
  $(id).innerHTML = `${value}${unit ? `<small>${unit}</small>` : ""}`;
}

function renderKpis(view) {
  const { summary, skew } = view;
  setKpi("kpi-amount", summary.rows.length ? summary.amount : NaN, "亿", "", (v) => yi(v, 2));
  $("kpi-amount-note").textContent = summary.time
    ? `截至 ${summary.clock} · 已达全天日均 ${times(summary.dayRatio)}${summary.complete ? "" : ` · ${summary.rows.length} 只可用`}`
    : "等待行情";
  setKpi("kpi-ratio", summary.ratio, "×", levelOf(summary.ratio) === "strong" ? "up" : "", (v) => (finite(v) ? v.toFixed(2) : "—"));
  $("progress-hist").style.width = `${Math.min(1, summary.progress || 0) * 100}%`;
  $("progress-today").style.width = `${Math.min(1, summary.dayRatio || 0) * 100}%`;
  $("kpi-ratio-note").textContent =
    summary.fullDay && summary.progress !== null
      ? `基准 ${yi(summary.baseline)} 亿 = ${summary.days} 日均额 ${yi(summary.fullDay)} 亿 × 同时点进度 ${(summary.progress * 100).toFixed(1)}%`
      : "基准 = 20 日均额 × 同时点进度";
  setKpi("kpi-flow", summary.flow ?? NaN, "亿", tone(summary.flow), (v) => signedYi(v));
  $("kpi-flow-note").textContent =
    skew !== null ? `占成交 ${pct(skew * 100, 1)} · 外盘 − 内盘口径推算` : "外内盘数据不足";
  setKpi("kpi-change", summary.change ?? NaN, "%", tone(summary.change), (v) => (finite(v) ? pct(v).replace("%", "") : "—"));
  $("kpi-change-note").textContent = view.hs300
    ? `按成交额加权 · 沪深300 指数 ${pct(view.hs300.change)}`
    : "按成交额加权";
  setKpi("kpi-premium", summary.premium ?? NaN, "%", tone(summary.premium), (v) => (finite(v) ? pct(v, 3).replace("%", "") : "—"));
  const premiumRows = summary.rows.filter((row) => finite(row.premium));
  $("kpi-premium-note").textContent = premiumRows.length
    ? `现价相对 IOPV · 溢价 ${premiumRows.filter((row) => row.premium > 0).length} 只 / 折价 ${premiumRows.filter((row) => row.premium < 0).length} 只`
    : "现价相对 IOPV · 成交额加权";
}

function renderAlerts(view) {
  const { summary, market } = view;
  const alerts = [];
  if (state.quoteError) alerts.push(`${state.quoteError}，保留最近一次可用行情，将自动重试。`);
  if (market.session && !market.fresh) alerts.push("行情时间已落后超过 3 分钟，综合结论暂停。");
  if (summary.rows.length && !summary.complete) alerts.push(`行情覆盖 ${summary.rows.length}/${state.pool.length} 只，成交额为可用子集合计。`);
  const baselineMissing = summary.rows.filter((row) => !row.profile).length;
  if (summary.rows.length && baselineMissing) {
    if (!state.snapshotLoaded && !state.snapshotError) alerts.push("实时行情已显示，正在加载历史同时点基线…");
    else if (!state.snapshotLoaded) alerts.push(`云端历史快照加载失败（第 ${state.snapshotFails} 次，自动重试中），正在改从东方财富直接获取基线…`);
    else alerts.push(`${baselineMissing} 只 ETF 历史基线不足，放大倍数暂缓。`);
  }
  // Only warn when the chart is actually behind, not on a single throttled request.
  if (view.minuteMode === "snapshot") {
    alerts.push(`逐分钟请求暂未成功，历史曲线使用云端 5 分钟数据，截至 ${view.series.at(-1).clock}。最新行情截至 ${hms(summary.time) || "未取得"}；曲线末端更新不代表历史分钟数据已经补齐，将自动重试。`);
  } else if (state.lastMinute && !state.minuteLoading) {
    const stale = staleMinuteFunds(summary);
    if (stale.length && summary.rows.length)
      alerts.push(`${stale.length} 只 ETF 的分时暂未更新到最新，曲线使用已取得的分时记录，会自动重试；最新成交额仍来自实时报价。`);
  }
  if (state.snapshotError && state.snapshotLoaded) alerts.push("云端历史快照刷新失败，沿用已加载的基线，将自动重试。");
  $("connection-alert").hidden = !alerts.length;
  $("connection-alert").textContent = alerts.join(" ");
}

/* ---------------- Intraday chart ---------------- */
let chartState = null;

function renderChart() {
  const view = state.view;
  const container = $("intraday-chart");
  if (!view) return;
  $("intraday-resolution").textContent = view.coarse ? "INTRADAY · 5 分钟快照" : "INTRADAY · 逐分钟";
  const { series, used, summary, profiles, indexMinutes, hs300 } = view;
  if (!series.length) {
    const status = (name, label) => {
      const item = state.sourceStatus[name];
      if (!item) return `${label}：尚未请求`;
      if (item.ok && (!item.at || item.ok > item.at)) return `${label}：正常`;
      return `${label}：${item.error || "失败"}`;
    };
    const tried = state.lastMinute > 0;
    container.innerHTML = `<div class="chart-empty">${!summary.date ? "等待行情" : tried && !state.minuteLoading ? "逐分钟数据暂不可用" : "正在获取逐分钟数据…"}<small>${escape(status("tencent", "腾讯分时"))} · ${escape(status("eastmoney", "东方财富分时"))}</small><small>两路都失败时改用云端快照的 5 分钟线（${state.snapshotLoaded ? "快照中暂无今日数据" : "快照加载中"}）</small></div>`;
    chartState = null;
    $("intraday-foot").textContent = "逐分钟数据优先东方财富，腾讯分时备用。请求失败后暂用云端 5 分钟数据，并显示实际截止时间。";
    return;
  }
  const width = Math.max(300, Math.round(container.clientWidth || 800));
  const compact = width < 560;
  const m = { l: compact ? 38 : 50, r: compact ? 8 : 14, t: 20 };
  const hA = compact ? 78 : 96;
  const hB = compact ? 150 : 176;
  const hC = compact ? 64 : 80;
  const gap = 34;
  const yA = m.t;
  const yB = yA + hA + gap;
  const yC = yB + hB + gap;
  const height = yC + hC + 26;
  const iw = width - m.l - m.r;
  const x = (minute) => m.l + (minute / 240) * iw;
  const f = (n) => n.toFixed(1);

  // Baseline over the same funds, at every minute of the day. Today's lines are drawn even
  // while the history is still loading; the baseline joins once every fund has one.
  const baselineReady = used.every((symbol) => profiles[symbol]);
  const baselineAt = (minute) =>
    baselineReady ? used.reduce((sum, symbol) => sum + profileAt(profiles[symbol], minute, view.shape), 0) : 0;
  const baseline = Array.from({ length: 241 }, (_, minute) => baselineAt(minute));
  const last = series.at(-1);
  const tip = (() => {
    if (!(summary.minute > last.minute)) return null;
    const rows = summary.rows.filter((row) => used.includes(row.symbol));
    if (rows.length !== used.length) return null;
    return { minute: summary.minute, cumulative: rows.reduce((sum, row) => sum + row.amount, 0) };
  })();

  // Panel A: 沪深300 index, % vs previous close
  const indexPoints = hs300?.prev
    ? indexMinutes.map((record) => ({ minute: record.minute, value: (record.price / hs300.prev - 1) * 100 }))
    : [];
  let lo = Math.min(0, ...indexPoints.map((p) => p.value));
  let hi = Math.max(0, ...indexPoints.map((p) => p.value));
  if (hi - lo < 0.6) {
    const mid = (hi + lo) / 2;
    lo = mid - 0.3;
    hi = mid + 0.3;
  }
  const padA = (hi - lo) * 0.12;
  lo -= padA;
  hi += padA;
  const yIdx = (value) => yA + ((hi - value) / (hi - lo)) * hA;

  // Panel B: cumulative turnover (亿元)
  const maxB = Math.max(baseline[240], tip?.cumulative || 0, last.cumulative) * 1.06;
  const yCum = (value) => yB + hB - (value / maxB) * hB;

  // Panel C: per-minute turnover; auction minutes are clipped.
  const regular = series.filter((p, i) => i > 0 && p.clock !== "13:00" && p.minute <= 237);
  const maxC = Math.max(1, ...regular.map((p) => Math.max(p.amount, p.expected || 0))) * 1.12;
  const yMin = (value) => yC + hC - (Math.min(value, maxC) / maxC) * hC;

  let svg = `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="盘中逐分钟走势">
    <defs><linearGradient id="today-area" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#0a66d6" stop-opacity=".2"/><stop offset="1" stop-color="#0a66d6" stop-opacity="0"/></linearGradient></defs>`;
  // Grid + panel labels
  const panel = (y, h, label) =>
    `<text class="panel-label" x="${m.l}" y="${y - 8}">${label}</text>` +
    [0, 0.5, 1].map((t) => `<line class="grid" x1="${m.l}" x2="${width - m.r}" y1="${f(y + h * t)}" y2="${f(y + h * t)}"/>`).join("");
  svg += panel(yA, hA, "沪深300 指数 · 较昨收");
  svg += panel(yB, hB, "全池累计成交额 · 亿元");
  svg += panel(yC, hC, view.coarse ? "每 5 分钟成交额 · 亿元" : "每分钟成交额 · 亿元");
  // Axis labels
  const axis = (y, text) => `<text class="axis" x="${m.l - 6}" y="${f(y + 3.5)}" text-anchor="end">${text}</text>`;
  svg += axis(yA, pct(hi, 1)) + axis(yA + hA, pct(lo, 1));
  if (lo < 0 && hi > 0) svg += `<line class="zero" x1="${m.l}" x2="${width - m.r}" y1="${f(yIdx(0))}" y2="${f(yIdx(0))}"/>` + axis(yIdx(0), "0");
  svg += axis(yB, (maxB / 1e8).toFixed(0)) + axis(yB + hB / 2, (maxB / 2e8).toFixed(0)) + axis(yB + hB, "0");
  svg += axis(yC, (maxC / 1e8).toFixed(maxC >= 1e9 ? 0 : 1)) + axis(yC + hC, "0");
  // Lunch divider
  svg += `<line class="lunch" x1="${f(x(120))}" x2="${f(x(120))}" y1="${yA}" y2="${yC + hC}"/>`;
  // Time axis
  [[0, "09:30"], [60, "10:30"], [120, compact ? "11:30" : "11:30 / 13:00"], [180, "14:00"], [240, "15:00"]].forEach(([minute, text]) => {
    svg += `<text class="axis" x="${f(x(minute))}" y="${height - 6}" text-anchor="${minute === 0 ? "start" : minute === 240 ? "end" : "middle"}">${text}</text>`;
  });

  // A: index line
  if (indexPoints.length > 1) {
    const d = indexPoints.map((p, i) => `${i ? "L" : "M"}${f(x(p.minute))} ${f(yIdx(p.value))}`).join("");
    svg += `<path d="${d}" fill="none" stroke="var(--index)" stroke-width="1.6" stroke-linejoin="round"/>`;
    const end = indexPoints.at(-1);
    svg += `<circle cx="${f(x(end.minute))}" cy="${f(yIdx(end.value))}" r="3" fill="var(--index)"/>`;
  } else {
    svg += `<text class="axis" x="${f(m.l + iw / 2)}" y="${f(yA + hA / 2)}" text-anchor="middle">指数分时暂缺</text>`;
  }

  // B: baseline (full day, dashed) and today's cumulative turnover
  if (baselineReady) {
    const baseD = baseline.map((value, minute) => `${minute ? "L" : "M"}${f(x(minute))} ${f(yCum(value))}`).join("");
    svg += `<path d="${baseD}" fill="none" stroke="var(--base)" stroke-width="1.5" stroke-dasharray="5 5"/>`;
  } else {
    svg += `<text class="axis" x="${f(width - m.r)}" y="${f(yB + 12)}" text-anchor="end">同时点均值加载中…</text>`;
  }
  const todayPoints = series.map((p) => [p.minute, p.cumulative]);
  if (tip) todayPoints.push([tip.minute, tip.cumulative]);
  const todayD = todayPoints.map(([minute, value], i) => `${i ? "L" : "M"}${f(x(minute))} ${f(yCum(value))}`).join("");
  const endMinute = todayPoints.at(-1)[0];
  svg += `<path d="${todayD}L${f(x(endMinute))} ${yB + hB}L${f(x(todayPoints[0][0]))} ${yB + hB}Z" fill="url(#today-area)"/>`;
  svg += `<path d="${todayD}" fill="none" stroke="var(--today)" stroke-width="2.4" stroke-linejoin="round"/>`;
  const [endM, endV] = todayPoints.at(-1);
  const endRatio = baselineAt(endM) ? endV / baselineAt(endM) : null;
  svg += `<circle cx="${f(x(endM))}" cy="${f(yCum(endV))}" r="4.5" fill="var(--today)" stroke="#fff" stroke-width="2"/>`;
  if (finite(endRatio) && endM >= LIVE_MIN_MINUTE) {
    const labelX = Math.min(x(endM) + 8, width - m.r - 4);
    const anchor = x(endM) + 70 > width - m.r ? "end" : "start";
    svg += `<text x="${f(anchor === "end" ? x(endM) - 8 : labelX)}" y="${f(yCum(endV) - 9)}" text-anchor="${anchor}" font-size="12" font-weight="600" fill="var(--today)">${times(endRatio)}</text>`;
  }

  // C: per-minute bars + expected line
  const barW = Math.max(1, (iw / 240) * (view.coarse ? 3.6 : 0.72));
  series.forEach((p) => {
    const color = p.pulse ? (p.move >= 0 ? "var(--up)" : "var(--down)") : "#c9d3df";
    const top = yMin(p.amount);
    svg += `<rect x="${f(x(p.minute) - barW / 2)}" y="${f(top)}" width="${f(barW)}" height="${f(yC + hC - top)}" fill="${color}"${p.strong ? "" : p.pulse ? ' opacity=".85"' : ""}/>`;
    if (p.amount > maxC) svg += `<rect x="${f(x(p.minute) - barW / 2)}" y="${yC - 3}" width="${f(barW)}" height="2" fill="var(--fg-3)"/>`;
  });
  const expD = series
    .filter((p) => p.expected !== null)
    .map((p, i) => `${i ? "L" : "M"}${f(x(p.minute))} ${f(yMin(p.expected))}`)
    .join("");
  if (expD) svg += `<path d="${expD}" fill="none" stroke="var(--base)" stroke-width="1.2" stroke-dasharray="3 3"/>`;
  // Pulse markers on the index panel
  series
    .filter((p) => p.pulse && p.move > 0 && p.index !== null)
    .forEach((p) => {
      svg += `<circle cx="${f(x(p.minute))}" cy="${f(yIdx(p.index))}" r="${p.strong ? 4.5 : 3.2}" fill="var(--up)" stroke="#fff" stroke-width="1.5"/>`;
    });

  svg += `<line class="cursor" id="chart-cursor" x1="0" x2="0" y1="${yA}" y2="${yC + hC}" visibility="hidden"/>
    <circle id="chart-dot" r="4" fill="var(--today)" stroke="#fff" stroke-width="2" visibility="hidden"/>
    <rect x="${m.l}" y="${yA}" width="${iw}" height="${yC + hC - yA}" fill="transparent" id="chart-hit"/></svg>`;
  container.innerHTML = svg;
  chartState = { series, coarse: view.coarse, x, yCum, baselineAt, m, iw, width };

  const hit = container.querySelector("#chart-hit");
  hit.addEventListener("pointermove", onChartMove);
  hit.addEventListener("pointerleave", () => {
    state.hover = null;
    hideTooltip();
  });
  hit.addEventListener("pointerdown", onChartMove);
  // The chart redraws as data arrives; keep the crosshair where the pointer is.
  if (state.hover) onChartMove({ ...state.hover, currentTarget: hit });

  const pulses = series.filter((p) => p.pulse).length;
  const sources = view.coarse
    ? "云端快照（5 分钟）"
    : [...new Set(used.map((symbol) => state.minutes[symbol]?.source).filter(Boolean))].join(" / ");
  const pulseNote = view.coarse ? "分钟脉冲暂缓判定" : `全池放量脉冲 ${pulses} 次（≥ 同时段均值 3× 且 ≥ 1 亿）`;
  const pendingNote = view.coarse && view.minuteMode === "loading" ? " · 正在读取逐分钟数据" : "";
  $("intraday-foot").textContent =
    `${summary.date} · 分时源 ${sources || "—"}${view.shape ? ` · 分钟形状 ${view.shape.days} 组样本` : " · 线性插值"} · ${view.coarse ? "5 分钟数据" : "逐分钟数据"}截至 ${last.clock} · 最新行情 ${hms(summary.time) || "未取得"}${pendingNote} · 分时覆盖 ${used.length}/${state.pool.length} 只 · ${pulseNote} · 灰色虚线为同时点均值`;
}

function onChartMove(event) {
  if (!chartState) return;
  const { series, x, yCum, baselineAt, m, iw } = chartState;
  state.hover = { clientX: event.clientX, clientY: event.clientY };
  const svg = event.currentTarget.ownerSVGElement;
  const rect = svg.getBoundingClientRect();
  const scale = rect.width / chartState.width;
  const px = (event.clientX - rect.left) / scale;
  const minute = Math.max(0, Math.min(240, ((px - m.l) / iw) * 240));
  let best = series[0];
  for (const point of series) if (Math.abs(point.minute - minute) <= Math.abs(best.minute - minute)) best = point;
  const cursor = svg.querySelector("#chart-cursor");
  const dot = svg.querySelector("#chart-dot");
  cursor.setAttribute("x1", x(best.minute));
  cursor.setAttribute("x2", x(best.minute));
  cursor.setAttribute("visibility", "visible");
  dot.setAttribute("cx", x(best.minute));
  dot.setAttribute("cy", yCum(best.cumulative));
  dot.setAttribute("visibility", "visible");
  const base = baselineAt(best.minute);
  const rows = [
    ["沪深300", best.index !== null ? `<span class="${tone(best.index)}">${pct(best.index)}</span>` : "—"],
    ["今日累计", `${yi(best.cumulative)} 亿`],
    ["同时点均值", base ? `${yi(base)} 亿` : "加载中"],
    ["放大倍数", best.minute >= LIVE_MIN_MINUTE && base ? times(best.cumulative / base) : "—"],
    [chartState.coarse ? "本 5 分钟成交" : "本分钟成交", `${yi(best.amount)} 亿${finite(best.multiple) ? ` · ${times(best.multiple)}` : ""}`],
    [chartState.coarse ? "5 分钟涨跌" : "分钟涨跌", `<span class="${tone(best.move)}">${pct(best.move * 100, 3)}</span>`],
  ];
  showTooltip(
    `<b>${best.clock}${best.pulse ? (best.move >= 0 ? " · 放量拉升" : " · 放量下挫") : ""}</b>${rows.map(([k, v]) => `<div class="row"><span>${k}</span><span>${v}</span></div>`).join("")}`,
    event.clientX,
    event.clientY,
  );
}

function showTooltip(html, clientX, clientY) {
  const tip = $("tooltip");
  tip.innerHTML = html;
  tip.hidden = false;
  const w = tip.offsetWidth;
  const h = tip.offsetHeight;
  let left = clientX + 16;
  if (left + w > window.innerWidth - 8) left = clientX - w - 16;
  let top = clientY - h / 2;
  top = Math.max(8, Math.min(window.innerHeight - h - 8, top));
  tip.style.left = `${Math.max(8, left)}px`;
  tip.style.top = `${top}px`;
}
function hideTooltip() {
  $("tooltip").hidden = true;
  const svg = $("intraday-chart").querySelector("svg");
  svg?.querySelector("#chart-cursor")?.setAttribute("visibility", "hidden");
  svg?.querySelector("#chart-dot")?.setAttribute("visibility", "hidden");
}

/* ---------------- Feed ---------------- */
function renderFeed(view) {
  const events = view.events.slice(0, 40);
  $("feed-count").textContent = view.coarse ? "—" : view.events.length;
  $("feed-count").className = `feed-count ${view.events.some((e) => e.move > 0) ? "hot" : ""}`;
  if (!events.length) {
    $("feed").innerHTML = `<li class="feed-empty">${view.coarse ? "逐分钟数据暂未齐备，分钟异动检测暂缓。" : view.series.length ? "今日暂无单只 ETF 分钟级放量异动。" : "等待分时数据…"}</li>`;
    return;
  }
  $("feed").innerHTML = events
    .map((event) => {
      const key = `${view.summary.date}|${event.symbol}|${event.clock}`;
      const fresh = !state.firstFeed && !state.seen.has(key);
      state.seen.add(key);
      return `<li class="${fresh ? "fresh" : ""}"><time>${event.clock}</time><span class="feed-name"><i class="bar" style="background:${event.move >= 0 ? "var(--up)" : "var(--down)"}"></i>${escape(event.name)}</span><span class="feed-meta">1 分钟 ${yi(event.amount)} 亿 · 同时段 ${times(event.multiple)} · <span class="${tone(event.move)}">${pct(event.move * 100, 2)}</span></span></li>`;
    })
    .join("");
  if (view.series.length) state.firstFeed = false;
}

/* ---------------- Groups ---------------- */
function ratioTrack(ratio) {
  const level = levelOf(ratio);
  const width = finite(ratio) ? Math.min(ratio / 3, 1) * 100 : 0;
  return `<div class="ratio-track" aria-hidden="true"><span class="fill ${level}" style="width:${width}%"></span><span class="mark" style="left:${(1.3 / 3) * 100}%"></span><span class="mark" style="left:${(1.8 / 3) * 100}%"></span></div>`;
}

function renderGroups(view) {
  $("group-cards").innerHTML = view.groups
    .map(
      (g) => `<button class="group-card ${state.group === g.group ? "selected" : ""}" data-group="${escape(g.group)}" aria-pressed="${state.group === g.group}">
        <div class="group-top"><strong>${escape(g.group)}</strong><span>${g.count} 只 · ${yi(g.amount)} 亿</span></div>
        <div class="group-mid"><span class="group-ratio ${levelOf(g.ratio) === "strong" ? "up" : ""}">${finite(g.ratio) ? g.ratio.toFixed(2) : "—"}<small>×</small></span>
        <span class="group-index">${g.index ? `指数 <b class="${tone(g.index.change)}">${pct(g.index.change)}</b>` : `ETF <b class="${tone(g.change)}">${pct(g.change)}</b>`}</span></div>
        ${ratioTrack(g.ratio)}
        <div class="group-bottom"><span>主动净买入 <b class="${tone(g.flow)}">${signedYi(g.flow)}</b> 亿</span><span>ETF <b class="${tone(g.change)}">${pct(g.change)}</b></span></div>
      </button>`,
    )
    .join("");
  $("filters").innerHTML = ["全部", ...view.groups.map((g) => g.group)]
    .map((group) => `<button data-group="${escape(group)}" class="${state.group === group ? "active" : ""}" aria-pressed="${state.group === group}">${escape(group)}</button>`)
    .join("");
}

/* ---------------- Table ---------------- */
function sparkline(symbol, prevClose) {
  const item = state.minutes[symbol];
  if (!item || item.date !== state.summary?.date || item.records.length < 2 || !prevClose) return '<span class="muted">—</span>';
  const prices = item.records.map((r) => r.price);
  const values = [prevClose, ...prices];
  const min = Math.min(...values);
  const span = Math.max(...values) - min || 1;
  const xOf = (minute) => (minute / 240) * 84;
  const yOf = (price) => 24 - ((price - min) / span) * 22;
  const d = item.records.map((r, i) => `${i ? "L" : "M"}${xOf(r.minute).toFixed(1)} ${yOf(r.price).toFixed(1)}`).join("");
  const color = prices.at(-1) >= prevClose ? "var(--up)" : "var(--down)";
  return `<svg class="spark" viewBox="0 0 84 26" aria-hidden="true"><line x1="0" x2="84" y1="${yOf(prevClose).toFixed(1)}" y2="${yOf(prevClose).toFixed(1)}" stroke="#c9d3df" stroke-dasharray="2 2"/><path d="${d}" fill="none" stroke="${color}" stroke-width="1.3"/></svg>`;
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
    .map((fund) => ({ ...fund, ...(summary.rows.find((row) => row.symbol === fund.symbol) || {}) }))
    .sort((left, right) => {
      const a = left[state.sort];
      const b = right[state.sort];
      if (!finite(a)) return finite(b) ? 1 : 0;
      if (!finite(b)) return -1;
      return (a - b) * state.direction;
    });
  const maxFlow = Math.max(1, ...summary.rows.map((row) => Math.abs(row.flow || 0)));
  $("fund-rows").innerHTML = rows.length
    ? rows
        .map((row) => {
          const flowWidth = finite(row.flow) ? (Math.abs(row.flow) / maxFlow) * 50 : 0;
          const flowBar = finite(row.flow)
            ? `<span class="flow-bar"><i style="${row.flow >= 0 ? "left:50%" : `left:${50 - flowWidth}%`};width:${flowWidth}%;background:${row.flow >= 0 ? "var(--up)" : "var(--down)"}"></i></span>`
            : "";
          return `<tr>
            <td><a class="fund-name" href="https://gu.qq.com/${row.symbol}" target="_blank" rel="noopener noreferrer">${escape(row.name)}</a><span class="fund-sub">${row.code} · ${row.symbol.startsWith("sh") ? "SH" : "SZ"} · ${escape(row.holder || "")}</span></td>
            <td><span class="index-tag">${escape(row.group)}</span></td>
            <td class="num">${finite(row.price) ? row.price.toFixed(3) : "—"}</td>
            <td class="num ${tone(row.change)}">${pct(row.change)}</td>
            <td class="num">${finite(row.amount) ? `${yi(row.amount)} 亿` : "—"}</td>
            <td class="num"><span class="ratio-pill ${levelOf(row.liveRatio)}">${times(row.liveRatio)}</span></td>
            <td class="num"><span class="flow-cell"><span class="${tone(row.flow)}">${finite(row.flow) ? `${signedYi(row.flow)} 亿` : "—"}</span>${flowBar}</span></td>
            <td class="num ${tone(row.premium)}">${finite(row.premium) ? pct(row.premium) : "—"}</td>
            <td>${sparkline(row.symbol, row.prevClose)}</td>
          </tr>`;
        })
        .join("")
    : '<tr><td colspan="9" class="empty">没有找到匹配的 ETF，试试其他名称或代码。</td></tr>';
  $("row-count").textContent = `显示 ${rows.length} / ${state.pool.length} 只 · 行情 ${hms(summary.time) || "—"}`;
  const labels = { price: "最新价", change: "涨跌幅", amount: "成交额", liveRatio: "放大倍数", flow: "主动净买入", premium: "溢价率" };
  $("table-summary").textContent = `汇金 2025 年报持有的 ${state.pool.length} 只宽基 ETF · 按${labels[state.sort]}${state.direction === -1 ? "降序" : "升序"}`;
  document.querySelectorAll("[data-sort]").forEach((button) => {
    const selected = button.dataset.sort === state.sort;
    button.querySelector("span").textContent = selected ? (state.direction === -1 ? "↓" : "↑") : "↕";
    button.closest("th").setAttribute("aria-sort", selected ? (state.direction === -1 ? "descending" : "ascending") : "none");
  });
}

function renderHealth(view) {
  const ok = state.source === "live" && !state.quoteError;
  $("health-dot").className = `health-dot ${ok ? "ok" : "warn"}`;
  $("source-state").textContent = `${ok ? "行情直连 · 腾讯财经" : "云端快照行情（直连失败时兜底）"} · 分时 ${view.used.length}/${state.pool.length} 只${state.minuteErrors ? `（本轮 ${state.minuteErrors} 只重试后仍未取到，沿用上一分钟）` : ""}`;
  const range = view.summary.profileRange;
  $("snapshot-time").textContent =
    (state.snapshotAt
      ? `历史快照 ${chinaNow(new Date(state.snapshotAt))}（北京时间）`
      : state.baselineSource
        ? "云端快照未加载"
        : "云端快照加载中") +
    (state.baselineSource ? ` · 基线来源 ${state.baselineSource}` : "") +
    (range ? ` · 基线 ${range.from} — ${range.to}` : "");
}

/* ---------------- Interaction ---------------- */
function selectGroup(group, scroll) {
  state.group = state.group === group && scroll ? "全部" : group;
  renderGroups(state.view);
  renderTable();
  if (scroll) $("funds").scrollIntoView({ behavior: "smooth", block: "start" });
}

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
    state.direction = state.sort === button.dataset.sort ? -state.direction : -1;
    state.sort = button.dataset.sort;
    renderTable();
  }),
);
// Coming back to the tab (or back online) always pulls a fresh quote, even when paused,
// so the page never shows numbers older than the last trade.
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    refreshQuotes();
    refreshMinutes();
  }
});
window.addEventListener("online", () => {
  refreshQuotes();
  refreshMinutes(true);
});
window.addEventListener(
  "scroll",
  () => {
    state.hover = null;
    hideTooltip();
  },
  { passive: true },
);

let resizeTimer = 0;
new ResizeObserver(() => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(renderChart, 120);
}).observe($("intraday-chart"));

// Nav: scroll progress + active section
const sections = ["overview", "intraday", "groups", "funds", "methodology"];
window.addEventListener(
  "scroll",
  () => {
    const max = document.documentElement.scrollHeight - innerHeight;
    $("nav-progress").style.setProperty("--sp", max > 0 ? (scrollY / max).toFixed(4) : 0);
    let current = sections[0];
    for (const id of sections) if ($(id).getBoundingClientRect().top < 140) current = id;
    document.querySelectorAll(".nav-links a[href^='#']").forEach((a) => a.classList.toggle("active", a.getAttribute("href") === `#${current}`));
  },
  { passive: true },
);

// Scheduler: a quarter-second clock decides what is due. Quotes every second while trading,
// a few settling snapshots after 11:30 / 15:00, nothing during lunch, after the close or on
// non-trading days; it resumes by itself at 09:15 and 13:00.
let lastStatus = 0;
setInterval(() => {
  if (!state.pool.length) return;
  if (Date.now() - lastStatus >= 1000) {
    lastStatus = Date.now();
    renderStatus();
  }
  if (document.hidden) return;
  const phase = currentPhase();
  if (phase.poll && !state.loading && Date.now() - state.lastQuote >= phase.poll) {
    const dot = document.querySelector("#live-pill .dot");
    dot?.classList.remove("tick");
    void dot?.offsetWidth;
    dot?.classList.add("tick");
    refreshQuotes();
  }
  refreshMinutes();
  if (state.shape?.builtFor !== chinaNow().slice(0, 10) && Date.now() - (state.lastShape || 0) > SNAPSHOT_MS) {
    state.lastShape = Date.now();
    refreshShape().then(render);
  }
  const snapshotDue = state.snapshotLoaded
    ? Date.now() - state.lastSnapshot > SNAPSHOT_MS
    : state.snapshotFails > 0 && Date.now() >= (state.nextSnapshotTry || 0);
  if (snapshotDue && !state.snapshotLoading) syncSnapshot().then(render);
}, 250);

// First paint comes from the live quote (a few KB); the 1 MB history snapshot and the minute
// shape load in parallel and refine the numbers as soon as they arrive.
async function init() {
  try {
    state.pool = JSON.parse(await fetchText("./pool.json", 12_000, "default"));
  } catch {
    $("conclusion-headline").textContent = "数据暂不可用";
    $("conclusion-summary").textContent = "页面配置加载失败，请检查网络后刷新。";
    $("market-badge").textContent = "连接失败";
    return;
  }
  state.lastShape = Date.now();
  const history = syncSnapshot().then(render);
  refreshShape().then(render);
  await refreshQuotes();
  await history;
  refreshMinutes(true);
}

init();
