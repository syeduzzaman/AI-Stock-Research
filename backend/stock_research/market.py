import asyncio
import math
import os
import re
from collections import Counter
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from html import unescape
from time import monotonic

FIXTURE_DATE = date(2025, 3, 31)
SEC_ARCHIVES = "https://www.sec.gov/Archives/edgar/data"
TICKER_DATE = re.compile(r"\d{4}-\d{2}-\d{2}")
REPORT_FORM = re.compile(r"(8-K|10-Q|10-K)(/A)?")


@dataclass(frozen=True, slots=True)
class Stock:
    ticker: str
    name: str
    sector: str
    cik: int
    seed: int
    nasdaq: bool = True

    def public(self):
        return {"ticker": self.ticker, "name": self.name, "sector": self.sector,
                "indexes": ["nasdaq", "sp500"] if self.nasdaq else ["sp500"]}


STOCKS = {stock.ticker: stock for stock in (
    Stock("NVDA", "NVIDIA", "Semiconductors", 1045810, 83),
    Stock("MU", "Micron Technology", "Semiconductors", 723125, 54),
    Stock("MSFT", "Microsoft", "Software", 789019, 94),
    Stock("AAPL", "Apple", "Consumer technology", 320193, 72),
    Stock("AMD", "Advanced Micro Devices", "Semiconductors", 2488, 47),
    Stock("AMZN", "Amazon", "Retail & cloud", 1018724, 79),
    Stock("GOOGL", "Alphabet", "Internet services", 1652044, 86),
    Stock("META", "Meta Platforms", "Internet services", 1326801, 76),
    Stock("AVGO", "Broadcom", "Semiconductors", 1730168, 66),
    Stock("TSLA", "Tesla", "Automotive", 1318605, 28),
    Stock("JPM", "JPMorgan Chase", "Banking", 19617, 65, False),
    Stock("XOM", "Exxon Mobil", "Energy", 34088, 33, False),
)}
FEATURED = ("NVDA", "AAPL", "MSFT", "TSLA")


def iso_time(value: datetime) -> str:
    return value.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def is_number(value) -> bool:
    return type(value) in (int, float) and abs(value) <= 1.7976931348623157e308


def demo_prices(stock):
    dates = []
    day = FIXTURE_DATE
    while len(dates) < 140:
        if day.weekday() < 5:
            dates.append(day.isoformat())
        day -= timedelta(days=1)
    values = []
    for index, session in enumerate(reversed(dates)):
        curve = math.sin(index / 5 + stock.seed) * 3 + math.cos(index * 1.37) * 1.7
        drift = index * (stock.seed - 52) / 240
        values.append({"date": session, "close": round(90 + stock.seed * 0.72 + curve + drift, 2)})
    return values


def demo_passages(stock):
    demand = ("Demand improved and the company increased production commitments." if stock.seed > 70
              else "Demand was uneven and the company kept its prior production guidance.")
    passages = [
        ("Demo quarterly report · Outlook", demand + " Management noted that a material portion of the next quarter's revenue depends on shipment timing."),
        ("Demo annual report · Risk factors", "Customer concentration and industry pricing are material risks. A slowdown could reduce margins and increase inventory even if reported sales remain steady."),
        ("Demo quarterly report · Liquidity", "Management expects operations and available cash to fund planned capital spending. Debt maturities and refinancing remain sensitive to market conditions."),
        ("Demo quarterly report · Investment", "Capital expenditure is directed towards capacity and new products. Competitor investment could take market share and lead to price competition."),
        ("Demo quarterly report · Market conditions", "Interest rates, foreign exchange and customer budgets affect demand. The timing and cost of financing are uncertain."),
    ]
    return [{"id": f"filing-{index}", "title": title, "date": FIXTURE_DATE.isoformat(),
             "text": f"Synthetic {stock.ticker} example. {text}", "url": None}
            for index, (title, text) in enumerate(passages, 1)]


def rank_passages(passages, query, limit=3):
    word = re.compile(r"[a-z]{3,}")
    terms = set(word.findall(query.lower()))
    rows = [(passage, Counter(word.findall(passage["text"].lower()))) for passage in passages]
    frequency = {term: sum(term in tokens for _, tokens in rows) for term in terms}
    weights = {term: math.log1p((len(rows) - count + 0.5) / (count + 0.5)) for term, count in frequency.items()}
    ranked = []
    for passage, tokens in rows:
        length = tokens.total()
        score = sum(weights[term] * tokens[term] / (tokens[term] + 0.6 + 0.006 * length) for term in terms)
        if score > 0:
            ranked.append((score, passage))
    return [passage for _, passage in sorted(ranked, key=lambda entry: entry[0], reverse=True)[:limit]]


