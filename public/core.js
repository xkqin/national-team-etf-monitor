export const REFRESH_MS = 20_000;
export const STALE_MS = 180_000;

export function chinaNow(date = new Date()) {
  return new Date(date.getTime() + 8 * 3600_000)
    .toISOString()
    .slice(0, 19)
    .replace("T", " ");
}

export function quoteDate(time) {
  return `${time.slice(0, 4)}-${time.slice(4, 6)}-${time.slice(6, 8)}`;
}

export function quoteEpoch(time) {
  if (!/^\d{14}$/.test(time || "")) return NaN;
  return Date.parse(
    `${quoteDate(time)}T${time.slice(8, 10)}:${time.slice(10, 12)}:${time.slice(12, 14)}+08:00`,
  );
}

export function parseQuotes(text) {
  return Object.fromEntries(
    [...text.matchAll(/v_(\w+)="([^"]*)"/g)].map((match) => [
      match[1],
      match[2].split("~"),
    ]),
  );
}

export function normalizeQuote(fields, fund) {
  if (!fields || fields.length < 38 || !/^\d{14}$/.test(fields[30]))
    return null;
  const price = Number(fields[3]);
  const amount = Number(fields[37]) * 10_000;
  const outer = Number(fields[7]);
  const inner = Number(fields[8]);
  const change = Number(fields[32]);
  if (
    !Number.isFinite(price) ||
    price <= 0 ||
    !Number.isFinite(amount) ||
    amount < 0 ||
    !Number.isFinite(change)
  )
    return null;
  const total = outer + inner;
  const imbalance =
    Number.isFinite(total) && outer >= 0 && inner >= 0 && total > 0
      ? (outer - inner) / total
      : null;
  return {
    ...fund,
    price,
    amount,
    change,
    time: fields[30],
    date: quoteDate(fields[30]),
    imbalance,
    flow: imbalance === null ? null : amount * imbalance,
  };
}

// Five-minute bars are stamped at interval end. Compare only completed intervals.
export function cutoffFor(time) {
  const hour = Number(time.slice(8, 10));
  const minute = Number(time.slice(10, 12));
  const total = hour * 60 + minute;
  if (total < 576) return null;
  const clamped =
    total >= 900 ? 900 : total >= 690 && total <= 780 ? 690 : total - 1;
  return `${String(Math.floor(clamped / 60)).padStart(2, "0")}:${String(Math.floor((clamped % 60) / 5) * 5).padStart(2, "0")}`;
}

export function completeDays(bars, beforeDate) {
  const groups = new Map();
  for (const [time, amount] of bars || []) {
    const date = time.slice(0, 10);
    if (date >= beforeDate || !Number.isFinite(amount) || amount < 0) continue;
    if (!groups.has(date)) groups.set(date, new Map());
    groups.get(date).set(time.slice(11, 16), amount);
  }
  return [...groups]
    .filter(
      ([, items]) =>
        items.size >= 48 && items.has("09:35") && items.has("15:00"),
    )
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-20);
}

export function volumeComparison(
  quote,
  history,
  cutoff = cutoffFor(quote.time),
) {
  const days = completeDays(history?.fiveMinute, quote.date);
  if (!cutoff || days.length < 5) return null;
  const today = (history?.fiveMinute || []).filter(
    ([time]) =>
      time.slice(0, 10) === quote.date && time.slice(11, 16) <= cutoff,
  );
  const currentBars = new Map(
    today.map(([time, amount]) => [time.slice(11, 16), amount]),
  );
  if (!currentBars.has("09:35") || !currentBars.has(cutoff)) return null;
  const sumTo = (items) =>
    [...items]
      .filter(([time]) => time <= cutoff)
      .reduce((sum, [, amount]) => sum + amount, 0);
  const baseline =
    days.reduce((sum, [, items]) => sum + sumTo(items), 0) / days.length;
  if (!baseline) return null;
  return {
    current: sumTo(currentBars),
    baseline,
    ratio: sumTo(currentBars) / baseline,
    days: days.length,
    cutoff,
  };
}

export function marketState(time, now = new Date()) {
  if (!time) return { label: "等待行情", fresh: false, session: false };
  const local = chinaNow(now);
  const minute = Number(local.slice(11, 13)) * 60 + Number(local.slice(14, 16));
  const weekday = new Date(`${local.slice(0, 10)}T12:00:00Z`).getUTCDay();
  const sameDate = quoteDate(time) === local.slice(0, 10);
  const workday = weekday > 0 && weekday < 6;
  const session =
    workday &&
    ((minute >= 570 && minute <= 690) || (minute >= 780 && minute <= 900));
  const age = now.getTime() - quoteEpoch(time);
  if (session && (!sameDate || age > STALE_MS || age < -60_000))
    return { label: "行情已延迟", fresh: false, session: true };
  if (session) return { label: "交易中", fresh: true, session: true };
  if (workday && sameDate && minute > 690 && minute < 780)
    return { label: "午间休市", fresh: true, session: false };
  return {
    label: sameDate && minute >= 900 ? "已收盘" : "休市 / 最近交易日",
    fresh: false,
    session: false,
  };
}

