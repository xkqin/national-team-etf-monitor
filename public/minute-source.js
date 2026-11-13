import { parseMinuteLines, parseTrendLines } from "./core.js?v=20261113b";

// Tencent's five-day response also contains today's genuine one-minute records.
// The old /minute/query route intermittently returns 501 without CORS headers.
export function parseTencentDays(payload, symbol) {
  const days = new Map();
  for (const day of payload.data?.[symbol]?.data || []) {
    if (!/^\d{8}$/.test(day.date) || !Array.isArray(day.data)) continue;
    const date = `${day.date.slice(0, 4)}-${day.date.slice(4, 6)}-${day.date.slice(6, 8)}`;
    const records = parseMinuteLines(day.data);
    if (records.length) days.set(date, records);
  }
  if (!days.size) throw new Error("分时数据为空");
  return days;
}

export async function tencentDays(fetchText, symbol, now = Date.now()) {
  return parseTencentDays(JSON.parse(await fetchText(
    `https://web.ifzq.gtimg.cn/appstock/app/day/query?code=${symbol}&_=${now}`, 8_000,
  )), symbol);
}

export async function trendDays(fetchText, symbol, days, now = Date.now()) {
  const secid = `${symbol.startsWith("sh") ? "1" : "0"}.${symbol.slice(2)}`;
  const payload = JSON.parse(await fetchText(
    `https://push2his.eastmoney.com/api/qt/stock/trends2/get?secid=${secid}&fields1=f1&fields2=f51,f52,f53,f56,f57&ndays=${days}&iscr=0&_=${now}`, 10_000,
  ));
  const parsed = parseTrendLines(payload.data?.trends);
  if (!parsed.size) throw new Error("分时数据为空");
  return parsed;
}

// A source outage rests only until the next normal minute round, not five minutes.
// A later success also clears a cooldown set by concurrently failing requests.
export function createMinuteFetcher({ fetchText, now = Date.now, status = {}, down = {}, failures = {} }) {
  return async function fetchMinute(symbol, expectedDate) {
    let lastError = new Error("分钟行情源等待下一分钟自动重试");
    for (const name of ["eastmoney", "tencent"]) {
      if (down[name] > now()) continue;
      try {
        const days = await (name === "tencent" ? tencentDays(fetchText, symbol, now()) : trendDays(fetchText, symbol, 1, now()));
        const date = expectedDate || [...days.keys()].sort().at(-1);
        const records = days.get(date);
        if (!records?.length) throw new Error("分钟日期与最新行情不一致");
        failures[name] = 0;
        down[name] = 0;
        status[name] = { ok: now(), error: "" };
        return { date, records, source: name === "tencent" ? "腾讯" : "东方财富" };
      } catch (error) {
        lastError = error;
        if (error.name === "TypeError" || error.name === "TimeoutError" || /^HTTP (429|5\d\d)$/.test(error.message)) {
          failures[name] = (failures[name] || 0) + 1;
          if (failures[name] >= 3) down[name] = now() + 60_000;
        }
        const reason = error.name === "TimeoutError" ? "请求超时"
          : error.name === "TypeError" ? "连接失败或跨域请求被拦截" : error.message || "失败";
        status[name] = { ok: status[name]?.ok || 0, error: reason, at: now() };
      }
    }
    throw lastError;
  };
}
