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
  minuteToFiveMinute,
} from "../public/core.js";

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

test("headline and evidence follow the measured volume and direction", () => {
  const base = {
    complete: true,
    coherent: true,
    amount: 100e8,
    comparisonLagMinutes: 0,
  };
  const market = { session: true, fresh: true };
  const cases = [
    { ratio: 1.16, flow: -5.78e8, headline: "暂未见上班迹象。" },
    { ratio: 1.5, flow: 5e8, headline: "疑似有动作。" },
    { ratio: 1.8, flow: 8e8, headline: "疑似在上班。" },
    { ratio: 2, flow: -5e8, headline: "护盘尚待确认。" },
    { ratio: 2, flow: 0, headline: "护盘尚待确认。" },
  ];
  for (const item of cases) {
    const signal = signalFor({ ...base, ...item }, market);
    assert.equal(signal.headline, item.headline);
    assert.ok(signal.evidence.includes(`${item.ratio.toFixed(2)}×`));
  }
  const calm = signalFor({ ...base, ratio: 1.16, flow: -5.78e8 }, market);
  assert.equal(calm.evidence, "同刻量能 1.16×，外内盘差估算 -5.78 亿元。");
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
    "方向未明，继续观察。",
  );
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
  assert.equal(summary.rows.length, 12);
  assert.ok(summary.amount > 0);
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