export function aggregate(funds, quotes, history) {
  const rows = funds
    .map((fund) => normalizeQuote(quotes[fund.symbol], fund))
    .filter(Boolean);
  const dates = rows.map((row) => row.date).sort();
  const date = dates.at(-1);
  const current = rows.filter((row) => row.date === date);
  const times = current.map((row) => row.time).sort();
  const amount = current.reduce((sum, row) => sum + row.amount, 0);
  const flowRows = current.filter((row) => row.flow !== null);
  const complete = current.length === funds.length;
  const coherent =
    complete && quoteEpoch(times.at(-1)) - quoteEpoch(times[0]) <= STALE_MS;
  const expectedCutoff = times[0] && cutoffFor(times[0]);
  const available = current.map(
    (row) =>
      new Set(
        (history[row.symbol]?.fiveMinute || [])
          .filter(
            ([time]) =>
              time.slice(0, 10) === date &&
              time.slice(11, 16) <= expectedCutoff,
          )
          .map(([time]) => time.slice(11, 16)),
      ),
  );
  const commonCutoff = available.length
    ? [...available[0]]
        .filter((time) => available.every((items) => items.has(time)))
        .sort()
        .at(-1)
    : null;
  const comparisons = current.map((row) =>
    commonCutoff
      ? volumeComparison(row, history[row.symbol], commonCutoff)
      : null,
  );
  const comparable =
    coherent &&
    comparisons.every(Boolean) &&
    new Set(comparisons.map((item) => item.cutoff)).size === 1;
  const baseline = comparable
    ? comparisons.reduce((sum, item) => sum + item.baseline, 0)
    : 0;
  const comparedAmount = comparable
    ? comparisons.reduce((sum, item) => sum + item.current, 0)
    : 0;
  return {
    rows: current,
    date,
    time: times[0],
    amount,
    complete,
    coherent,
    flow:
      flowRows.length === current.length && current.length
        ? flowRows.reduce((sum, row) => sum + row.flow, 0)
        : null,
    change: amount
      ? current.reduce((sum, row) => sum + row.change * row.amount, 0) / amount
      : null,
    ratio: baseline ? comparedAmount / baseline : null,
    baseline,
    comparedAmount,
    cutoff: comparable ? comparisons[0].cutoff : null,
    days: comparable ? Math.min(...comparisons.map((item) => item.days)) : 0,
  };
}

export function signalFor(summary, state) {
  if (!summary.complete || !summary.coherent)
    return {
      title: "数据尚未齐备",
      label: "等待完整数据",
      level: "neutral",
      detail: "部分 ETF 行情缺失或时间差超过 3 分钟，暂缓综合信号。",
    };
  if (state.session && !state.fresh)
    return {
      title: "行情延迟，等待更新",
      label: "数据延迟",
      level: "neutral",
      detail: "保留最近一次可用数据，恢复实时连接后重新判断。",
    };
  if (summary.ratio === null)
    return {
      title: "正在建立同刻基线",
      label: "积累数据中",
      level: "neutral",
      detail: "需完整历史五分钟数据与当日已完成区间，开盘前五分钟暂不计算。",
    };
  if (summary.flow === null)
    return {
      title: "买卖方向数据不足",
      label: "方向待确认",
      level: "neutral",
      detail: "外内盘数据不足，成交额与量能倍数仍可查看。",
    };
  const skew = summary.amount ? summary.flow / summary.amount : 0;
  if (summary.ratio >= 1.8 && skew >= 0.08)
    return {
      title: "显著放量，买盘偏强",
      label: "重点观察",
      level: "strong",
      detail: "成交额明显高于历史同刻，外盘占优。出现了值得关注的量价信号。",
    };
  if (summary.ratio >= 1.3 && skew > 0)
    return {
      title: "成交放量，留意买盘",
      label: "放量观察",
      level: "watch",
      detail: "宽基 ETF 交投活跃度上升，外内盘差偏正，可持续观察。",
    };
  if (summary.ratio >= 1.3)
    return {
      title: "成交放量，卖盘偏强",
      label: "放量观察",
      level: "watch",
      detail: "交投活跃度上升，外内盘差偏负，方向信号仍需观察。",
    };
  return {
    title: "暂未出现显著放量信号",
    label: "常态观察",
    level: "calm",
    detail: "成交额未达到设定的放量阈值，继续跟踪量能与买卖方向。",
  };
}
