import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { activityFor, clockFor } from "../public/core.js";
import { summarizeDay, mergeRecords, monthCells, daySentence, DAY_READINGS } from "../public/journal.js";

function fixture(ratio = 1, length = 240) {
  const profile = { points: Array.from({ length: 49 }, (_, i) => i * 5e7), days: 20 };
  const rows = Array.from({ length: 4 }, (_, i) => ({ symbol: `core${i}`, group: "沪深300", profile }));
  const minuteMap = Object.fromEntries(rows.map(row => [row.symbol, Array.from({ length: length + 1 }, (_, minute) => ({
    minute, clock: clockFor(minute), price: 4 * (1 + minute * .0001), cumulative: minute * ratio * 1e7,
  }))]));
  return { rows, minuteMap };
}
function record(ratio = 1, length = 240, now = "2026-11-17T15:10:00+08:00") {
  const { rows, minuteMap } = fixture(ratio, length);
  const activity = activityFor(rows, minuteMap, length);
  return summarizeDay({ date: "2026-11-17", activity, lastMinute: length, poolCoverage: 23, now: new Date(now) });
}

test("daily summary uses 15-minute episodes and does not double-count overlapping windows", () => {
  const result = record(2.1);
  assert.equal(result.status, "complete");
  assert.equal(result.grade, 3);
  assert.equal(result.covered, DAY_READINGS);
  assert.equal(result.events.length, 2, "morning and afternoon are separate episodes");
  assert.equal(result.positiveReadings, DAY_READINGS);
  assert.match(daySentence(result), /2 段信号/);
});

test("a quiet completed day is different from missing or incomplete evidence", () => {
  const quiet = record();
  assert.equal(quiet.grade, 0);
  assert.match(daySentence(quiet), /全天未见/);
  assert.equal(summarizeDay({ date: "2026-11-17", activity: { observations: [] } }), null);
  const partial = record(1, 100);
  assert.equal(partial.status, "partial");
  assert.match(daySentence(partial), /尚不能代表全天/);
});

test("intraday readings remain provisional until actual final minute is received", () => {
  assert.equal(record(2, 100, "2026-11-17T11:15:00+08:00").status, "collecting");
  assert.equal(record(2, 236).status, "partial");
});

test("gaps cannot produce a complete daily summary", () => {
  const { rows, minuteMap } = fixture(2);
  minuteMap.core0 = minuteMap.core0.filter(p => p.minute !== 75);
  const activity = activityFor(rows, minuteMap, 240);
  const result = summarizeDay({ date: "2026-11-16", activity, lastMinute: 240 });
  assert.equal(result.status, "partial");
  assert.ok(result.covered < DAY_READINGS);
});

test("archive merge preserves old dates and a complete day during partial refreshes", () => {
  const full = record(2);
  const partial = { ...record(2, 100), updatedAt: "2099-01-01T00:00:00Z" };
  const older = { ...full, date: "2026-11-16" };
  const merged = mergeRecords([older, full], [partial]);
  assert.equal(merged.length, 2);
  assert.equal(merged[1].status, "complete");
  assert.equal(mergeRecords([partial], [full])[0].status, "complete");
});

test("calendar aligns Monday first, including leap February and year boundary", () => {
  const november = monthCells("2026-11");
  assert.equal(november[6], "2026-11-01");
  assert.equal(november.at(-1), "2026-11-30");
  assert.equal(monthCells("2028-02").filter(Boolean).length, 29);
  assert.equal(monthCells("2027-01").filter(Boolean).length, 31);
});

test("backfilled daily records have real dates and consistent episode/coverage counts", async () => {
  const history = JSON.parse(await readFile(new URL("../public/data/activity-history.json", import.meta.url), "utf8"));
  assert.ok(history.records.length >= 4);
  assert.equal(new Set(history.records.map(r => r.date)).size, history.records.length);
  for (const r of history.records) {
    assert.equal(r.grade, Math.max(0, ...r.events.map(e => e.peak.grade)));
    assert.ok(r.covered <= DAY_READINGS && r.positiveReadings <= r.covered);
    assert.equal(r.positiveReadings, r.events.reduce((sum, e) => sum + e.lastEnd - e.firstEnd + 1, 0));
    if (r.status === "complete") assert.equal(r.covered, DAY_READINGS);
  }
});

test("archive CLI preserves every saved date when all providers are unavailable", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "etf-archive-test-"));
  try {
    const previous = await readFile(new URL("../public/data/activity-history.json", import.meta.url), "utf8");
    await writeFile(path.join(directory, "history.json"), previous);
    const output = path.join(directory, "published.json");
    const child = spawnSync(process.execPath, [fileURLToPath(new URL("../scripts/archive_activity.mjs", import.meta.url)),
      "--input", path.join(directory, "unavailable.json"), "--archive-dir", directory, "--output", output], { encoding: "utf8" });
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(await readFile(output, "utf8")), JSON.parse(previous));
    assert.deepEqual(JSON.parse(await readFile(path.join(directory, "history.json"), "utf8")), JSON.parse(previous));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
