import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  normalizeQuote,
  parseQuotes,
  cutoffFor,
  volumeComparison,
  completeDays,
  marketState,
  aggregate,
  signalFor,
  activityFor,
  minuteToFiveMinute,
  tradingMinute,
  clockFor,
  intradayProfile,
  profileAt,
  expectedMinuteAmount,
  liveSummary,
  parseMinuteLines,
  poolMinutes,
  fundPulses,
  minuteShape,
  sessionPhase,
  parseTrendLines,
  minuteFeedMode,
} from "../public/core.js";

test("a five-minute first paint does not report failed minute feeds before requests finish", () => {
  const coarse = { hasRecords: true, coarse: true };
  assert.equal(minuteFeedMode({ ...coarse, attempted: false, loading: false }), "loading");
  assert.equal(minuteFeedMode({ ...coarse, attempted: true, loading: true }), "loading");
  assert.equal(minuteFeedMode({ ...coarse, attempted: true, loading: false }), "snapshot");
  assert.equal(minuteFeedMode({ hasRecords: true, coarse: false, attempted: true, loading: true }), "minute");
  assert.equal(minuteFeedMode({ hasRecords: false, coarse: false, attempted: false, loading: false }), "loading");
});

test("Tencent cumulative amounts convert to equivalent five-minute turnover", () => {
  const bars = minuteToFiveMinute("20261106", [
    "0930 4.113 260099 106978719.00",
    "0935 4.130 2565750 1055320056.00",
    "0940 4.125 3118775 1283640833.00",
  ]);
  assert.deepEqual(bars, [
    ["2026-11-06 09:35", 1055320056, 4.13],
    ["2026-11-06 09:40", 228320777, 4.125],
  ]);
});

test("missing minute endpoints cannot shift volume into later intervals", () => {
  const bars = minuteToFiveMinute("20261106", ["0935 4 1 100", "0945 4 2 300"]);
  assert.equal(bars.length, 1);
  assert.equal(bars[0][1], 100);
});

test("delayed volume history suppresses current composite signals", () => {
  const result = signalFor(
    {
      complete: true,
      coherent: true,
      ratio: 2,
      flow: 100,
      amount: 200,
      comparisonLagMinutes: 15,
    },
    { session: true, fresh: true },
  );
  assert.equal(result.label, "量能延迟");
  assert.equal(result.headline, "量能延迟，暂缓判断。");
});

test("recent buying drives the headline even with a low all-day ratio and negative cumulative flow", () => {
  const base = {
    complete: true,
    coherent: true,
    amount: 100e8,
    comparisonLagMinutes: 0,
  };
  const market = { session: true, fresh: true };
  const data = activityFixture(1.75);
  const activity = activityFor(data.rows, data.map, 90);
  const signal = signalFor({ ...base, ratio: 0.82, flow: -5e8 }, market, activity);
  assert.equal(signal.headline, "当前温和放量上行。");
  assert.equal(signal.grade, 2);
  assert.match(signal.evidence, /1.75×/);
});

test("incomplete, stale, and unready data defer the headline conclusion", () => {
  const base = {
    complete: true,
    coherent: true,
    amount: 100e8,
    flow: 10e8,
    ratio: 2,
    comparisonLagMinutes: 0,
  };
  assert.equal(
    signalFor({ ...base, complete: false }, { session: true, fresh: true })
      .headline,
    "数据不足，暂缓判断。",
  );
  assert.equal(
    signalFor(base, { session: true, fresh: false }).headline,
    "行情延迟，暂缓判断。",
  );
  assert.equal(
    signalFor({ ...base, ratio: null }, { session: true, fresh: true })
      .headline,
    "基线待齐，暂缓判断。",
  );
  assert.equal(
    signalFor({ ...base, flow: null }, { session: true, fresh: true }).headline,
    "分钟待齐，暂缓判断。",
  );
});

function activityFixture(multiple = 1, direction = 1, length = 90) {
  const profile = { points: Array.from({ length: 49 }, (_, i) => i * 5e7), days: 20 };
  const rows = Array.from({ length: 4 }, (_, i) => ({ symbol: `core${i}`, group: "沪深300", profile }));
  const map = Object.fromEntries(rows.map((row) => {
    let cumulative = 0;
    const records = Array.from({ length: length + 1 }, (_, minute) => {
      const ratio = typeof multiple === "function" ? multiple(minute) : multiple;
      const amount = ratio * 1e7;
      cumulative += amount;
      return { minute, clock: clockFor(minute), amount, cumulative, price: 4 * (1 + direction * minute * 0.0001) };
    });
    return [row.symbol, records];
  }));
  return { rows, map };
}

