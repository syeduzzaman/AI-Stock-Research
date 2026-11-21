import assert from "node:assert/strict";
import { test } from "node:test";

process.env.MARKET_DATA_MODE = "live";
process.env.TWELVE_DATA_API_KEY = "fixture-key";
const { companyNews } = await import("../src/company-news.mjs");
const { findStock, pressReleases } = await import("../src/market.mjs");

const now = new Date("2026-11-21T17:00:00Z");
const filing = { form: "8-K", date: "2026-11-20", url: "https://www.sec.gov/Archives/edgar/data/320193/000032019326000001/report.htm" };

test("company news orders recent updates and keeps the newest copy of a headline", async () => {
  const mcp = { call: async name => name === "get_press_releases" ? { releases: [
    { title: "Company update", publishedAt: "2026-11-19T13:00:00.000Z", excerpt: "" },
    { title: "Company update", publishedAt: "2026-11-21T13:00:00.000Z", excerpt: "Latest copy" },
    { title: "Future release", publishedAt: "2026-11-21T18:00:00.000Z", excerpt: "" },
    { title: "Old release", publishedAt: "2026-10-07T13:00:00.000Z", excerpt: "" }
  ] } : { filings: [filing] } };
  const result = await companyNews(mcp, "AAPL", { now });
  assert.deepEqual(result.items.map(item => item.kind), ["release", "filing"]);
  assert.equal(result.items[0].excerpt, "Latest copy");
  assert.equal(result.items[1].url, filing.url);
});

test("company news still shows filings when the press release feed is unavailable", async () => {
  const mcp = { async call(name) {
    if (name === "get_press_releases") throw new Error("Provider unavailable");
    return { filings: [filing] };
  } };
  const result = await companyNews(mcp, "AAPL", { now });
  assert.deepEqual(result.unavailable, { releases: true, filings: false });
  assert.equal(result.items[0].form, "8-K");
});

test("press releases normalize dates and return cached plain-text excerpts", async t => {
  const fetch = t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url.pathname, "/press_releases");
    assert.equal(url.searchParams.get("symbol"), "AAPL");
    assert.equal(options.headers.Authorization, "apikey fixture-key");
    return Response.json({ status: "ok", press_releases: [{
      title: "Company update",
      datetime: "2026-11-20T17:00:00-05:00",
      body: "<script>Not part of the announcement</script><p>" + "Published company update. ".repeat(18) + "</p>"
    }] });
  });
  const [release] = await pressReleases(findStock("AAPL"));
  assert.equal(release.publishedAt, "2026-11-20T22:00:00.000Z");
  assert.match(release.excerpt, /^Published company update\./);
  assert.doesNotMatch(release.excerpt, /<|Not part of/);
  assert.ok(release.excerpt.length <= 241);
  await pressReleases(findStock("AAPL"));
  assert.equal(fetch.mock.callCount(), 1);
});
