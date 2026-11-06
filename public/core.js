export const REFRESH_MS = 1_000;
export const STALE_MS = 180_000;
export const BAR_TIMES = Array.from({ length: 48 }, (_, index) => {
  const minutes = index < 24 ? 575 + index * 5 : 785 + (index - 24) * 5;
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
});

export function minuteToFiveMinute(date, lines) {
  if (!/^\d{8}$/.test(date || "")) throw new Error("分时日期无效");
  const records = new Map(
    (lines || []).map((line) => {
      const [time, price, , amount] = line.trim().split(/\s+/);
      return [time, { price: Number(price), amount: Number(amount) }];
    }),
  );
  const day = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
  let previous = 0;
  const bars = [];
  for (const time of BAR_TIMES) {
    const record = records.get(time.replace(":", ""));
    if (!record || !Number.isFinite(record.amount) || record.amount < previous)
      break;
    bars.push([`${day} ${time}`, record.amount - previous, record.price]);
    previous = record.amount;
  }
  return bars;
}

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
  // Field 35 "price/volume/amount" carries turnover in yuan; field 37 is the same in 10k yuan.
  const exact = Number(String(fields[35] || "").split("/")[2]);
  const amount = Number.isFinite(exact) && exact > 0 ? exact : Number(fields[37]) * 10_000;
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
  const optional = (index) => {
    const value = fields[index] === "" ? NaN : Number(fields[index]);
    return Number.isFinite(value) ? value : null;
  };
  const iopv = optional(78);
  return {
    ...fund,
    price,
    amount,
    change,
    time: fields[30],
    date: quoteDate(fields[30]),
    imbalance,
    flow: imbalance === null ? null : amount * imbalance,
    prevClose: optional(4),
    high: optional(33),
    low: optional(34),
    iopv: iopv && iopv > 0 ? iopv : null,
    // Premium of the last price over the exchange-published IOPV (Tencent field 78), in percent.
    // Computed here because field 77 carries the same figure rounded to two decimals.
    premium: iopv && iopv > 0 ? (price / iopv - 1) * 100 : null,
  };
}

// ---------- Real-time layer ----------
// Trading-minute clock: 0 at 09:30, 120 across lunch (11:30 = 13:00), 240 at 15:00.
export function tradingMinute(clock) {
  const digits = String(clock || "").replace(/\D/g, "");
  if (digits.length < 4) return null;
  const total =
    Number(digits.slice(0, 2)) * 60 +
    Number(digits.slice(2, 4)) +
    Number(digits.slice(4, 6) || 0) / 60;
  if (total <= 570) return 0;
  if (total <= 690) return total - 570;
  if (total <= 780) return 120;
  if (total <= 900) return 120 + total - 780;
  return 240;
}

