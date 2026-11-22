import asyncio
from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

from .market import FIXTURE_DATE, iso_time

WATCH_DAYS = 14
NEWS_DAYS = 45
MINIMUM_MOVE = 3


async def company_news(tools, ticker, mode, now=None):
    releases, filings = await asyncio.gather(
        tools.call("get_press_releases", ticker=ticker), tools.call("get_recent_filings", ticker=ticker),
        return_exceptions=True,
    )
    through = datetime.combine(FIXTURE_DATE, datetime.max.time(), UTC) if mode == "demo" else now or datetime.now(UTC)
    since = (through.date() - timedelta(days=NEWS_DAYS - 1)).isoformat()
    items = []
    if isinstance(releases, dict):
        for item in releases["releases"]:
            published = item["publishedAt"]
            if published[:10] >= since and datetime.fromisoformat(published) <= through:
                items.append({"kind": "release", **item})
    if isinstance(filings, dict):
        for item in filings["filings"]:
            published = datetime.fromisoformat(item["date"]).replace(tzinfo=UTC)
            if item["date"] >= since and published <= through:
                items.append({"kind": "filing", "form": item["form"], "url": item["url"], "publishedAt": iso_time(published)})
    items.sort(key=lambda item: datetime.fromisoformat(item["publishedAt"]), reverse=True)
    unique = {}
    for item in items:
        key = item["title"].lower() if item["kind"] == "release" else item["url"] or item["form"] + item["publishedAt"]
        unique.setdefault(key, item)
    return {
        "items": list(unique.values())[:6], "marketMode": mode, "days": NEWS_DAYS,
        "unavailable": {"releases": not isinstance(releases, dict), "filings": not isinstance(filings, dict)},
    }


def daily_moves(ticker, prices, start, end):
    for previous, current in zip(prices, prices[1:]):
        day, close = current["date"], current["close"]
        if start <= day <= end:
            change = round((close / previous["close"] - 1) * 100, 2)
            if abs(change) >= MINIMUM_MOVE:
                yield {"ticker": ticker, "kind": "price", "date": day, "change": change, "close": close}


async def watchlist_updates(tools, tickers, mode, now=None):
    exchange_time = (now or datetime.now(UTC)).astimezone(ZoneInfo("America/New_York"))
    end = FIXTURE_DATE if mode == "demo" else exchange_time.date()
    # After 5 p.m. Eastern, daily bars are past the regular US trading session.
    price_end = end if mode == "demo" or exchange_time.hour >= 17 else end - timedelta(days=1)
    start = (end - timedelta(days=WATCH_DAYS - 1)).isoformat()
    end, price_end = end.isoformat(), price_end.isoformat()

    async def get_updates(ticker):
        return await asyncio.gather(
            tools.call("get_price_history", ticker=ticker), tools.call("get_recent_filings", ticker=ticker),
            return_exceptions=True,
        )

    results = await asyncio.gather(*(get_updates(ticker) for ticker in tickers))
    events = []
    unavailable = {"prices": [], "filings": []}
    for ticker, (history, reports) in zip(tickers, results):
        prices = history["prices"] if isinstance(history, dict) else []
        if any(start <= price["date"] <= price_end for price in prices):
            events.extend(daily_moves(ticker, prices, start, price_end))
        else:
            unavailable["prices"].append(ticker)
        if isinstance(reports, dict):
            events.extend({"ticker": ticker, "kind": "filing", **item} for item in reports["filings"] if start <= item["date"] <= end)
        else:
            unavailable["filings"].append(ticker)

    events.sort(key=lambda event: (event["ticker"], event["kind"]))
    events.sort(key=lambda event: event["date"], reverse=True)
    return {"events": events[:20], "total": len(events), "unavailable": unavailable, "days": WATCH_DAYS, "minimumMove": MINIMUM_MOVE}