test("activity distinguishes quiet, light, moderate, active and strong buying", () => {
  for (const [ratio, grade] of [[1.1, 0], [1.21, 1], [1.51, 2], [2.01, 3], [3.01, 4]]) {
    const { rows, map } = activityFixture(ratio);
    const activity = activityFor(rows, map, 90);
    assert.equal(activity.available, true);
    assert.equal(activity.current.grade, grade);
    assert.equal(activity.current.width, 15);
    assert.equal(activity.current.end, 89, "unfinished minute must be excluded");
  }
});

test("selling-only turnover spikes never become buying activity", () => {
  const { rows, map } = activityFixture(5, -1);
  const result = activityFor(rows, map, 90);
  assert.equal(result.current.grade, 0);
  assert.equal(result.peak, null);
});

test("past activity remains visible as today's peak but decays out of current strength", () => {
  const { rows, map } = activityFixture(t => t > 30 && t <= 35 ? 3.5 : 1);
  const result = activityFor(rows, map, 90);
  assert.equal(result.current.grade, 0);
  assert.equal(result.peak.grade, 2);
  assert.equal(result.peak.width, 15);
  assert.equal(result.shortPeak.grade, 4);
  assert.equal(result.shortPeak.clock, "10:05");
  assert.equal(result.events.length, 1, "overlapping observations are one episode");
  const signal = signalFor({ complete: true, coherent: true, ratio: 0.8 }, { fresh: true, session: true }, result);
  assert.equal(signal.headline, "当前未见明显信号。");
});

test("missing, delayed or gapped core minutes are unknown instead of quiet", () => {
  const { rows, map } = activityFixture(3);
  assert.equal(activityFor(rows, {}, 90).available, false, "snapshot has no true minutes");
  assert.equal(activityFor(rows.slice(1), map, 90).available, false);
  const delayed = Object.fromEntries(Object.entries(map).map(([symbol, records]) => [symbol, records.slice(0, 80)]));
  assert.equal(activityFor(rows, delayed, 90).available, false);
  const gap = { ...map, core0: map.core0.filter(r => r.minute !== 86) };
  assert.equal(activityFor(rows, gap, 90).available, false);
});

test("strong grades require broad participation and sufficient absolute turnover", () => {
  const { rows, map } = activityFixture(4);
  for (const symbol of ["core2", "core3"]) map[symbol] = map[symbol].map(r => ({ ...r, price: 4 }));
  assert.equal(activityFor(rows, map, 90).current.grade, 2);
  const thin = activityFixture(4);
  for (const records of Object.values(thin.map)) for (const r of records) r.cumulative /= 1000;
  for (const row of thin.rows) row.profile = { ...row.profile, points: row.profile.points.map(v => v / 1000) };
  assert.equal(activityFor(thin.rows, thin.map, 90).current.grade, 0);
});

test("a falling fifteen-minute interval cannot become a buying signal", () => {
  const { rows, map } = activityFixture(t => t > 74 && t <= 84 ? 5 : 1);
  for (const records of Object.values(map)) for (const r of records) {
    if (r.minute > 84) r.price = 4 * (1 + 84 * 0.0001) - (r.minute - 84) * 0.001;
  }
  const result = activityFor(rows, map, 90);
  assert.equal(result.current.grade, 0);
  assert.ok(result.peak.grade > 0);
});

test("opening and cross-lunch windows cannot create current activity", () => {
  const { rows, map } = activityFixture(4, 1, 130);
  assert.equal(activityFor(rows, map, 9).available, false);
  // 13:02 has neither a 5- nor 15-minute window wholly in the afternoon session.
  assert.equal(activityFor(rows, map, 122).available, false);
});

