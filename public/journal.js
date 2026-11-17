import { ACTIVITY, chinaNow } from "./core.js?v=20261117a";

export const JOURNAL_RULE = "15m-v1";
// 09:50–11:30 and 13:15–14:56. Auctions and cross-lunch windows are excluded.
export const DAY_READINGS = 203;
export const DAY_LABELS = ["未见明显信号", "轻度试探", "温和发力", "积极进场", "明显加力"];

export function summarizeDay({ date, activity, lastMinute = 0, poolCoverage = 0, source = "云端分钟归档", now = new Date() }) {
  const observations = activity?.observations || [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "") || !observations.length) return null;
  const local = chinaNow(now);
  const ended = date < local.slice(0, 10) || (date === local.slice(0, 10) && local.slice(11, 16) >= "15:00");
  const covered = new Set(observations.map(p => p.end)).size;
  const full = lastMinute >= 240 && covered === DAY_READINGS && activity.historyComplete;
  const peak = activity.peak;
  const events = activity.events || [];
  const positiveReadings = observations.filter(p => p.grade > 0).length;
  return {
    date, rule: JOURNAL_RULE, grade: peak?.grade || 0, label: DAY_LABELS[peak?.grade || 0],
    status: ended ? full ? "complete" : "partial" : "collecting",
    covered, expected: DAY_READINGS, poolCoverage, lastMinute,
    through: observations.at(-1).clock, peak, shortPeak: activity.shortPeak || null,
    events, positiveReadings, source, updatedAt: now.toISOString(),
    baseline: "当日前最多20个完整交易日；至少5日；五分钟历史基线线性插值",
  };
}

// A failed/partial refresh cannot erase an already complete day or more extensive evidence.
export function mergeRecords(previous = [], incoming = []) {
  const records = new Map(previous.filter(r => /^\d{4}-\d{2}-\d{2}$/.test(r.date || "")).map(r => [r.date, r]));
  for (const next of incoming) {
    if (!next || !/^\d{4}-\d{2}-\d{2}$/.test(next.date || "")) continue;
    const old = records.get(next.date);
    const rank = r => (r.status === "complete" ? 1e6 : 0) + r.covered * 100 + (r.poolCoverage || 0);
    if (!old || rank(next) > rank(old) || (rank(next) === rank(old) && next.updatedAt >= old.updatedAt)) records.set(next.date, next);
  }
  return [...records.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export function daySentence(record) {
  if (!record) return "尚无可用记录。";
  if (!record.grade) return record.status === "complete" && record.poolCoverage === 23
    ? "全天未见达到阈值的15分钟量价信号。" : "已覆盖区间未见明显信号，尚不能代表全天。";
  const count = record.events.length;
  const peak = record.peak;
  return `${record.status === "collecting" ? "截至目前" : "当日已记录"} ${count} 段信号，最高${ACTIVITY.labels[record.grade]}。最强区间 ${peak.from}–${peak.clock}，${peak.scope}成交为历史同段的 ${peak.multiple.toFixed(2)} 倍。`;
}

export function monthCells(month) {
  const [year, index] = month.split("-").map(Number);
  const first = new Date(Date.UTC(year, index - 1, 1));
  const offset = (first.getUTCDay() + 6) % 7;
  const days = new Date(Date.UTC(year, index, 0)).getUTCDate();
  return [...Array(offset).fill(null), ...Array.from({ length: days }, (_, i) => `${month}-${String(i + 1).padStart(2, "0")}`)];
}
