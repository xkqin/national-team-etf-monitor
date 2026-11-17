"""Fetch dated, genuine minute records for calendar backfill and durable daily archives."""
import concurrent.futures
import json
import pathlib
import sys
from collect import POOL, request


def fetch_fund(fund):
    symbol = fund["symbol"]
    try:
        payload = json.loads(request("https://web.ifzq.gtimg.cn/appstock/app/day/query?code=" + symbol))
        if not payload.get("data", {}).get(symbol, {}).get("data"):
            raise ValueError("Empty minute days")
        return symbol, {"format": "tencent", "source": "腾讯五日逐分钟", "payload": payload}
    except Exception:
        try:
            secid = ("1" if symbol.startswith("sh") else "0") + "." + fund["code"]
            url = ("https://push2his.eastmoney.com/api/qt/stock/trends2/get?secid=" + secid
                   + "&fields1=f1&fields2=f51,f52,f53,f56,f57&ndays=5&iscr=0")
            payload = json.loads(request(url))
            if not (payload.get("data") or {}).get("trends"):
                raise ValueError("Empty minute days")
            return symbol, {"format": "eastmoney", "source": "东方财富五日逐分钟", "payload": payload}
        except Exception as error:
            return symbol, {"error": type(error).__name__}


def main():
    destination = pathlib.Path(sys.argv[1])
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as executor:
        symbols = dict(executor.map(fetch_fund, POOL))
    valid = sum("payload" in item for item in symbols.values())
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps({"symbols": symbols}, ensure_ascii=False), encoding="utf-8")
    print(f"Calendar minute feeds: {valid}/{len(POOL)}. Missing feeds remain unknown.")
    if not valid:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
