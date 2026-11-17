import { ACTIVITY, chinaNow } from "./core.js?v=20261117b";

export const JOURNAL_RULE = "daily-persistence-v2";
// 09:50–11:30 and 13:15–14:56. Auctions and cross-lunch windows are excluded.
export const DAY_READINGS = 203;
export const DAY_LABELS = ["常态波动", "短时异动", "持续放量", "明显持续", "强烈持续"];

function episodes(points) {
  const output = [];
  for (const point of points) {
    let event = output.at(-1);
    if (!event || event.lastEnd !== point.end - 1) {
      event = { firstEnd: point.end, lastEnd: point.end, firstClock: point.clock, lastClock: point.clock, peak: point };
      output.push(event);
    } else {
      event.lastEnd = point.end; event.lastClock = point.clock;
      if (point.grade > event.peak.grade || (point.grade === event.peak.grade && point.multiple > event.peak.multiple)) event.peak = point;
    }
  }
  return output;
}

export function dailyEvidence(activity) {
  const peakBuying = points => points.filter(p => p.move >= ACTIVITY.minMove && p.rising / p.count >= .5)
    .sort((a, b) => b.multiple - a.multiple)[0] || null;
  const scopes = (activity.scopeReadings || []).map(readings => {
    const fifteen = new Map(readings.fifteen.map(p => [p.end, p]));
    // Two adjacent, NON-overlapping 15-minute windows and the enclosing 30-minute
    // window must qualify in the SAME fund group. A pool rally cannot stand in for core demand.
    const sustained = readings.thirty.flatMap(whole => {
      const a = fifteen.get(whole.end - 15), b = fifteen.get(whole.end);
      const grade = Math.min(a?.grade || 0, b?.grade || 0, whole.grade);
      return grade >= 2 ? [{ ...whole, grade }] : [];
    });
    return { scope: readings.scope, peak15: peakBuying(readings.fifteen), peak30: peakBuying(readings.thirty),
      covered15: readings.fifteen.length, covered30: readings.thirty.length, sustained: episodes(sustained) };
  });
  const sustainedGrade = Math.max(0, ...scopes.flatMap(s => s.sustained.map(e => e.peak.grade)));
  const points = (activity.observations || []).filter(p => p.grade >= 2);
  return { grade: sustainedGrade || (points.length ? 1 : 0), scopes,
    events: episodes(points), positiveReadings: points.length };
}

export function summarizeDay({ date, activity, lastMinute = 0, poolCoverage = 0, source = "云端分钟归档", now = new Date() }) {
  const observations = activity?.observations || [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "") || !observations.length) return null;
  const local = chinaNow(now);
  const ended = date < local.slice(0, 10) || (date === local.slice(0, 10) && local.slice(11, 16) >= "15:00");
  const covered = new Set(observations.map(p => p.end)).size;
  const full = lastMinute >= 240 && covered === DAY_READINGS && activity.historyComplete;
  const peak = activity.peak;
  const evidence = dailyEvidence(activity);
  const { events, positiveReadings } = evidence;
  return {
    date, rule: JOURNAL_RULE, grade: evidence.grade, label: DAY_LABELS[evidence.grade], scopeEvidence: evidence.scopes,
    status: ended ? full ? "complete" : "partial" : "collecting",
    covered, expected: DAY_READINGS, poolCoverage, lastMinute,
    through: observations.at(-1).clock, peak, shortPeak: activity.shortPeak || null,
    events, positiveReadings, rawEvents: activity.events || [], rawPositiveReadings: observations.filter(p => p.grade > 0).length,
    source, updatedAt: now.toISOString(),
    baseline: "当日前最多20个完整交易日；至少5日；五分钟历史基线线性插值",
  };
}

// A failed/partial refresh cannot erase an already complete day or more extensive evidence.
export function mergeRecords(previous = [], incoming = []) {
  const records = new Map(previous.filter(r => /^\d{4}-\d{2}-\d{2}$/.test(r.date || "")).map(r => [r.date, r]));
  for (const next of incoming) {
    if (!next || !/^\d{4}-\d{2}-\d{2}$/.test(next.date || "")) continue;
    const old = records.get(next.date);
    if (old && old.rule === JOURNAL_RULE && next.rule !== JOURNAL_RULE) continue;
    const rank = r => (r.status === "complete" ? 1e6 : 0) + r.covered * 100 + (r.poolCoverage || 0);
    if (!old || (old.rule !== JOURNAL_RULE && next.rule === JOURNAL_RULE) || rank(next) > rank(old) || (rank(next) === rank(old) && next.updatedAt >= old.updatedAt)) records.set(next.date, next);
  }
  return [...records.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export function daySentence(record) {
  if (!record) return "尚无可用记录。";
  if (!record.grade) return `${record.rawPositiveReadings ? "仅见低门槛短窗波动，未达到日级异动门槛。" : "已覆盖区间未见达到日级门槛的量价异动。"}${record.status === "complete" && record.poolCoverage === 23 ? "" : "覆盖尚不完整，不能代表全天。"}`;
  const count = record.events.length;
  const peak = record.peak;
  const conclusion = record.grade === 1 ? "仅见短时异动，尚未形成同组连续30分钟放量。" : `出现${DAY_LABELS[record.grade]}，同组两个相邻15分钟区间及其30分钟整体均达到条件。`;
  return `${conclusion}${record.status === "collecting" ? "截至目前" : "当日记录"} ${count} 段异动；最强15分钟 ${peak.from}–${peak.clock}，${peak.scope} ${peak.multiple.toFixed(2)} 倍。`;
}

export function monthCells(month) {
  const [year, index] = month.split("-").map(Number);
  const first = new Date(Date.UTC(year, index - 1, 1));
  const offset = (first.getUTCDay() + 6) % 7;
  const days = new Date(Date.UTC(year, index, 0)).getUTCDate();
  return [...Array(offset).fill(null), ...Array.from({ length: days }, (_, i) => `${month}-${String(i + 1).padStart(2, "0")}`)];
}
