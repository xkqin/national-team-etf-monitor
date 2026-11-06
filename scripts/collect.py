"""Collect attributable public quotes and history for a static GitHub Pages site."""

import concurrent.futures
import datetime as dt
import json
import pathlib
import re
import sys
import time
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]
PUBLIC = ROOT / "public"
POOL = json.loads((PUBLIC / "pool.json").read_text(encoding="utf-8"))


def request(url, timeout=12, attempts=2):
    for attempt in range(attempts):
        try:
            req = urllib.request.Request(url, headers={
                "User-Agent": "Mozilla/5.0 ETF-Observation/1.0",
                "Referer": "https://gu.qq.com/" if "gtimg.cn/" in url else "https://quote.eastmoney.com/",
            })
            with urllib.request.urlopen(req, timeout=timeout) as response:
                raw = response.read()
                try:
                    return raw.decode("utf-8")
                except UnicodeDecodeError:
                    return raw.decode("gb18030")
        except Exception:
            if attempt == attempts - 1:
                raise
            time.sleep(attempt + 1)


def usable_history(snapshot):
    history = snapshot.get("history", {})
    return all(len(history.get(fund["symbol"], {}).get("daily", [])) >= 200
               and len(history.get(fund["symbol"], {}).get("fiveMinute", [])) >= 240 for fund in POOL)


def previous_snapshot():
    candidates = []
    destination = PUBLIC / "data" / "snapshot.json"
    if destination.exists():
        local = json.loads(destination.read_text(encoding="utf-8"))
        if usable_history(local):
            candidates.append(local)
    try:
        remote = json.loads(request("https://xkqin.github.io/national-team-etf-monitor/data/snapshot.json", timeout=10, attempts=1))
        if usable_history(remote):
            candidates.append(remote)
    except Exception:
        pass
    return max(candidates, key=lambda item: item.get("generatedAt", ""), default={})


def minute_bars(fund):
    payload = json.loads(request("https://web.ifzq.gtimg.cn/appstock/app/minute/query?code=" + fund["symbol"]))
    minute = payload["data"][fund["symbol"]]["data"]
    date = dt.datetime.strptime(minute["date"], "%Y%m%d").strftime("%Y-%m-%d")
    records = {line.split()[0]: line.split() for line in minute["data"]}
    previous = 0
    bars = []
    for index in range(48):
        minutes = 575 + index * 5 if index < 24 else 785 + (index - 24) * 5
        clock = f"{minutes // 60:02d}{minutes % 60:02d}"
        if clock >= max(records, default="0000") and clock not in ("1130", "1500"):
            break
        record = records.get(clock)
        if record is None:
            break
        amount = float(record[3])
        if amount < previous:
            break
        bars.append([f"{date} {clock[:2]}:{clock[2:]}", amount - previous, float(record[1])])
        previous = amount
    return date, bars


def archive_rows(fund, period, limit):
    market = "1" if fund["symbol"].startswith("sh") else "0"
    url = ("https://push2his.eastmoney.com/api/qt/stock/kline/get?"
           f"secid={market}.{fund['code']}&fqt=0&end=20500101&klt={period}&lmt={limit}"
           "&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57")
    payload = json.loads(request(url))
    lines = (payload.get("data") or {}).get("klines", [])
    if not lines:
        raise ValueError("Empty archive response")
    rows = [line.split(",") for line in lines]
    return [[row[0], float(row[6]), float(row[2])] for row in rows]


def history_for(fund, previous, fields, refresh_archive=False):
    result = {
        "daily": previous.get("daily", []),
        "fiveMinute": previous.get("fiveMinute", []),
    }
    if refresh_archive or not all(result.values()):
        for key, period, limit in [("daily", 101, 280), ("fiveMinute", 5, 1100)]:
            try:
                result[key] = archive_rows(fund, period, limit)
            except Exception as error:
                result.setdefault("errors", []).append(f"{key}: {type(error).__name__}")
    if fields:
        date = dt.datetime.strptime(fields[30][:8], "%Y%m%d").strftime("%Y-%m-%d")
        daily = {row[0]: row for row in result["daily"]}
        daily[date] = [date, float(fields[37]) * 10000, float(fields[3])]
        result["daily"] = sorted(daily.values())[-280:]
    try:
        date, bars = minute_bars(fund)
        if bars:
            retained = [row for row in result["fiveMinute"] if row[0][:10] != date]
            result["fiveMinute"] = sorted(retained + bars)[-1100:]
    except Exception as error:
        try:
            result["fiveMinute"] = archive_rows(fund, 5, 1100)
        except Exception:
            result.setdefault("errors", []).append(f"minute: {type(error).__name__}")
    if fields:
        minute = int(fields[30][8:10]) * 60 + int(fields[30][10:12])
        completed = 900 if minute >= 900 else 690 if 690 <= minute <= 780 else (minute - 1) // 5 * 5
        cutoff = f"{completed // 60:02d}:{completed % 60:02d}"
        result["fiveMinute"] = [row for row in result["fiveMinute"] if row[0][:10] < date or (row[0][:10] == date and row[0][11:16] <= cutoff)]
    return fund["symbol"], result


def main():
    symbols = ",".join(fund["symbol"] for fund in POOL)
    text = request("https://qt.gtimg.cn/q=" + symbols)
    quotes = {symbol: value.split("~") for symbol, value in re.findall(r'v_(\w+)="([^"]*)"', text)}
    quotes = {symbol: fields for symbol, fields in quotes.items() if len(fields) > 37 and re.fullmatch(r"\d{14}", fields[30])}
    if not quotes:
        raise RuntimeError("No valid quotes received. Existing snapshot preserved.")
    previous = previous_snapshot()

    def collect_fund(fund):
        retained = previous.get("history", {}).get(fund["symbol"], {})
        return history_for(fund, retained, quotes.get(fund["symbol"]), "--refresh-archive" in sys.argv)

    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as executor:
        history = dict(executor.map(collect_fund, POOL))
    if not usable_history({"history": history}):
        raise RuntimeError("Historical coverage is insufficient. Existing snapshot preserved.")
    data = {
        "version": 1,
        "generatedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
        "sources": {"quotes": "https://qt.gtimg.cn", "history": ["https://push2his.eastmoney.com", "https://web.ifzq.gtimg.cn"]},
        "quotes": quotes,
        "history": history,
    }
    destination = PUBLIC / "data" / "snapshot.json"
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(".tmp")
    temporary.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    temporary.replace(destination)
    errors = sum(bool(item.get("errors")) for item in history.values())
    print(f"Collected {len(quotes)}/{len(POOL)} quotes, {len(history)} histories, {errors} histories with errors.")
    print(f"Snapshot {data['generatedAt']}, {destination.stat().st_size:,} bytes")


if __name__ == "__main__":
    main()