export function clockFor(minute) {
  const whole = Math.round(minute);
  const total = whole <= 120 ? 570 + whole : 780 + whole - 120;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

// Average cumulative turnover at every five-minute mark (49 points, 09:30 … 15:00)
// over the complete days strictly before `beforeDate`.
export function intradayProfile(bars, beforeDate) {
  const days = completeDays(bars, beforeDate);
  if (days.length < 5) return null;
  const points = new Array(BAR_TIMES.length + 1).fill(0);
  for (const [, items] of days) {
    let cumulative = 0;
    BAR_TIMES.forEach((time, index) => {
      cumulative += items.get(time) || 0;
      points[index + 1] += cumulative;
    });
  }
  for (let index = 0; index < points.length; index++)
    points[index] /= days.length;
  return {
    points,
    days: days.length,
    fullDay: points.at(-1),
    from: days[0][0],
    to: days.at(-1)[0],
  };
}

// Weight index of a minute record: 0 = opening auction (09:30 line), the 13:00 line is
// folded into 13:01, otherwise the trading minute that ends with the record.
function weightIndex(record) {
  if (record.clock === "09:30") return 0;
  if (record.clock === "13:00") return 121;
  return Math.round(record.minute);
}
const bucketOf = (index) => (index <= 0 ? 1 : Math.min(48, Math.ceil(index / 5)));

// Within-bar minute shape from complete days of minute data (several funds × days).
// weights[i] = share of minute i in its five-minute bar; weights[0] is the auction share
// of the first bar. Each bar's weights sum to 1.
export function minuteShape(days) {
  const amounts = new Array(241).fill(0);
  const totals = new Array(49).fill(0);
  let used = 0;
  for (const records of days || []) {
    if (!records?.length || records[0].clock !== "09:30" || records.at(-1).clock !== "15:00")
      continue;
    used++;
    for (const record of records) {
      const index = weightIndex(record);
      amounts[index] += record.amount;
      totals[bucketOf(index)] += record.amount;
    }
  }
  if (!used) return null;
  const weights = amounts.map((amount, index) => {
    const total = totals[bucketOf(index)];
    if (total > 0) return amount / total;
    return index === 0 ? 0 : 0.2;
  });
  return { weights, days: used };
}

// Historical average cumulative turnover at a fractional trading minute. Inside each
// five-minute bar it follows the minute shape when one is available, otherwise linear.
export function profileAt(profile, minute, shape = null) {
  if (!profile || !Number.isFinite(minute)) return null;
  const { points } = profile;
  if (!shape) {
    const position = Math.max(0, Math.min(48, minute / 5));
    const index = Math.floor(position);
    if (index >= 48) return points[48];
    return points[index] + (points[index + 1] - points[index]) * (position - index);
  }
  const t = Math.max(0, Math.min(240, minute));
  const bucket = bucketOf(t);
  const start = points[bucket - 1];
  const size = points[bucket] - start;
  let share = bucket === 1 ? shape.weights[0] : 0;
  const whole = Math.floor(t);
  for (let index = (bucket - 1) * 5 + 1; index <= whole; index++) share += shape.weights[index];
  if (whole < bucket * 5 && t > whole) share += (t - whole) * shape.weights[whole + 1];
  return start + size * Math.min(1, share);
}

// Expected turnover of the one minute ending at trading minute `minute`.
export function expectedMinuteAmount(profile, minute, shape = null) {
  if (!profile || !(minute > 0)) return null;
  const index = Math.min(240, Math.round(minute));
  const bucket = bucketOf(index);
  const size = profile.points[bucket] - profile.points[bucket - 1];
  return size * (shape ? shape.weights[index] : 0.2);
}

// Polling schedule by Beijing wall clock. poll = milliseconds between quote requests,
// 0 = paused (lunch, after the close, before 09:15, weekends). "settle" phases take a few
// extra snapshots right after 11:30 and 15:00 so the final numbers are captured.
export function sessionPhase(now = new Date()) {
  const local = chinaNow(now);
  const weekday = new Date(`${local.slice(0, 10)}T12:00:00Z`).getUTCDay();
  const seconds =
    Number(local.slice(11, 13)) * 3600 + Number(local.slice(14, 16)) * 60 + Number(local.slice(17, 19));
  const at = (h, m) => h * 3600 + m * 60;
  const date = local.slice(0, 10);
  if (weekday === 0 || weekday === 6) return { phase: "closed", label: "周末休市", poll: 0, date };
  if (seconds < at(9, 15)) return { phase: "pre", label: "未开盘", poll: 0, date };
  if (seconds < at(9, 30)) return { phase: "auction", label: "集合竞价", poll: REFRESH_MS, date };
  if (seconds < at(11, 30)) return { phase: "open", label: "交易中", poll: REFRESH_MS, date };
  if (seconds < at(11, 31)) return { phase: "settle", label: "午间休市", poll: 3_000, date };
  if (seconds < at(13, 0)) return { phase: "lunch", label: "午间休市", poll: 0, date };
  if (seconds < at(15, 0)) return { phase: "open", label: "交易中", poll: REFRESH_MS, date };
  if (seconds < at(15, 3)) return { phase: "settle", label: "收盘结算", poll: 3_000, date };
  return { phase: "closed", label: "已收盘", poll: 0, date };
}

export const LIVE_MIN_MINUTE = 5;

// Live comparison: today's turnover from the quote (refreshed every 20 s) against the
// historical average up to the same second of the session. The ratio is withheld during
// the first five minutes, when the opening auction dominates.
export function liveSummary(funds, quotes, history, shape = null) {
  const base = aggregate(funds, quotes, history);
  const rows = base.rows.map((row) => {
    const profile = intradayProfile(history[row.symbol]?.fiveMinute, row.date);
    const minute = tradingMinute(row.time.slice(8));
    const expected = profileAt(profile, minute, shape);
    return {
      ...row,
      profile,
      minute,
      expected,
      fullDay: profile?.fullDay ?? null,
      liveRatio:
        expected && minute >= LIVE_MIN_MINUTE ? row.amount / expected : null,
      dayRatio: profile?.fullDay ? row.amount / profile.fullDay : null,
    };
  });
  const latest = rows.map((row) => row.time).sort().at(-1);
  const minute = latest ? tradingMinute(latest.slice(8)) : null;
  const ready =
    rows.length > 0 &&
    rows.every((row) => row.profile && Number.isFinite(row.expected));
  const baseline = ready ? rows.reduce((sum, row) => sum + row.expected, 0) : 0;
  const fullDay = ready ? rows.reduce((sum, row) => sum + row.fullDay, 0) : 0;
  const premiumRows = rows.filter(
    (row) => Number.isFinite(row.premium) && row.amount > 0,
  );
  const premiumWeight = premiumRows.reduce((sum, row) => sum + row.amount, 0);
  return {
    ...base,
    rows,
    minute,
    clock: latest ? `${latest.slice(8, 10)}:${latest.slice(10, 12)}` : null,
    ratio:
      ready && baseline > 0 && minute >= LIVE_MIN_MINUTE
        ? base.amount / baseline
        : null,
    baseline,
    fullDay,
    progress: fullDay ? baseline / fullDay : null,
    dayRatio: fullDay ? base.amount / fullDay : null,
    premium: premiumWeight
      ? premiumRows.reduce((sum, row) => sum + row.premium * row.amount, 0) /
        premiumWeight
      : null,
    days: ready ? Math.min(...rows.map((row) => row.profile.days)) : 0,
    profileRange: ready
      ? {
          from: rows.map((row) => row.profile.from).sort()[0],
          to: rows.map((row) => row.profile.to).sort().at(-1),
        }
      : null,
    comparisonLagMinutes: 0,
    cutoff: latest ? `${latest.slice(8, 10)}:${latest.slice(10, 12)}` : null,
  };
}

// Tencent minute lines "HHMM price cumVolume cumAmount" → per-minute records.
export function parseMinuteLines(lines) {
  const records = [];
  let previous = 0;
  for (const line of lines || []) {
    const [clock, price, , amount] = String(line).trim().split(/\s+/);
    const cumulative = Number(amount);
    const value = Number(price);
    if (!/^\d{4}$/.test(clock) || !Number.isFinite(cumulative) || !Number.isFinite(value))
      continue;
    // Lines after 15:00 are post-close fixed-price trading, outside the compared session.
    if (clock > "1500") break;
    if (cumulative < previous) break;
    // The 13:00 line only marks the restart; its (normally zero) turnover rolls into 13:01,
    // which matches the Eastmoney minute feed and the 13:05 five-minute bar.
    if (clock === "1300") continue;
    records.push({
      clock: `${clock.slice(0, 2)}:${clock.slice(2)}`,
      minute: tradingMinute(clock),
      price: value,
      cumulative,
      amount: cumulative - previous,
    });
    previous = cumulative;
  }
  return records;
}

// Eastmoney trends2 lines "YYYY-MM-DD HH:MM,open,close,volume,amount" (per-minute turnover)
// → per-date minute records in the same shape as parseMinuteLines.
export function parseTrendLines(lines) {
  const days = new Map();
  for (const line of lines || []) {
    const parts = String(line).split(",");
    if (parts.length < 5) continue;
    const stamp = parts[0];
    const date = stamp.slice(0, 10);
    const clock = stamp.slice(11, 16);
    const price = Number(parts[2]);
    const amount = Number(parts[4]);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(clock)) continue;
    if (!Number.isFinite(amount) || amount < 0 || !(price > 0) || clock > "15:00") continue;
    if (!days.has(date)) days.set(date, []);
    const records = days.get(date);
    if (records.length && records.at(-1).clock >= clock) continue;
    records.push({
      clock,
      minute: tradingMinute(clock),
      price,
      cumulative: (records.at(-1)?.cumulative || 0) + amount,
      amount,
    });
  }
  return days;
}

