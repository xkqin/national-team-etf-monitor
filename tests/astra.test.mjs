import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const klineSource = await readFile(new URL("../public/astra/kline.js", import.meta.url), "utf8");
const dashboardSource = await readFile(new URL("../public/astra/dashboard.js", import.meta.url), "utf8");
const jsonResponse = value => ({ ok: true, json: async () => value });

function klineContext(fetch) {
  const context = vm.createContext({ window: {}, fetch, AbortSignal, Map, Date, TextDecoder });
  vm.runInContext(klineSource, context);
  return context.window.AstraKline;
}

test("Astra daily history falls back to unadjusted Tencent bars", async () => {
  const calls = [];
  const api = klineContext(async url => {
    calls.push(url);
    if (url.includes("eastmoney")) throw new TypeError("Failed to fetch");
    return jsonResponse({ data: { sh000300: { day: [["2026-11-05", "4000", "4010", "4020", "3990", "100"]] } } });
  });
  const bars = await api.load("1.000300", 260);
  assert.equal(bars[0].close, 4010);
  assert.equal(bars[0].source, "腾讯");
  assert.equal(bars[0].amount, null);
  assert.ok(calls[1].endsWith("sh000300,day,,,280,"));
});

test("empty history is rejected and does not poison the daily cache", async () => {
  let fail = true;
  const api = klineContext(async url => {
    if (fail) return jsonResponse({ data: {} });
    return jsonResponse({ data: { klines: ["2026-11-05,10,11,12,9,100,1000"] } });
  });
  await assert.rejects(api.load("600000", 260));
  fail = false;
  assert.equal((await api.load("600000", 260))[0].close, 11);
});

test("concurrent requests for the same daily history share one fetch", async () => {
  let count = 0;
  const api = klineContext(async () => {
    count++;
    return jsonResponse({ data: { klines: ["2026-11-05,10,11,12,9,100,1000"] } });
  });
  const [first, second] = await Promise.all([api.load("600000", 260), api.load("SH600000", 260)]);
  assert.equal(count, 1);
  assert.equal(first, second);
});

test("failed live batch quotes fall back to Tencent with the correct index symbol", async () => {
  const values = Array(40).fill("");
  Object.assign(values, { 3: "4050", 4: "4100", 30: "20261106140000", 32: "-1.22" });
  const body = new TextEncoder().encode(`v_sh000300="${values.join("~")}";`);
  const api = klineContext(async url => {
    if (url.includes("eastmoney")) throw new TypeError("Failed to fetch");
    assert.equal(url, "https://qt.gtimg.cn/q=sh000300");
    return { ok: true, arrayBuffer: async () => body.buffer };
  });
  const quotes = await api.quotes(["1.000300"]);
  assert.equal(quotes.get("1.000300").price, 4050);
  assert.equal(quotes.get("1.000300").time, Date.parse("2026-11-06T14:00:00+08:00"));
});

const sample = () => ({
  nav: { return_since_initial: 0, drawdown: 0 },
  snapshot: {
    total_assets: 10000, available_cash: 9000, frozen_cash: 0, captured_at: "2026-11-06T14:00:00+08:00",
    positions: [{ stock_code: "600000", quantity: 100, cost_price: 10, unrealized_pnl: 0 }],
  },
  orders: [],
});

function dashboardContext(api) {
  const fixedNow = Date.parse("2026-11-06T14:00:00+08:00");
  class TestDate extends Date {
    constructor(...args) { super(...(args.length ? args : [fixedNow])); }
    static now() { return fixedNow; }
  }
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      innerHTML: "", textContent: "", value: "", hidden: false,
      addEventListener() {}, replaceChildren() {}, close() {},
    });
    return elements.get(id);
  };
  const context = vm.createContext({
    document: { getElementById: element, addEventListener() {}, querySelectorAll: () => [] },
    window: { addEventListener() {} }, setInterval() {}, clearTimeout() {}, setTimeout() {},
    AstraKline: api, Map, Set, Date: TestDate, console,
  });
  vm.runInContext(dashboardSource, context);
  context.fixture = sample();
  vm.runInContext("data=fixture; renderPortfolio=()=>{}; drawReturnsChart=()=>{};", context);
  return { context, elements };
}

test("failed benchmark loading ends with a retry state rather than an endless spinner", async () => {
  const { context, elements } = dashboardContext({
    secid: code => code === "600000" ? "1.600000" : code,
    load: async () => { throw new Error("history unavailable"); },
    quotes: async () => new Map(),
  });
  await vm.runInContext("loadReturns(true)", context);
  assert.equal(vm.runInContext("returns.status", context), "ready");
  assert.equal(vm.runInContext("returns.view", context), null);
  const html = elements.get("returns-card").innerHTML;
  assert.match(html, /沪深300历史行情未取得/);
  assert.match(html, /data-retry-returns/);
  assert.doesNotMatch(html, /正在加载/);
});

test("missing holding prices withhold a reconstructed curve instead of dropping the position value", () => {
  const { context, elements } = dashboardContext({ secid: code => code === "600000" ? "1.600000" : code });
  vm.runInContext("returns.bars.set(HS300,[{date:'2026-11-05',close:4000},{date:'2026-11-06',close:4050}]); returns.status='ready'; computeReturns(); renderReturns();", context);
  assert.equal(vm.runInContext("returns.view", context), null);
  assert.match(elements.get("returns-card").innerHTML, /缺少历史估值价格/);
});

test("usable daily history still renders a curve when live quotes fail", async () => {
  const { context, elements } = dashboardContext({
    secid: code => code === "600000" ? "1.600000" : code,
    load: async code => [{ date: "2026-11-05", close: code === "600000" ? 9 : 4000 }, { date: "2026-11-06", close: code === "600000" ? 10 : 4050 }],
    quotes: async () => { throw new TypeError("quotes unavailable"); },
  });
  await vm.runInContext("loadReturns(true)", context);
  assert.equal(vm.runInContext("returns.view.last.equity", context), 10000);
  assert.equal(vm.runInContext("returns.view.todayPnl", context), 100);
  assert.match(elements.get("returns-card").innerHTML, /最近可用行情/);
  assert.doesNotMatch(elements.get("returns-card").innerHTML, /正在加载/);
});

test("an earlier daily history end is not labelled as today's profit", () => {
  const { context } = dashboardContext({ secid: code => code === "600000" ? "1.600000" : code });
  vm.runInContext("returns.bars.set(HS300,[{date:'2026-11-04',close:4000},{date:'2026-11-05',close:4050}]); returns.bars.set('1.600000',[{date:'2026-11-04',close:9},{date:'2026-11-05',close:10}]); computeReturns();", context);
  assert.equal(vm.runInContext("returns.view.todayPnl", context), null);
});

test("a history request finishing after logout cannot populate the next session", async () => {
  let complete;
  const history = new Promise(resolve => { complete = resolve; });
  let quoteCalls = 0;
  const { context } = dashboardContext({
    secid: code => code === "600000" ? "1.600000" : code,
    load: () => history,
    quotes: async () => { quoteCalls++; return new Map(); },
  });
  const request = vm.runInContext("loadReturns(true)", context);
  vm.runInContext("loggedOut()", context);
  complete([{ date: "2026-11-06", close: 10 }]);
  await request;
  assert.equal(vm.runInContext("returns.bars.size", context), 0);
  assert.equal(vm.runInContext("data", context), null);
  assert.equal(quoteCalls, 0);
});
