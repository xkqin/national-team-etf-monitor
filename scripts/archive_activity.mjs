import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { activityFor, intradayProfile, parseTrendLines } from "../public/core.js";
import { parseTencentDays } from "../public/minute-source.js";
import { summarizeDay, mergeRecords, JOURNAL_RULE } from "../public/journal.js";

const root = path.resolve(import.meta.dirname, "..");
const arg = name => process.argv[process.argv.indexOf(name) + 1];
if (!process.argv.includes("--input")) throw new Error("--input is required");
const archiveDir = process.argv.includes("--archive-dir") ? path.resolve(arg("--archive-dir")) : null;
const input = path.resolve(arg("--input"));
const snapshotFile = process.argv.includes("--snapshot") ? path.resolve(arg("--snapshot")) : path.join(root, "public/data/snapshot.json");
const destination = process.argv.includes("--output") ? path.resolve(arg("--output")) : path.join(root, "public/data/activity-history.json");
const json = async file => JSON.parse(await readFile(file, "utf8"));
const maybeJson = async file => { try { return await json(file); } catch (e) { if (e.code === "ENOENT") return null; throw e; } };
const pool = await json(path.join(root, "public/pool.json"));
const snapshot = await json(snapshotFile);
const previous = await maybeJson(archiveDir ? path.join(archiveDir, "history.json") : destination) || { version: 1, records: [] };
const raw = await maybeJson(input);
const funds = new Map();
for (const [symbol, item] of Object.entries(raw?.symbols || {})) {
  if (!item.payload) continue;
  try {
    funds.set(symbol, item.format === "tencent" ? parseTencentDays(item.payload, symbol) : parseTrendLines(item.payload.data?.trends));
  } catch { /* Missing/malformed feed is not an inactive day. */ }
}
const dates = [...new Set([...funds.values()].flatMap(days => [...days.keys()]))].sort();
const incoming = [];
for (const date of dates) {
  const minuteMap = Object.fromEntries(pool.map(f => [f.symbol, funds.get(f.symbol)?.get(date) || []]));
  const rows = pool.map(f => ({ ...f, profile: intradayProfile(snapshot.history[f.symbol]?.fiveMinute, date) }));
  const core = rows.filter(r => r.group === "沪深300");
  if (core.some(r => !r.profile || !minuteMap[r.symbol].length)) continue;
  const lastMinute = Math.min(...core.map(r => minuteMap[r.symbol].at(-1).minute));
  // Only actual completed minutes; historical closed sessions end at 240.
  const activity = activityFor(rows, minuteMap, lastMinute, null);
  const through = activity.observations?.at(-1)?.end;
  const poolCoverage = rows.filter(r => {
    const minutes = new Set(minuteMap[r.symbol].map(p => p.minute));
    return r.profile && through && Array.from({ length: through - 4 }, (_, i) => i + 5).every(t => minutes.has(t));
  }).length;
  const sources = [...new Set(pool.filter(f => minuteMap[f.symbol].length).map(f => raw.symbols[f.symbol]?.source).filter(Boolean))];
  const record = summarizeDay({ date, activity, lastMinute, poolCoverage, source: `${sources.join(" / ")} · 云端回放归档` });
  if (!record) continue;
  incoming.push(record);
  const retained = mergeRecords(previous.records, [record]).find(r => r.date === date);
  if (archiveDir && retained === record) {
    const evidence = { date, rule: JOURNAL_RULE, resolution: "1m", baseline: record.baseline,
      sources: Object.fromEntries(pool.map(f => [f.symbol, raw.symbols[f.symbol]?.source || "unavailable"])),
      rows: rows.map(({ symbol, group, profile }) => ({ symbol, group, profile })),
      minutes: Object.fromEntries(pool.map(f => [f.symbol, minuteMap[f.symbol].map(p => [p.minute, p.price, p.cumulative])])) };
    // Keep a fuller previous capture when today's feed regresses or drops funds.
    const file = path.join(archiveDir, "days", `${date}.json`);
    const old = await maybeJson(file);
    const size = e => Object.values(e.minutes).reduce((n, records) => n + records.length, 0);
    if (!old || size(evidence) >= size(old)) {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify(evidence) + "\n");
    }
  }
}
// Leave timestamps stable when the evidence did not change, avoiding needless archive commits.
for (const record of incoming) {
  const old = previous.records.find(r => r.date === record.date);
  if (old && JSON.stringify({ ...old, updatedAt: null }) === JSON.stringify({ ...record, updatedAt: null })) record.updatedAt = old.updatedAt;
}
const records = mergeRecords(previous.records, incoming);
if (!records.length) throw new Error("No usable calendar history. Existing archive preserved.");
const changed = JSON.stringify(records) !== JSON.stringify(previous.records);
const history = { version: 1, rule: JOURNAL_RULE, generatedAt: changed ? new Date().toISOString() : previous.generatedAt, records };
const body = JSON.stringify(history) + "\n";
await writeFile(destination, body);
if (archiveDir) await writeFile(path.join(archiveDir, "history.json"), body);
console.log(`Calendar: ${records.length} dated records, ${incoming.length} replayed; earliest ${records[0].date}; latest ${records.at(-1).date}.`);
