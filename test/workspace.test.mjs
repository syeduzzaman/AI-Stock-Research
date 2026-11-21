import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { test } from "node:test";
import { createAccounts, readSession } from "../src/accounts.mjs";
import { rankPassages } from "../src/market.mjs";
import { connectMcp } from "../src/mcp-client.mjs";
import { createDashboard } from "../src/server.mjs";

test("filing retrieval ranks matching sources and excludes unrelated passages", () => {
  const snippets = [
    { id: "a", text: "Competition increased in the European market." },
    { id: "b", text: "Debt maturities and debt refinancing are management priorities." },
    { id: "c", text: "Management stated that debt levels declined." }
  ];
  assert.deepEqual(rankPassages(snippets, "debt maturity refinancing").map(item => item.id), ["b", "c"]);
  assert.deepEqual(rankPassages(snippets, "unmatched"), []);
});

test("local workspace stores personal data, isolates accounts, and completes MCP-backed analyses", async t => {
  const accounts = createAccounts(":memory:");
  const mcp = connectMcp();
  const toolCalls = t.mock.method(mcp, "call");
  const dashboard = createDashboard({ accounts, mcp, localHost: "127.0.0.1:8082" });
  try {
    async function request(path, { method = "GET", cookie, body, origin, host = "127.0.0.1:8082" } = {}) {
      const req = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), {
        method, url: path,
        headers: { host, cookie, origin, "content-type": body === undefined ? undefined : "application/json" },
        socket: { remoteAddress: "127.0.0.1" }
      });
      const headers = {};
      const response = {
        setHeader(name, value) { headers[name.toLowerCase()] = value; },
        writeHead(status, values) {
          this.status = status;
          for (const [name, value] of Object.entries(values)) this.setHeader(name, value);
          return this;
        },
        end(data) { this.body = data.toString(); }
      };
      await dashboard.handle(req, response);
      const result = headers["content-type"]?.includes("application/json") ? JSON.parse(response.body) : response.body;
      return { status: response.status, result, cookie: headers["set-cookie"] };
    }

    assert.match((await request("/")).result, /<title>AI Stock Research<\/title>/);
    const health = await request("/healthz");
    assert.equal(health.status, 200);
    assert.deepEqual(health.result, { status: "ok" });
    assert.equal((await request("/", { host: "elsewhere.example" })).status, 403);
    assert.equal((await request("/api/workspace")).status, 401);
    assert.equal((await request("/api/company-news?ticker=MU")).status, 401);
    assert.equal((await request("/api/watchlist/updates")).status, 401);
    assert.equal((await request("/api/market-overview", { origin: "https://elsewhere.example" })).status, 403);
    const highlights = await request("/api/market-overview");
    assert.equal(highlights.status, 200);
    assert.deepEqual(highlights.result.stocks.map(item => item.ticker), ["NVDA", "AAPL", "MSFT", "TSLA"]);
    assert.ok(highlights.result.stocks.every(({ prices }) => prices.length === 20 && prices.at(-1).close > 0));
    assert.equal((await request("/api/account", { method: "POST", origin: "https://elsewhere.example", body: { action: "demo" } })).status, 403);
    const signIn = () => request("/api/account", { method: "POST", body: { action: "demo" } });
    const first = await signIn();
    assert.equal(first.status, 200);
    assert.match(first.cookie, /HttpOnly; SameSite=Lax/);
    const cookie = first.cookie.split(";")[0];
    const second = (await signIn()).cookie.split(";")[0];
    const call = (path, method, body) => request(path, { method, cookie, body });

    const configured = (await request("/api/config")).result;
    assert.equal(configured.marketMode, "demo");
    assert.equal(configured.stocks.length, 12);
    assert.equal(configured.providers.find(item => item.id === "gemini").enabled, false);
    const news = await call("/api/company-news?ticker=MU");
    assert.equal(news.status, 200);
    assert.deepEqual(news.result.items.map(item => item.kind), ["release", "filing"]);
    assert.equal(news.result.marketMode, "demo");
    assert.equal((await call("/api/company-news?ticker=invalid")).status, 400);
    assert.deepEqual((await call("/api/watchlist", "PUT", { ticker: "MU", add: true })).result.watchlist, ["MU"]);
    assert.equal((await call("/api/watchlist", "PUT", { ticker: "invalid", add: true })).status, 400);
    assert.equal((await request("/api/watchlist/updates", { cookie, origin: "https://elsewhere.example" })).status, 403);
    const updates = (await call("/api/watchlist/updates")).result;
    assert.ok(updates.events.some(item => item.ticker === "MU" && item.kind === "filing" && item.form === "10-Q"));
    assert.ok(updates.events.every(item => item.ticker === "MU"));
    assert.deepEqual((await request("/api/watchlist/updates", { cookie: second })).result.events, []);
    assert.deepEqual((await call("/api/holdings", "PUT", { ticker: "MU", shares: 2.5, averageCost: 110 })).result.portfolio, [
      { ticker: "MU", shares: 2.5, average_cost: 110 }
    ]);
    assert.equal((await call("/api/holdings", "PUT", { ticker: "MU", shares: -1, averageCost: 1 })).status, 400);
    await call("/api/preferences", "PUT", { provider: "demo", horizon: "3m", agentCount: 3 });
    const quote = (await call("/api/market?ticker=MU&horizon=3m")).result;
    assert.equal(quote.metrics.sessions, 63);
    assert.equal(quote.prices.length, 140);

    toolCalls.mock.resetCalls();
    const analyzed = await call("/api/analysis", "POST", { ticker: "MU", provider: "demo", horizon: "3m", agentCount: 5 });
    assert.equal(analyzed.status, 201);
    const { result } = analyzed.result;
    assert.equal(result.agents.length, 5);
    assert.equal(result.marketMode, "demo");
    assert.equal(result.scoredAgents, 5);
    assert.equal(result.score, Math.round(result.agents.reduce((sum, agent) => sum + agent.score, 0) / 5));
    assert.ok(result.agents.every(agent => agent.sources.length > 0));
    assert.deepEqual([...new Set(toolCalls.mock.calls.map(call => call.arguments[0]))].sort(),
      ["get_company_financials", "get_price_history", "search_filings"]);
    assert.equal(Object.hasOwn(result, "trace"), false);
    const legacyResult = { ...result, id: "2ede0a8a-1d69-40aa-acc9-773b7ad1baee", createdAt: "2025-01-01T00:00:00Z" };
    const account = await accounts.account(readSession({ headers: { cookie } }));
    await accounts.saveRun(account, { ...legacyResult, trace: [{ tool: "get_price_history" }] });
    const saved = (await call("/api/workspace")).result;
    assert.deepEqual(saved.preferences, { provider: "demo", horizon: "3m", agentCount: 3 });
    assert.deepEqual(saved.history, [result, legacyResult]);
    const isolated = (await request("/api/workspace", { cookie: second })).result;
    assert.deepEqual([isolated.watchlist, isolated.portfolio, isolated.history], [[], [], []]);
    assert.deepEqual((await call("/api/holdings", "PUT", { ticker: "MU", shares: 0 })).result.portfolio, []);
    assert.equal((await call("/api/logout", "POST")).status, 200);
    assert.equal((await call("/api/workspace")).status, 401);
  } finally {
    dashboard.close();
  }
});
