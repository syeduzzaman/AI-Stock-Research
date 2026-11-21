import { fixtureDate, mode } from "./market.mjs";

const days = 14;
const minimumMove = 3;
const maximumEvents = 20;
const exchangeClock = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23"
});

function dateBefore(date, count) {
  const day = new Date(date + "T00:00:00Z");
  day.setUTCDate(day.getUTCDate() - count);
  return day.toISOString().slice(0, 10);
}

function windowFor(dataMode, now) {
  if (dataMode === "demo") return { end: fixtureDate, priceEnd: fixtureDate };
  const { year, month, day, hour } = Object.fromEntries(exchangeClock.formatToParts(now).map(({ type, value }) => [type, value]));
  const end = year + "-" + month + "-" + day;
  // Give the regular session and previously cached intraday bars time to clear.
  return { end, priceEnd: Number(hour) >= 17 ? end : dateBefore(end, 1) };
}

function dailyMoves(ticker, prices, start, end) {
  const events = [];
  for (let i = 1; i < prices.length; i++) {
    const { date, close } = prices[i];
    if (date < start || date > end) continue;
    const change = Number(((close / prices[i - 1].close - 1) * 100).toFixed(2));
    if (Math.abs(change) >= minimumMove) events.push({ ticker, kind: "price", date, change, close });
  }
  return events;
}

export async function watchlistUpdates(mcp, tickers, { dataMode = mode, now = new Date() } = {}) {
  const { end, priceEnd } = windowFor(dataMode, now);
  const start = dateBefore(end, days - 1);
  const events = [];
  const unavailable = { prices: [], filings: [] };
  const updates = await Promise.all(tickers.map(async ticker => {
    const [prices, filings] = await Promise.allSettled([
      mcp.call("get_price_history", { ticker }),
      mcp.call("get_recent_filings", { ticker })
    ]);
    return { ticker, prices, filings };
  }));
  for (const { ticker, prices, filings } of updates) {
    if (prices.status === "fulfilled" && prices.value.prices.some(({ date }) => date >= start && date <= priceEnd)) {
      events.push(...dailyMoves(ticker, prices.value.prices, start, priceEnd));
    } else {
      unavailable.prices.push(ticker);
    }
    if (filings.status === "fulfilled") {
      for (const { form, date, url } of filings.value.filings) {
        if (date >= start && date <= end) events.push({ ticker, kind: "filing", date, form, url });
      }
    } else {
      unavailable.filings.push(ticker);
    }
  }
  events.sort((a, b) => b.date.localeCompare(a.date) || a.ticker.localeCompare(b.ticker) || a.kind.localeCompare(b.kind));
  return { events: events.slice(0, maximumEvents), total: events.length, unavailable, days, minimumMove };
}