export const PULSE = { multiple: 3, strong: 5, minAmount: 1e8, fundMultiple: 4, fundMinAmount: 5e7 };

// Pool-wide minute series: cumulative turnover, per-minute turnover, its multiple of the
// historical same-minute average, and the turnover-weighted price move of that minute.
// Only minutes every fund has reported are used. Auction minutes (09:30, 13:00 boundary,
// 14:57–15:00) are never flagged as pulses.
export function poolMinutes(minuteMap, profiles, symbols, shape = null) {
  const series = symbols.map((symbol) => minuteMap[symbol] || []);
  if (!series.length || series.some((items) => !items.length)) return [];
  // Align by clock, not by position: stop at the first minute some fund has not reported.
  const positions = series.map((items) => new Map(items.map((record, i) => [record.clock, i])));
  const output = [];
  for (let index = 0; index < series[0].length; index++) {
    const clock = series[0][index].clock;
    if (positions.some((map) => !map.has(clock))) break;
    const minute = series[0][index].minute;
    let cumulative = 0;
    let amount = 0;
    let expected = 0;
    let moveWeight = 0;
    let move = 0;
    let expectedReady = true;
    series.forEach((items, fundIndex) => {
      const position = positions[fundIndex].get(clock);
      const record = items[position];
      cumulative += record.cumulative;
      amount += record.amount;
      const fundExpected = expectedMinuteAmount(profiles[symbols[fundIndex]], minute, shape);
      if (fundExpected === null) expectedReady = false;
      else expected += fundExpected;
      const prior = position ? items[position - 1].price : null;
      if (prior && record.amount > 0) {
        move += (record.price / prior - 1) * record.amount;
        moveWeight += record.amount;
      }
    });
    const multiple = expectedReady && expected > 0 ? amount / expected : null;
    const auction = isAuctionMinute(clock, minute, index, shape);
    output.push({
      clock,
      minute,
      cumulative,
      amount,
      expected: expectedReady ? expected : null,
      multiple,
      move: moveWeight ? move / moveWeight : 0,
      pulse:
        !auction &&
        multiple !== null &&
        multiple >= PULSE.multiple &&
        amount >= PULSE.minAmount,
      strong: !auction && multiple !== null && multiple >= PULSE.strong && amount >= PULSE.minAmount,
    });
  }
  return output;
}

