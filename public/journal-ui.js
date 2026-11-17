import { activityFor, chinaNow } from "./core.js?v=20261117a";
import { summarizeDay, mergeRecords, monthCells, daySentence, DAY_LABELS } from "./journal.js?v=20261117a";

const $ = id => document.getElementById(id);
const esc = value => String(value).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const shortLabels = ["平静", "轻度", "温和", "积极", "强力"];
const statusLabel = { complete: "收盘归档", partial: "覆盖不全", collecting: "盘中暂计" };
const weekday = date => new Date(`${date}T12:00:00Z`).getUTCDay();
const dateLabel = date => `${Number(date.slice(5, 7))}月${Number(date.slice(8))}日`;

export function createJournal() {
  const today = () => chinaNow().slice(0, 10);
  let records = [], month = today().slice(0, 7), selected = today(), liveSignature = "", loadedAt = 0, loading = false, error = "";
  const byDate = () => new Map(records.map(r => [r.date, r]));

  function render() {
    const index = byDate();
    const dates = records.map(r => r.date);
    const earliest = dates[0]?.slice(0, 7) || today().slice(0, 7);
    $("calendar-month").textContent = `${month.slice(0, 4)} 年 ${Number(month.slice(5))} 月`;
    $("calendar-prev").disabled = month <= earliest;
    $("calendar-next").disabled = month >= today().slice(0, 7);
    const monthRecords = records.filter(r => r.date.startsWith(month));
    const active = monthRecords.filter(r => r.grade > 0).length;
    $("calendar-stats").textContent = monthRecords.length ? `已记录 ${monthRecords.length} 天 · ${active} 天有信号` : "这个月尚无归档";
    // Keep keyboard focus on the selected date when a background update redraws the month.
    const focusDate = document.activeElement?.dataset?.date;
    $("calendar-days").innerHTML = monthCells(month).map(date => {
      if (!date) return '<span class="calendar-blank" aria-hidden="true"></span>';
      const record = index.get(date);
      const future = date > today(), weekend = [0, 6].includes(weekday(date));
      const label = record ? shortLabels[record.grade] : future ? "—" : weekend ? "周末" : "未归档";
      const title = `${date}，${record ? `${record.label}，${statusLabel[record.status]}` : future ? "未来日期" : weekend ? "周末" : "尚无记录，不能判断是否出现信号"}`;
      return `<button type="button" class="calendar-day ${record ? `grade-${record.grade}` : "is-empty"}${date === selected ? " selected" : ""}${date === today() ? " today" : ""}" data-date="${date}" aria-label="${esc(title)}" aria-pressed="${date === selected}"${future ? " disabled" : ""}><b>${Number(date.slice(8))}</b><span>${label}</span>${record && record.status !== "complete" ? '<i aria-hidden="true"></i>' : ""}</button>`;
    }).join("");
    if (focusDate) $("calendar-days").querySelector(`[data-date="${focusDate}"]`)?.focus({ preventScroll: true });
    renderDay(index.get(selected));
    $("calendar-load-state").textContent = error || (loadedAt ? `云端归档 ${dates[0] || "—"} 起 · 盘中自动更新，收盘后归档` : "正在读取云端历史…");
    $("calendar-retry").hidden = !error;
  }

  function renderDay(record) {
    $("journal-date").textContent = `${selected} · ${record ? statusLabel[record.status] : "尚无记录"}`;
    $("journal-title").textContent = record ? `${dateLabel(selected)}，${DAY_LABELS[record.grade]}` : `${dateLabel(selected)}，尚无记录`;
    $("journal-title").className = `journal-title grade-${record?.grade ?? "unknown"}`;
    $("journal-sentence").textContent = record ? daySentence(record) : [0, 6].includes(weekday(selected))
      ? "周末不生成交易信号。" : "这一天尚未归档，无法判断是否有动作；空白不代表没有上班。";
    $("journal-metrics").innerHTML = [
      ["最高强度", record ? `${record.grade}<small> / 4</small>` : "—"],
      ["信号段数", record ? `${record.events.length}<small> 段</small>` : "—"],
      ["信号读数时长", record ? `${record.positiveReadings}<small> 分钟</small>` : "—"],
    ].map(([label, value]) => `<div><span>${label}</span><strong>${value}</strong></div>`).join("");
    const peak = record?.peak;
    $("journal-peak").textContent = peak ? `最强区间 ${peak.from}–${peak.clock} · ${peak.scope} ${peak.multiple.toFixed(2)}× · 区间涨幅 ${(peak.move * 100).toFixed(2)}%` : "";
    $("journal-events").innerHTML = record?.events.length ? record.events.map(event => `<li><time>${esc(event.firstClock)}${event.lastClock !== event.firstClock ? `–${esc(event.lastClock)}` : ""}</time><div><b>${esc(DAY_LABELS[event.peak.grade])}</b><span>${esc(event.peak.scope)} · 最强 ${event.peak.multiple.toFixed(2)}× · ${esc(event.peak.from)}–${esc(event.peak.clock)}</span></div></li>`).join("") : '<li class="journal-empty">没有可展示的信号段。</li>';
    $("journal-quality").textContent = record
      ? `${record.source} · 主力有效读数 ${record.covered} / ${record.expected} · 全池连续覆盖 ${record.poolCoverage} / 23 只 · 截至 ${record.through}。${record.status === "partial" ? "覆盖不全，不能据此否定其他时段的动作。" : ""}`
      : "近期可取得的真实分钟数据用于回补，较早的空白日期不作推断。";
  }

  async function load() {
    if (loading) return;
    loading = true;
    try {
      const response = await fetch(`./data/activity-history.json?_=${Date.now()}`, { cache: "no-store", signal: AbortSignal.timeout(12_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const history = await response.json();
      if (history.version !== 1 || !Array.isArray(history.records)) throw new Error("归档格式不正确");
      records = mergeRecords(records, history.records);
      loadedAt = Date.now();
      error = "";
    } catch {
      error = "云端历史暂时取不到，保留已加载记录。可点击重试。";
    } finally {
      loading = false;
      render();
    }
  }
  $("calendar-days").addEventListener("click", event => {
    const button = event.target.closest("[data-date]");
    if (!button || button.disabled) return;
    selected = button.dataset.date;
    render();
  });
  for (const [id, delta] of [["calendar-prev", -1], ["calendar-next", 1]]) $(id).addEventListener("click", () => {
    const [year, m] = month.split("-").map(Number);
    month = new Date(Date.UTC(year, m - 1 + delta, 1)).toISOString().slice(0, 7);
    selected = records.filter(r => r.date.startsWith(month)).at(-1)?.date || `${month}-01`;
    render();
  });
  $("calendar-today").addEventListener("click", () => { selected = today(); month = selected.slice(0, 7); render(); });
  $("calendar-retry").addEventListener("click", load);
  render();
  load();
  setInterval(load, 10 * 60_000);

  return {
    update(view) {
      const { summary, market, minuteMap } = view;
      if (!summary.complete || !summary.coherent || !minuteMap || (market.session && !market.fresh)) return;
      const signature = `${summary.date}:${Math.floor(summary.minute)}:${summary.profileRange?.to}:` + summary.rows.map(r => `${r.symbol}:${minuteMap[r.symbol]?.at(-1)?.cumulative}`).join("|");
      if (signature === liveSignature) return;
      liveSignature = signature;
      // Daily replay uses a fixed linear historical baseline so saved and browser summaries agree.
      const activity = activityFor(summary.rows, minuteMap, summary.minute, null);
      const through = activity.observations.at(-1)?.end;
      const core = summary.rows.filter(r => r.group === "沪深300");
      const lastMinute = Math.min(...core.map(r => minuteMap[r.symbol]?.at(-1)?.minute ?? 0));
      const poolCoverage = summary.rows.filter(r => {
        const minutes = new Set((minuteMap[r.symbol] || []).map(p => p.minute));
        return r.profile && through && Array.from({ length: through - 4 }, (_, i) => i + 5).every(t => minutes.has(t));
      }).length;
      const record = summarizeDay({ date: summary.date, activity, lastMinute, poolCoverage, source: "浏览器逐分钟 · 盘中暂计" });
      if (!record) return;
      // A browser preview never replaces a completed cloud archive for a past date.
      if (records.some(r => r.date === record.date && r.status === "complete")) return;
      records = mergeRecords(records, [record]);
      render();
    },
  };
}