test("Nov 11 five-minute rally remains an alert, not an invented fifteen-minute reading", async () => {
  const fixture = JSON.parse(await readFile(new URL("./fixtures/activity-20261111.json", import.meta.url), "utf8"));
  const replay = activityFor(fixture.rows, fixture.minuteMap, 166);
  assert.equal(replay.available, false, "the preserved fragment does not cover fifteen minutes");
  assert.equal(replay.windows[5].grade, 2);
  assert.equal(replay.windows[5].clock, "13:45");
  assert.ok(Math.abs(replay.windows[5].multiple - 1.75303) < 0.0001);
  assert.equal(replay.windows[5].rising, 4);
  const later = activityFor(fixture.rows, fixture.minuteMap, 224);
  assert.equal(later.current.grade, 0);
  assert.equal(later.shortPeak.clock, "13:45");
});

test("a brief five-minute burst does not replace a quiet fifteen-minute main signal", () => {
  const { rows, map } = activityFixture(t => t > 84 ? 3.1 : 0.1);
  const activity = activityFor(rows, map, 90);
  assert.equal(activity.current.width, 15);
  assert.equal(activity.current.grade, 0);
  assert.equal(activity.windows[5].grade, 4);
  assert.equal(activity.windows[30].grade, 0);
  assert.equal(activity.peak, null);
  assert.equal(activity.shortPeak.grade, 4);
});

test("five-minute cooling and quiet thirty-minute context do not veto fifteen-minute strength", () => {
  const { rows, map } = activityFixture(t => t > 74 && t <= 84 ? 3.1 : 0.1);
  for (const records of Object.values(map)) for (const r of records) {
    if (r.minute > 84) r.price = 4 * (1 + 84 * 0.0001) - (r.minute - 84) * 0.0001;
  }
  const activity = activityFor(rows, map, 90);
  assert.equal(activity.current.grade, 3);
  assert.equal(activity.windows[5].grade, 0);
  assert.ok(activity.windows[5].move < 0);
  assert.equal(activity.windows[30].grade, 0);
});

test("five-minute alert is available while the main window is still accumulating", () => {
  const { rows, map } = activityFixture(3.1);
  const activity = activityFor(rows, map, 16);
  assert.equal(activity.available, false);
  assert.equal(activity.current, null);
  assert.equal(activity.windows[5].grade, 4);
  assert.equal(activity.windows[15], null);
  assert.equal(activity.windows[30], null);
});

test("latest fifteen-minute gaps preserve earlier day records without falling back to five", () => {
  const { rows, map } = activityFixture(t => t > 30 && t <= 45 ? 3.5 : 1);
  map.core0 = map.core0.filter(r => r.minute !== 78);
  const activity = activityFor(rows, map, 90);
  assert.equal(activity.available, false);
  assert.equal(activity.windows[5].grade, 0);
  assert.equal(activity.current, null);
  assert.equal(activity.peak.grade, 4);
  assert.equal(activity.historyComplete, false);
  assert.equal(activity.events.length, 1);
});

test("delayed current readings do not erase dated earlier signals", () => {
  const { rows, map } = activityFixture(2);
  const delayed = Object.fromEntries(Object.entries(map).map(([symbol, records]) => [symbol, records.slice(0, 80)]));
  const activity = activityFor(rows, delayed, 90);
  assert.equal(activity.available, false);
  assert.deepEqual(activity.windows, { 5: null, 15: null, 30: null });
  assert.ok(activity.peak.grade > 0);
  assert.equal(activity.historyComplete, false);
});

test("afternoon main interval waits for fifteen minutes and starts at 13:00", () => {
  const { rows, map } = activityFixture(2, 1, 170);
  const early = activityFor(rows, map, 131);
  assert.equal(early.available, false);
  assert.equal(early.windows[5].width, 5);
  assert.ok(early.peak, "morning history remains available during afternoon accumulation");
  const ready = activityFor(rows, map, 136);
  assert.equal(ready.current.from, "13:00");
  assert.equal(ready.current.clock, "13:15");
  assert.equal(ready.windows[30], null);
});

test("each width compares the exact corresponding historical interval", () => {
  const { rows, map } = activityFixture(t => t > 74 ? 2 : 1);
  const activity = activityFor(rows, map, 90);
  for (const width of [5, 15, 30]) {
    const point = activity.windows[width];
    const expected = rows.reduce((n, row) => n + profileAt(row.profile, point.end) - profileAt(row.profile, point.start), 0);
    assert.equal(point.expected, expected);
    assert.equal(point.end - point.start, width);
  }
});

