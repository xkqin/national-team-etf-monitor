import test from "node:test";
import assert from "node:assert/strict";
import { createMinuteFetcher, parseTencentDays } from "../public/minute-source.js";

const date = "2026-11-13";
const symbol = "sh510300";
const tencent = { data: { [symbol]: { data: [
  { date: "20261113", data: ["0930 4.124 44905 18518822.00", "0931 4.125 45000 18558000.00"] },
  { date: "20261112", data: ["0930 4.145 42868 17768786.00", "1530 4.114 11635541 4820148747.01"] },
] } } };
const eastmoney = { data: { trends: [`${date} 09:30,4.124,4.124,44905,18518822`, `${date} 09:31,4.124,4.125,95,39178`] } };

test("Tencent five-day feed provides dated real minute turnover, excluding after-hours", () => {
  const days = parseTencentDays(tencent, symbol);
  assert.equal(days.get(date).length, 2);
  assert.equal(days.get(date)[1].amount, 39178);
  assert.equal(days.get("2026-11-12").length, 1);
});

test("a disconnected primary falls back to Tencent day/query, not the failing minute route", async () => {
  const urls = [];
  const fetchMinute = createMinuteFetcher({ fetchText: async url => {
    urls.push(url);
    if (url.includes('eastmoney')) throw new TypeError('Failed to fetch');
    return JSON.stringify(tencent);
  }});
  const result = await fetchMinute(symbol, date);
  assert.equal(result.source, "腾讯");
  assert.equal(result.date, date);
  assert.equal(result.records[1].cumulative, 18558000);
  assert.match(urls[1], /\/day\/query/);
  assert.equal(urls.some(url => url.includes('/minute/query')), false);
});

test("a healthy primary avoids unnecessary backup traffic", async () => {
  let calls = 0;
  const fetchMinute = createMinuteFetcher({ fetchText: async () => { calls++; return JSON.stringify(eastmoney); } });
  assert.equal((await fetchMinute(symbol, date)).source, "东方财富");
  assert.equal(calls, 1);
});

test("old dated minute data never substitutes for today's requested date", async () => {
  const fetchMinute = createMinuteFetcher({ fetchText: async url => JSON.stringify(
    url.includes('eastmoney') ? { data: { trends: [] } } : tencent
  ) });
  await assert.rejects(fetchMinute(symbol, "2026-11-16"), /日期/);
});

test("total outage rests the sources, then probes again in the next minute", async () => {
  let clock = 1000, calls = 0, recovering = false;
  const status = {}, down = {}, failures = {};
  const fetchMinute = createMinuteFetcher({ now: () => clock, status, down, failures,
    fetchText: async () => { calls++; if (!recovering) throw new TypeError('Failed to fetch'); return JSON.stringify(eastmoney); } });
  for (let i = 0; i < 3; i++) await assert.rejects(fetchMinute(symbol, date));
  assert.equal(calls, 6);
  clock += 59_999;
  await assert.rejects(fetchMinute(symbol, date));
  assert.equal(calls, 6, "do not hammer both unavailable hosts inside the same round");
  clock++;
  recovering = true;
  assert.equal((await fetchMinute(symbol, date)).source, "东方财富");
  assert.equal(down.eastmoney, 0);
  assert.equal(status.eastmoney.error, "");
});

test("an in-flight success clears the cooldown established by concurrent failures", async () => {
  let finish;
  const down = {}, failures = {};
  const fetchMinute = createMinuteFetcher({ now: () => 1000, down, failures,
    fetchText: () => new Promise(resolve => { finish = resolve; }) });
  const pending = fetchMinute(symbol, date);
  down.eastmoney = 61000; failures.eastmoney = 3;
  finish(JSON.stringify(eastmoney));
  await pending;
  assert.equal(down.eastmoney, 0);
  assert.equal(failures.eastmoney, 0);
});
