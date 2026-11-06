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
} from "../public/core.js";

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