def segments(html):
    text = re.sub(r"<(script|style|ix:hidden)\b[^>]*>[\s\S]*?</\1>", " ", html, flags=re.I)
    text = re.sub(r"</(?:div|p|tr|li|h[1-6])>", "\n", text, flags=re.I)
    text = unescape(re.sub(r"<[^>]*>", " ", text))
    passages = []
    for line in text.splitlines():
        line = " ".join(line.split())
        if len(line) >= 100:
            passages.extend(part.strip() for part in re.findall(r".{1,1100}(?:\s|$)|.{1,1100}", line))
        if len(passages) >= 3600:
            break
    return passages[:3600]


def latest_fact(gaap, tags, annual=False):
    candidates = []
    for tag in tags:
        for row in gaap.get(tag, {}).get("units", {}).get("USD", []):
            if row.get("form") not in ("10-K", "10-Q", "10-K/A", "10-Q/A") or not is_number(row.get("val")):
                continue
            start, end = row.get("start"), row.get("end")
            if not end or bool(start) != annual:
                continue
            if annual and not 330 <= (date.fromisoformat(end) - date.fromisoformat(start)).days <= 390:
                continue
            candidates.append(row)
    if not candidates:
        return None
    row = max(candidates, key=lambda item: (item["end"], item.get("filed", "")))
    return {"value": row["val"], "period_end": row["end"], "filed": row.get("filed")}