const fund = {
  symbol: "sh510300",
  code: "510300",
  name: "ETF",
  group: "沪深300",
};
function fields(time = "20261106104320") {
  const values = Array(40).fill("");
  Object.assign(values, {
    3: "4.000",
    7: "600",
    8: "400",
    30: time,
    32: "-1.2",
    37: "10000",
  });
  return values;
}
function fullDay(date, amount = 100) {
  return Array.from({ length: 48 }, (_, index) => {
    const minutes = index < 24 ? 575 + index * 5 : 785 + (index - 24) * 5;
    const time = `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
    return [`${date} ${time}`, amount, 4];
  });
}
const previousDates = [
  "2026-10-29",
  "2026-10-30",
  "2026-11-02",
  "2026-11-03",
  "2026-11-04",
  "2026-11-05",
];
const history = {
  fiveMinute: [
    ...previousDates.flatMap((date) => fullDay(date)),
    ...fullDay("2026-11-06", 200),
  ],
};

test("quote amount converts ten-thousand yuan to yuan, with directional estimate", () => {
  const quote = normalizeQuote(fields(), fund);
  assert.equal(quote.amount, 1e8);
  assert.equal(quote.flow, 2e7);
  assert.equal(quote.change, -1.2);
  assert.equal(quote.date, "2026-11-06");
});
test("unavailable outer/inner volumes remain unknown", () => {
  const values = fields();
  values[7] = values[8] = "0";
  assert.equal(normalizeQuote(values, fund).flow, null);
});
test("malformed and empty prices are rejected", () => {
  assert.equal(normalizeQuote([], fund), null);
  const values = fields();
  values[3] = "";
  assert.equal(normalizeQuote(values, fund), null);
});
test("quote parsing treats remote text as data", () => {
  assert.equal(parseQuotes('v_sh510300="1~2";anything();').sh510300.length, 2);
});
test("five-minute cutoff excludes an unfinished final minute and handles lunch", () => {
  assert.equal(cutoffFor("20261106093559"), null);
  assert.equal(cutoffFor("20261106093600"), "09:35");
  assert.equal(cutoffFor("20261106104010"), "10:35");
  assert.equal(cutoffFor("20261106104320"), "10:40");
  assert.equal(cutoffFor("20261106120000"), "11:30");
  assert.equal(cutoffFor("20261106150500"), "15:00");
});
test("same-time ratio excludes today from its historical denominator", () => {
  const quote = normalizeQuote(fields(), fund);
  const result = volumeComparison(quote, history);
  assert.equal(result.ratio, 2);
  assert.equal(result.days, 6);
  assert.equal(result.cutoff, "10:40");
});
test("partial historical days and duplicated bars cannot form a full day", () => {
  const partial = fullDay("2026-10-28").slice(10);
  assert.equal(
    completeDays([...history.fiveMinute, ...partial, ...partial], "2026-11-06")
      .length,
    6,
  );
});
test("insufficient history and missing opening bars do not emit ratios", () => {
  const quote = normalizeQuote(fields(), fund);
  assert.equal(
    volumeComparison(quote, { fiveMinute: fullDay("2026-11-05") }),
    null,
  );
  assert.equal(
    volumeComparison(quote, {
      fiveMinute: history.fiveMinute.filter(
        ([time]) => time !== "2026-11-06 09:35",
      ),
    }),
    null,
  );
});
test("aggregate picks a common completed cutoff across all funds", () => {
  const other = { ...fund, symbol: "sz159919" };
  const summary = aggregate(
    [fund, other],
    {
      [fund.symbol]: fields("20261106104559"),
      [other.symbol]: fields("20261106104601"),
    },
    { [fund.symbol]: history, [other.symbol]: history },
  );
  assert.equal(summary.cutoff, "10:40");
  assert.equal(summary.ratio, 2);
});
test("missing or mixed-date quotes suppress composite signals", () => {
  const other = { ...fund, symbol: "sz159919" };
  const summary = aggregate(
    [fund, other],
    { [fund.symbol]: fields() },
    { [fund.symbol]: history },
  );
  assert.equal(summary.complete, false);
  assert.equal(
    signalFor(summary, { fresh: true, session: true }).label,
    "等待完整数据",
  );
});
test("stale and future-dated quotes cannot create live signals", () => {
  assert.equal(
    marketState("20261106100000", new Date("2026-11-06T10:10:00+08:00")).fresh,
    false,
  );
  assert.equal(
    marketState("20261106102000", new Date("2026-11-06T10:10:00+08:00")).fresh,
    false,
  );
  assert.equal(
    signalFor(
      { complete: true, coherent: true, ratio: 3, flow: 1e8, amount: 2e8 },
      { session: true, fresh: false },
    ).label,
    "数据延迟",
  );
});
test("live, lunch, and after-close labels reflect Beijing time", () => {
  assert.equal(
    marketState("20261106104320", new Date("2026-11-06T10:43:40+08:00")).label,
    "交易中",
  );
  assert.equal(
    marketState("20261106113000", new Date("2026-11-06T12:00:00+08:00")).label,
    "午间休市",
  );
  assert.equal(
    marketState("20261106150000", new Date("2026-11-06T16:00:00+08:00")).label,
    "已收盘",
  );
});
test("actual collected snapshot has all funds and usable history", async () => {
  const pool = JSON.parse(
    await readFile(new URL("../public/pool.json", import.meta.url)),
  );
  const snapshot = JSON.parse(
    await readFile(new URL("../public/data/snapshot.json", import.meta.url)),
  );
  const summary = aggregate(pool, snapshot.quotes, snapshot.history);
  assert.equal(summary.complete, true);
  assert.equal(summary.rows.length, pool.length);
  assert.equal(new Set(pool.map((item) => item.symbol)).size, pool.length);
  assert.ok(summary.amount > 0);
  const live = liveSummary(pool, snapshot.quotes, snapshot.history);
  assert.ok(live.rows.every((row) => row.profile && row.profile.days >= 5));
  assert.ok(live.fullDay > 0);
  assert.ok(
    pool.every((item) => snapshot.history[item.symbol].daily.length >= 200),
  );
  assert.ok(
    pool.every(
      (item) =>
        completeDays(snapshot.history[item.symbol].fiveMinute, summary.date)
          .length >= 5,
    ),
  );
});

test("trading-minute clock skips lunch and clamps to the session", () => {
  assert.equal(tradingMinute("0915"), 0);
  assert.equal(tradingMinute("093000"), 0);
  assert.equal(tradingMinute("1043"), 73);
  assert.equal(tradingMinute("104330"), 73.5);
  assert.equal(tradingMinute("1130"), 120);
  assert.equal(tradingMinute("1215"), 120);
  assert.equal(tradingMinute("1301"), 121);
  assert.equal(tradingMinute("15:00"), 240);
  assert.equal(tradingMinute("1530"), 240);
  assert.equal(clockFor(0), "09:30");
  assert.equal(clockFor(120), "11:30");
  assert.equal(clockFor(121), "13:01");
  assert.equal(clockFor(240), "15:00");
});

test("live ratio compares quote turnover with the interpolated same-second baseline", () => {
  const profile = intradayProfile(history.fiveMinute, "2026-11-06");
  assert.equal(profile.days, 6);
  assert.equal(profile.fullDay, 4800);
  assert.equal(profileAt(profile, 0), 0);
  assert.equal(profileAt(profile, 5), 100);
  assert.equal(profileAt(profile, 7.5), 150);
  assert.equal(profileAt(profile, 240), 4800);
  assert.equal(expectedMinuteAmount(profile, 7), 20);
  // 10:43:20 → minute 73.33…, baseline 1466.67; quote turnover 1e8 yuan
  const pool = [fund];
  const summary = liveSummary(pool, { [fund.symbol]: fields("20261106104320") }, { [fund.symbol]: history });
  assert.ok(Math.abs(summary.baseline - 1466.6667) < 0.01);
  assert.ok(Math.abs(summary.ratio - 1e8 / summary.baseline) < 1e-6);
  assert.ok(Math.abs(summary.progress - summary.baseline / 4800) < 1e-9);
  assert.equal(summary.dayRatio, 1e8 / 4800);
  assert.equal(summary.comparisonLagMinutes, 0);
  assert.equal(summary.clock, "10:43");
});

test("live ratio is withheld during the opening auction minutes", () => {
  const summary = liveSummary([fund], { [fund.symbol]: fields("20261106093200") }, { [fund.symbol]: history });
  assert.equal(summary.ratio, null);
  assert.equal(signalFor(summary, { session: true, fresh: true }).label, "积累数据中");
});

test("premium is the turnover-weighted IOPV premium and stays null without IOPV", () => {
  const a = fields("20261106104320");
  a[78] = "3.992";
  const b = fields("20261106104320");
  b[37] = "30000";
  b[78] = "4.004";
  const other = { ...fund, symbol: "sz159919" };
  const summary = liveSummary([fund, other], { [fund.symbol]: a, [other.symbol]: b }, { [fund.symbol]: history, [other.symbol]: history });
  const pa = (4 / 3.992 - 1) * 100;
  const pb = (4 / 4.004 - 1) * 100;
  assert.ok(Math.abs(summary.premium - (pa * 1 + pb * 3) / 4) < 1e-12);
  assert.equal(normalizeQuote(fields(), fund).premium, null);
  // Exact turnover in yuan from field 35 wins over the 10k-yuan field 37.
  const exact = fields();
  exact[35] = "4.000/2500/100012345";
  assert.equal(normalizeQuote(exact, fund).amount, 100012345);
});

test("minute lines become per-minute turnover and pulses ignore auction minutes", () => {
  const lines = [
    "0930 4.00 100 9000000000.00",
    "0931 4.00 200 9000000010.00",
    "0932 4.02 300 9500000010.00",
    "0933 4.01 400 9500000020.00",
  ];
  const records = parseMinuteLines(lines);
  assert.equal(records.length, 4);
  assert.equal(records[0].amount, 9e9);
  assert.equal(records[2].amount, 5e8);
  assert.equal(records[2].minute, 2);
  const profile = { points: Array.from({ length: 49 }, (_, i) => i * 5e7), days: 20, fullDay: 48 * 5e7 };
  // expected per minute = 1e7; minute 2 trades 5e8 = 50×, price up
  const series = poolMinutes({ x: records }, { x: profile }, ["x"]);
  assert.equal(series[0].pulse, false);
  assert.equal(series[2].pulse, true);
  assert.equal(series[2].strong, true);
  assert.ok(series[2].move > 0);
  assert.equal(series[3].pulse, false);
  const events = fundPulses({ symbol: "x", name: "X", group: "沪深300" }, records, profile);
  assert.equal(events.length, 1);
  assert.equal(events[0].clock, "09:32");
});

test("polling follows the Beijing session and pauses at lunch, after the close and on weekends", () => {
  const at = (iso) => sessionPhase(new Date(iso));
  assert.equal(at("2026-11-06T08:00:00+08:00").poll, 0);
  assert.equal(at("2026-11-06T09:20:00+08:00").phase, "auction");
  assert.equal(at("2026-11-06T10:00:00+08:00").poll, 1000);
  assert.equal(at("2026-11-06T11:30:30+08:00").phase, "settle");
  assert.equal(at("2026-11-06T12:00:00+08:00").poll, 0);
  assert.equal(at("2026-11-06T13:00:00+08:00").poll, 1000);
  assert.equal(at("2026-11-06T14:59:59+08:00").poll, 1000);
  assert.equal(at("2026-11-06T15:01:00+08:00").phase, "settle");
  assert.equal(at("2026-11-06T15:10:00+08:00").poll, 0);
  assert.equal(at("2026-11-06T15:10:00+08:00").label, "已收盘");
  assert.equal(at("2026-11-07T10:00:00+08:00").poll, 0);
});

test("minute shape spreads each five-minute bar by its real minute weights", () => {
  const clocks = [];
  for (let t = 570; t <= 690; t++) clocks.push(t);
  for (let t = 780; t <= 900; t++) clocks.push(t);
  let cumulative = 0;
  const lines = clocks.map((t) => {
    const clock = `${String(Math.floor(t / 60)).padStart(2, "0")}${String(t % 60).padStart(2, "0")}`;
    cumulative += clock === "0930" ? 100 : clock === "0931" ? 50 : clock === "1300" ? 0 : 10;
    return `${clock} 4.00 1 ${cumulative}`;
  });
  const shape = minuteShape([parseMinuteLines(lines), parseMinuteLines(lines.slice(0, 50))]);
  assert.equal(shape.days, 1);
  assert.ok(Math.abs(shape.weights[0] - 100 / 190) < 1e-12);
  assert.ok(Math.abs(shape.weights[1] - 50 / 190) < 1e-12);
  assert.ok(Math.abs(shape.weights[6] - 0.2) < 1e-12);
  assert.ok(Math.abs(shape.weights[121] - 0.2) < 1e-12);
  const profile = { points: Array.from({ length: 49 }, (_, i) => i * 5e7), days: 20, fullDay: 48 * 5e7 };
  assert.ok(Math.abs(profileAt(profile, 0, shape) - 5e7 * (100 / 190)) < 1e-3);
  assert.ok(Math.abs(profileAt(profile, 1, shape) - 5e7 * (150 / 190)) < 1e-3);
  assert.ok(Math.abs(profileAt(profile, 5, shape) - 5e7) < 1e-3);
  assert.ok(Math.abs(profileAt(profile, 7.5, shape) - 7.5e7) < 1e-3);
  assert.ok(Math.abs(profileAt(profile, 240, shape) - 48 * 5e7) < 1e-3);
  assert.ok(Math.abs(expectedMinuteAmount(profile, 1, shape) - 5e7 * (50 / 190)) < 1e-3);
  // With a real shape, the first continuous minute is judged against its own weight.
  const records = parseMinuteLines(["0930 4.00 1 100", "0931 4.01 2 200000100"]);
  assert.equal(fundPulses({ symbol: "x", name: "X" }, records, profile, shape).length, 1);
  assert.equal(fundPulses({ symbol: "x", name: "X" }, records, profile, null).length, 0);
});

test("Eastmoney and Tencent minute feeds produce the same aligned records", () => {
  const tencent = parseMinuteLines([
    "0930 4.149 163884 67995472.00",
    "0931 4.155 1091253 453132540.00",
    "1130 4.193 1200000 600000000.00",
    "1300 4.193 1200000 600000000.00",
    "1301 4.182 1300000 715944424.00",
  ]);
  const eastmoney = parseTrendLines([
    "2026-11-05 09:30,0.000,4.149,163884,67995472.000",
    "2026-11-05 09:31,0.000,4.155,927369,385137068.000",
    "2026-11-05 11:30,0.000,4.193,56202,146867460.000",
    "2026-11-05 13:01,0.000,4.182,277382,115944424.000",
  ]).get("2026-11-05");
  assert.deepEqual(tencent.map((r) => r.clock), ["09:30", "09:31", "11:30", "13:01"]);
  assert.deepEqual(eastmoney.map((r) => r.clock), tencent.map((r) => r.clock));
  tencent.forEach((record, i) => {
    assert.ok(Math.abs(record.cumulative - eastmoney[i].cumulative) < 1);
    assert.equal(record.minute, eastmoney[i].minute);
  });
  const profile = { points: Array.from({ length: 49 }, (_, i) => i * 5e7), days: 20, fullDay: 48 * 5e7 };
  const series = poolMinutes({ a: tencent, b: eastmoney }, { a: profile, b: profile }, ["a", "b"]);
  assert.equal(series.length, 4);
  assert.ok(Math.abs(series[3].cumulative - 2 * 715944424) < 2);
  // A fund that has not reported 13:01 yet stops the pool series there.
  assert.equal(poolMinutes({ a: tencent, b: eastmoney.slice(0, 3) }, { a: profile, b: profile }, ["a", "b"]).length, 3);
});

test("a thin fund with missing minutes cannot blank or truncate the pool series", () => {
  const full = parseMinuteLines(["0930 4 1 100", "0931 4 2 300", "0932 4.1 3 600", "0933 4.1 4 700"]);
  // No auction trade (no 09:30 line) and no trade at 09:32.
  const thin = parseMinuteLines(["0931 1 1 50", "0933 1.01 2 80"]);
  const profile = { points: Array.from({ length: 49 }, (_, i) => i * 5e7), days: 20, fullDay: 48 * 5e7 };
  const series = poolMinutes({ a: full, b: thin }, { a: profile, b: profile }, ["a", "b"]);
  assert.deepEqual(series.map((p) => p.clock), ["09:30", "09:31", "09:32", "09:33"]);
  assert.deepEqual(series.map((p) => p.cumulative), [100, 350, 650, 780]);
  assert.deepEqual(series.map((p) => p.amount), [100, 250, 300, 130]);
});

test("post-close fixed-price lines are excluded from the session minutes", () => {
  const records = parseMinuteLines(["1459 4 1 100", "1500 4 2 200", "1505 4 3 300", "1530 4 4 400"]);
  assert.equal(records.at(-1).clock, "15:00");
  assert.equal(records.length, 2);
});