// Auction minutes are never pulses. Without a minute shape, the first continuous minute of
// each session (09:31, 13:01) is also skipped, since a flat 1/5 share understates it.
function isAuctionMinute(clock, minute, index, shape) {
  if (index === 0 || clock === "09:30" || clock === "13:00" || minute > 237) return true;
  return !shape && (clock === "09:31" || clock === "13:01");
}

// Single-fund minute pulses, for the live event feed.
export function fundPulses(fund, records, profile, shape = null) {
  const events = [];
  records.forEach((record, index) => {
    if (isAuctionMinute(record.clock, record.minute, index, shape)) return;
    const expected = expectedMinuteAmount(profile, record.minute, shape);
    if (!expected) return;
    const multiple = record.amount / expected;
    if (multiple < PULSE.fundMultiple || record.amount < PULSE.fundMinAmount) return;
    events.push({
      symbol: fund.symbol,
      name: fund.name,
      group: fund.group,
      clock: record.clock,
      minute: record.minute,
      amount: record.amount,
      multiple,
      move: record.price / records[index - 1].price - 1,
    });
  });
  return events;
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
    comparisonLagMinutes: commonCutoff
      ? Math.max(
          0,
          BAR_TIMES.findLastIndex((time) => time <= expectedCutoff) -
            BAR_TIMES.indexOf(commonCutoff),
        ) * 5
      : null,
    days: comparable ? Math.min(...comparisons.map((item) => item.days)) : 0,
  };
}

