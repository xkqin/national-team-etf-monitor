"""Collect attributable public quotes and history for a static GitHub Pages site."""

import concurrent.futures
import datetime as dt
import json
import pathlib
import re
import time
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]
PUBLIC = ROOT / "public"
POOL = json.loads((PUBLIC / "pool.json").read_text(encoding="utf-8"))


def request(url):
    for attempt in range(3):
        try:
            req = urllib.request.Request(url, headers={
                "User-Agent": "Mozilla/5.0 ETF-Observation/1.0",
                "Referer": "https://quote.eastmoney.com/",
            })
            with urllib.request.urlopen(req, timeout=25) as response:
                raw = response.read()
                try:
                    return raw.decode("utf-8")
                except UnicodeDecodeError:
                    return raw.decode("gb18030")
        except Exception:
            if attempt == 2:
                raise
            time.sleep(attempt + 1)


def history_for(fund):
    market = "1" if fund["symbol"].startswith("sh") else "0"
    base = ("https://push2his.eastmoney.com/api/qt/stock/kline/get?"
            f"secid={market}.{fund['code']}&fqt=0&end=20500101"
            "&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57")
    result = {}
    for key, period, limit in [("daily", 101, 280), ("fiveMinute", 5, 1100)]:
        try:
            payload = json.loads(request(f"{base}&klt={period}&lmt={limit}"))
            lines = (payload.get("data") or {}).get("klines", [])
            rows = [line.split(",") for line in lines]
            result[key] = [[row[0], float(row[6]), float(row[2])] for row in rows]
            if not rows:
                result.setdefault("errors", []).append(f"{key} empty")
        except Exception as error:
            result[key] = []
            result.setdefault("errors", []).append(f"{key}: {type(error).__name__}")
    return fund["symbol"], result


def main():
    symbols = ",".join(fund["symbol"] for fund in POOL)
    text = request("https://qt.gtimg.cn/q=" + symbols)
    quotes = {symbol: value.split("~") for symbol, value in re.findall(r'v_(\w+)="([^"]*)"', text)}
    quotes = {symbol: fields for symbol, fields in quotes.items() if len(fields) > 37 and re.fullmatch(r"\d{14}", fields[30])}
    if not quotes:
        raise RuntimeError("No valid quotes received. Existing snapshot preserved.")
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as executor:
        history = dict(executor.map(history_for, POOL))
    data = {
        "version": 1,
        "generatedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
        "sources": {"quotes": "https://qt.gtimg.cn", "history": "https://push2his.eastmoney.com"},
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
