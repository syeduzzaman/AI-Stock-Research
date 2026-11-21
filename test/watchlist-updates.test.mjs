import assert from "node:assert/strict";
import { test } from "node:test";
import { watchlistUpdates } from "../src/watchlist-updates.mjs";

test("watchlist feed uses the preceding daily close and excludes the in-progress session", async () => {
  const prices = [
    { date: "2026-06-01", close: 100 },
    { date: "2026-06-02", close: 101 },
    { date: "2026-06-03", close: 104.03 },
    { date: "2026-06-04", close: 99 },
    { date: "2026-06-05", close: 110 }
  ];
  const filings = [
    { form: "8-K", date: "2026-06-06", url: "future" },
    { form: "10-Q", date: "2026-06-05", url: "recent" },
    { form: "8-K", date: "2026-05-23", url: "boundary" },
    { form: "8-K", date: "2026-05-22", url: "old" }
  ];
  const mcp = { call: async name => name === "get_price_history" ? { prices } : { filings } };
  const feed = await watchlistUpdates(mcp, ["NVDA"], { dataMode: "live", now: new Date("2026-06-05T20:59:59Z") });
  assert.deepEqual(feed.events.map(item => [item.date, item.kind, item.change ?? item.url]), [
    ["2026-06-05", "filing", "recent"],
    ["2026-06-04", "price", -4.84],
    ["2026-06-03", "price", 3],
    ["2026-05-23", "filing", "boundary"]
  ]);
  const evening = await watchlistUpdates(mcp, ["NVDA"], { dataMode: "live", now: new Date("2026-06-05T21:00:00Z") });
  assert.ok(evening.events.some(item => item.kind === "price" && item.date === "2026-06-05"));
});

test("watchlist feed keeps available events and identifies missing prices and filings independently", async () => {
  const mcp = {
    async call(name, { ticker }) {
      if (name === "get_recent_filings" && ticker === "AAPL") return { filings: [{ date: "2025-03-31", form: "10-Q", url: null }] };
      if (name === "get_price_history" && ticker === "NVDA") return { prices: [
        { date: "2025-03-28", close: 100 }, { date: "2025-03-31", close: 95 }
      ] };
      throw new Error("Provider unavailable");
    }
  };
  const feed = await watchlistUpdates(mcp, ["AAPL", "NVDA"], { dataMode: "demo" });
  assert.deepEqual(feed.events.map(({ ticker, kind, date }) => [ticker, kind, date]), [
    ["AAPL", "filing", "2025-03-31"], ["NVDA", "price", "2025-03-31"]
  ]);
  assert.deepEqual(feed.unavailable, { prices: ["AAPL"], filings: ["NVDA"] });
});