class MarketData:
    def __init__(self, client):
        self.client = client
        self.mode = "live" if os.environ.get("MARKET_DATA_MODE") == "live" else "demo"
        self.twelve_key = os.environ.get("TWELVE_DATA_API_KEY")
        self.sec_user_agent = os.environ.get("SEC_USER_AGENT")
        self.cache = {}
        self.next_sec_request = 0

    async def cached(self, key, ttl, load):
        entry = self.cache.get(key)
        if entry and (not entry[1].done() or entry[0] > monotonic()):
            return await asyncio.shield(entry[1])
        task = asyncio.create_task(load())
        self.cache[key] = (monotonic() + ttl, task)

        def remove_failed(done):
            if done.cancelled() or done.exception() is not None:
                current = self.cache.get(key)
                if current and current[1] is done:
                    self.cache.pop(key, None)
        task.add_done_callback(remove_failed)
        return await asyncio.shield(task)

    async def close(self):
        pending = [task for _, task in self.cache.values() if not task.done()]
        for task in pending:
            task.cancel()
        await asyncio.gather(*pending, return_exceptions=True)

    async def sec(self, url):
        if not self.sec_user_agent:
            raise RuntimeError("Configure SEC_USER_AGENT for SEC filings.")
        now = monotonic()
        start = max(now, self.next_sec_request)
        self.next_sec_request = start + 0.125
        if start > now:
            await asyncio.sleep(start - now)
        async with asyncio.timeout(12):
            response = await self.client.get(url, timeout=12, headers={
                "User-Agent": self.sec_user_agent, "Accept": "application/json, text/html",
            })
        response.raise_for_status()
        return response

    async def twelve_data(self, path, **params):
        if not self.twelve_key:
            raise RuntimeError("Configure the Twelve Data key for live prices.")
        async with asyncio.timeout(12):
            response = await self.client.get("https://api.twelvedata.com/" + path, params=params,
                                             headers={"Authorization": "apikey " + self.twelve_key}, timeout=12)
        response.raise_for_status()
        return response.json()

    async def prices(self, stock):
        if self.mode == "demo":
            return demo_prices(stock)

        async def load():
            response = await self.twelve_data("time_series", symbol=stock.ticker, interval="1day", outputsize=140)
            rows = []
            for item in response.get("values") or []:
                try:
                    close = float(item["close"])
                    session = date.fromisoformat(item["datetime"]).isoformat()
                except (KeyError, TypeError, ValueError):
                    continue
                if math.isfinite(close) and close > 0:
                    rows.append({"date": session, "close": close})
            if len(rows) < 2:
                raise RuntimeError("The market data provider returned insufficient price history.")
            return sorted(rows, key=lambda row: row["date"])
        return await self.cached(("price", stock.ticker), 900, load)

    async def financials(self, stock):
        if self.mode == "demo":
            return {"cash": round((7 + stock.seed / 3) * 1e9), "debt": round((56 - stock.seed / 2) * 1e9),
                    "operatingCash": round((stock.seed / 6 - 5) * 1e9), "revenue": stock.seed * 800_000_000,
                    "as_of": FIXTURE_DATE.isoformat()}
        url = f"https://data.sec.gov/api/xbrl/companyfacts/CIK{stock.cik:010}.json"

        async def load():
            data = (await self.sec(url)).json()
            gaap = data.get("facts", {}).get("us-gaap", {})
            return {
                "cash": latest_fact(gaap, ["CashAndCashEquivalentsAtCarryingValue"]),
                "longTermDebt": latest_fact(gaap, ["LongTermDebtNoncurrent", "LongTermDebt"]),
                "operatingCashAnnual": latest_fact(gaap, ["NetCashProvidedByUsedInOperatingActivities"], annual=True),
                "revenueAnnual": latest_fact(gaap, ["RevenueFromContractWithCustomerExcludingAssessedTax", "Revenues", "SalesRevenueNet"], annual=True),
                "source": url,
            }
        return await self.cached(("facts", stock.cik), 3600, load)

    async def company_reports(self, stock):
        async def load():
            response = await self.sec(f"https://data.sec.gov/submissions/CIK{stock.cik:010}.json")
            recent = response.json()["filings"]["recent"]
            rows = []
            for form, session, accession, document in zip(
                recent["form"], recent["filingDate"], recent["accessionNumber"], recent["primaryDocument"]
            ):
                if (REPORT_FORM.fullmatch(form) and TICKER_DATE.fullmatch(session)
                        and re.fullmatch(r"\d{10}-\d{2}-\d{6}", accession)
                        and re.fullmatch(r"[a-zA-Z0-9_.-]+\.html?", document)):
                    url = f"{SEC_ARCHIVES}/{stock.cik}/{accession.replace('-', '')}/{document}"
                    rows.append({"form": form, "date": session, "accession": accession, "url": url})
            return rows
        return await self.cached(("reports", stock.cik), 600, load)

    async def recent_filings(self, stock):
        if self.mode == "demo":
            return [{"form": "10-Q", "date": FIXTURE_DATE.isoformat(), "url": None}]
        return [{key: row[key] for key in ("form", "date", "url")} for row in await self.company_reports(stock)]

    async def press_releases(self, stock):
        if self.mode == "demo":
            return [{
                "title": "Sample company announcement", "publishedAt": FIXTURE_DATE.isoformat() + "T14:00:00Z",
                "excerpt": "This fictional release illustrates how a company announcement appears in the research view.",
            }]

        async def load():
            data = await self.twelve_data("press_releases", symbol=stock.ticker, outputsize=6, language="en,en-US", timezone="UTC")
            releases = data.get("press_releases")
            if data.get("status") == "ok" and releases is None:
                return []
            if not isinstance(releases, list) or data.get("status") == "error":
                raise RuntimeError("The press release provider returned an unexpected response.")
            headlines = []
            for release in releases:
                if not isinstance(release, dict):
                    continue
                title = release.get("title")
                if not isinstance(title, str) or not title.strip():
                    continue
                try:
                    published = datetime.fromisoformat(release.get("datetime"))
                except (TypeError, ValueError):
                    continue
                body = release.get("body")
                parts = segments(body[:16_000]) if isinstance(body, str) else []
                excerpt = parts[0] if parts else ""
                if len(excerpt) > 240:
                    words = excerpt[:241].rsplit(maxsplit=1)
                    excerpt = (words[0] if len(words) > 1 else excerpt[:240]) + "…"
                headlines.append({"title": title.strip()[:300],
                                  "publishedAt": iso_time(published.replace(tzinfo=published.tzinfo or UTC)), "excerpt": excerpt})
            return headlines
        return await self.cached(("headlines", stock.ticker), 900, load)

    async def search_filings(self, stock, query):
        if self.mode == "demo":
            return rank_passages(demo_passages(stock), query)

        async def load():
            rows = [row for row in await self.company_reports(stock) if row["form"] in {"10-Q", "10-K"}][:2]
            passages = []
            for row in rows:
                content = (await self.sec(row["url"])).text
                passages.extend({
                    "id": f"{row['accession']}-{index}", "title": "SEC " + row["form"],
                    "date": row["date"], "text": text, "url": row["url"],
                } for index, text in enumerate(segments(content), 1))
            return passages
        return rank_passages(await self.cached(("passages", stock.cik), 3600, load), query)