export function signalFor(summary, state) {
  if (!summary.complete || !summary.coherent)
    return {
      title: "等待完整数据。",
      headline: "数据不足，暂缓判断。",
      label: "等待完整数据",
      level: "neutral",
      detail: "部分 ETF 行情缺失或时间差超过 3 分钟，暂缓综合信号。",
    };
  if (state.session && !state.fresh)
    return {
      title: "行情待更新。",
      headline: "行情延迟，暂缓判断。",
      label: "数据延迟",
      level: "neutral",
      detail: "保留最近一次可用数据，恢复实时连接后重新判断。",
    };
  if (summary.ratio === null)
    return {
      title: "基线准备中。",
      headline: "基线待齐，暂缓判断。",
      label: "积累数据中",
      level: "neutral",
      detail: "需完整历史五分钟数据与当日已完成区间，开盘初期暂不计算。",
    };
  if (summary.comparisonLagMinutes > 10)
    return {
      title: "量能待更新。",
      headline: "量能延迟，暂缓判断。",
      label: "量能延迟",
      level: "neutral",
      detail:
        "可用量能区间落后最新行情超过 10 个交易分钟，更新后恢复综合信号。",
    };
  if (summary.flow === null)
    return {
      title: "方向待确认。",
      headline: "方向未明，继续观察。",
      label: "方向待确认",
      level: "neutral",
      detail: "外内盘数据不足，成交额与量能倍数仍可查看。",
    };
  const skew = summary.amount ? summary.flow / summary.amount : 0;
  const flow = `${summary.flow > 0 ? "+" : ""}${(summary.flow / 1e8).toFixed(2)}`;
  const evidence = `同刻量能 ${summary.ratio.toFixed(2)}×，外内盘差估算 ${flow} 亿元。`;
  if (summary.ratio >= 1.8 && skew >= 0.08)
    return {
      title: "放量。买盘偏强。",
      headline: "疑似在上班。",
      evidence,
      label: "重点观察",
      level: "strong",
      detail: "量能 ≥ 1.8×，买卖差占比 ≥ 8%。",
    };
  if (summary.ratio >= 1.3 && skew > 0)
    return {
      title: "放量。留意买盘。",
      headline: "疑似有动作。",
      evidence,
      label: "放量观察",
      level: "watch",
      detail: "量能 ≥ 1.3×，外内盘差偏正。",
    };
  if (summary.ratio >= 1.3)
    return {
      title: "放量。买盘待确认。",
      headline: "护盘尚待确认。",
      evidence,
      label: "放量观察",
      level: "watch",
      detail: "量能 ≥ 1.3×，外内盘差未呈买盘优势。",
    };
  return {
    title: "量能平稳。",
    headline: "暂未见上班迹象。",
    evidence,
    label: "常态观察",
    level: "calm",
    detail: "成交额低于 1.3× 放量观察阈值。",
  };
}
