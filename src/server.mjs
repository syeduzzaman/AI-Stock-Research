import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { analyze, horizons, listProviders, marketSnapshot, roles } from "./analysis.mjs";
import { confirmationMode, createAccounts, hosted, HttpError, readSession, sessionCookie } from "./accounts.mjs";
import { connectMcp } from "./mcp-client.mjs";
import { findStock, mode, publicStock, stocks } from "./market.mjs";
import { watchlistUpdates } from "./watchlist-updates.mjs";

const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 8082);
const publicOrigin = process.env.PUBLIC_ORIGIN || null;
const containerOrigin = process.env.LOCAL_CONTAINER_ORIGIN || null;
let containerHost = null;
if (containerOrigin) {
  const url = new URL(containerOrigin);
  if (publicOrigin || url.origin !== containerOrigin || url.protocol !== "http:" || url.hostname !== "127.0.0.1") {
    throw new Error("LOCAL_CONTAINER_ORIGIN must be an exact http://127.0.0.1 origin used for local container access.");
  }
  containerHost = url.host;
}
if (publicOrigin && (new URL(publicOrigin).origin !== publicOrigin || !publicOrigin.startsWith("https://"))) {
  throw new Error("PUBLIC_ORIGIN must be the exact HTTPS origin, without a path or trailing slash.");
}
if (!publicOrigin && !containerHost && !["localhost", "127.0.0.1", "::1"].includes(host)) {
  throw new Error("Set PUBLIC_ORIGIN and use HTTPS when exposing the app beyond localhost.");
}
if (publicOrigin && !hosted) throw new Error("Configure Supabase Auth before exposing the app publicly.");
if ((publicOrigin || hosted) && mode === "live" && (!process.env.SEC_USER_AGENT || !process.env.TWELVE_DATA_API_KEY)) {
  throw new Error("Configure Twelve Data and SEC EDGAR for live mode.");
}

const files = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/style.css": ["style.css", "text/css; charset=utf-8"],
  "/analysis-comparison.js": ["analysis-comparison.js", "text/javascript; charset=utf-8"],
  "/i18n.js": ["i18n.js", "text/javascript; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"]
};
const providerOptions = listProviders();
const featuredStocks = ["NVDA", "AAPL", "MSFT", "TSLA"].map(ticker => {
  const { name } = findStock(ticker);
  return { ticker, name };
});

function json(response, status, data) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(data));
}

async function body(request) {
  if (!/^application\/json\b/i.test(request.headers["content-type"] ?? "")) throw new HttpError(415, "Send a JSON request.");
  const parts = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 16_384) throw new HttpError(413, "The request is too large.");
    parts.push(chunk);
  }
  let data;
  try { data = JSON.parse(Buffer.concat(parts)); }
  catch { throw new HttpError(400, "The request is not valid JSON."); }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new HttpError(400, "Send a JSON object.");
  return data;
}

function verifyOrigin(request) {
  const origin = request.headers.origin;
  const protocol = publicOrigin ? "https://" : "http://";
  const own = publicOrigin ?? protocol + request.headers.host;
  if (request.headers["sec-fetch-site"] === "cross-site" || (origin && origin !== own)) throw new HttpError(403, "This request must come from your dashboard.");
}

function options(input) {
  const { provider, horizon, agentCount } = input;
  if (!providerOptions.some(item => item.id === provider && item.enabled)
    || !Object.hasOwn(horizons, horizon) || ![3, 5].includes(agentCount)) {
    throw new HttpError(400, "Choose an available model, horizon, and agent count.");
  }
  return { provider, horizon, agentCount };
}

export function createDashboard({ accounts = createAccounts(), mcp = connectMcp(), localHost = containerHost } = {}) {
  const activeRuns = new Set();
  const handle = async (request, response) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      if (localHost && request.headers.host !== localHost) {
        throw new HttpError(403, "Open the configured loopback address to use the dashboard.");
      }
      const url = new URL(request.url, "http://localhost");
      const path = url.pathname;
      const method = request.method;
      if (method === "GET" && Object.hasOwn(files, path)) {
        const [file, mime] = files[path];
        const payload = await readFile(new URL("../public/" + file, import.meta.url));
        response.writeHead(200, { "Content-Type": mime, "Cache-Control": "no-cache" }).end(payload);
        return;
      }
      if (method === "GET" && path === "/api/config") {
        json(response, 200, {
          hosted, confirmationMode, marketMode: mode, marketPreview: !publicOrigin, featuredStocks,
          providers: providerOptions,
          agents: roles.map(({ id, name, initials }) => ({ id, name, initials })), stocks: stocks.map(publicStock)
        });
        return;
      }
      if (method === "GET" && path === "/healthz") {
        try {
          await mcp.ping();
          json(response, 200, { status: "ok" });
        } catch {
          json(response, 503, { status: "unavailable" });
        }
        return;
      }
      if (method !== "GET") verifyOrigin(request);
      const session = readSession(request);
      if (method === "POST" && path === "/api/account") {
        accounts.rateLimit("login:" + request.socket.remoteAddress, 20, 300_000);
        const input = await body(request);
        const directHost = host === "::1" ? "[::1]" : host;
        const origin = publicOrigin ?? containerOrigin ?? "http://" + directHost + ":" + (request.socket.localPort ?? port);
        const result = await accounts.signIn(input.action, input, new URL("/", origin).href);
        if (result.session) response.setHeader("Set-Cookie", sessionCookie(result.session, Boolean(publicOrigin)));
        json(response, 200, { signedIn: Boolean(result.session), verificationRequired: Boolean(result.verificationRequired), message: result.message });
        return;
      }
      const user = await accounts.account(session);
      if (method === "GET" && path === "/api/market-overview" && (!publicOrigin || user)) {
        verifyOrigin(request);
        accounts.rateLimit("market-overview:" + request.socket.remoteAddress, 30, 60_000);
        const quotes = await Promise.allSettled(featuredStocks.map(({ ticker }) => mcp.call("get_price_history", { ticker })));
        json(response, 200, { stocks: featuredStocks.map((stock, index) => {
          const quote = quotes[index];
          return { ...stock, prices: quote.status === "fulfilled" ? quote.value.prices.slice(-20) : [] };
        }) });
        return;
      }
      if (method === "GET" && path === "/api/session") {
        json(response, 200, { user: user ? { email: user.email, username: user.username, demo: !hosted } : null });
        return;
      }
      if (method === "POST" && path === "/api/logout") {
        response.setHeader("Set-Cookie", sessionCookie(null, Boolean(publicOrigin)));
        await accounts.signOut(session, user);
        json(response, 200, { success: true });
        return;
      }
      if (!path.startsWith("/api/")) throw new HttpError(404, "Page not found.");
      if (!user) throw new HttpError(401, "Sign in to access your workspace.");
      if (method === "GET" && path === "/api/workspace") {
        const [watchlist, portfolio, history, preferences] = await Promise.all([
          accounts.watchlist(user), accounts.portfolio(user), accounts.history(user), accounts.preferences(user)
        ]);
        json(response, 200, { watchlist, portfolio, history: history.map(({ trace, ...result }) => result), preferences });
        return;
      }
      if (method === "PUT" && path === "/api/preferences") {
        const preferences = options(await body(request));
        await accounts.savePreferences(user, preferences);
        json(response, 200, { preferences });
        return;
      }
      if (method === "PUT" && path === "/api/watchlist") {
        const { ticker, add } = await body(request);
        if (!findStock(ticker) || typeof add !== "boolean") throw new HttpError(400, "Choose a supported stock.");
        await accounts.setWatch(user, ticker, add);
        json(response, 200, { watchlist: await accounts.watchlist(user) });
        return;
      }
      if (method === "GET" && path === "/api/watchlist/updates") {
        verifyOrigin(request);
        accounts.rateLimit("watchlist-updates:" + user.id, 12, 60_000);
        const tickers = (await accounts.watchlist(user)).filter(ticker => findStock(ticker));
        json(response, 200, await watchlistUpdates(mcp, tickers));
        return;
      }
      if (method === "PUT" && path === "/api/holdings") {
        const { ticker, shares, averageCost } = await body(request);
        if (!findStock(ticker) || !Number.isFinite(shares) || shares < 0 || shares > 1e7
          || (shares !== 0 && (shares < 0.000001 || !Number.isFinite(averageCost) || averageCost < 0.000001 || averageCost > 1e7))) {
          throw new HttpError(400, "Enter a covered stock, a valid share count, and an average cost in USD.");
        }
        await accounts.setHolding(user, {
          ticker, shares: Number(shares.toFixed(6)), average_cost: shares === 0 ? 0 : Number(averageCost.toFixed(6))
        });
        json(response, 200, { portfolio: await accounts.portfolio(user) });
        return;
      }
      if (method === "GET" && path === "/api/market") {
        const ticker = url.searchParams.get("ticker");
        const horizon = url.searchParams.get("horizon");
        if (!findStock(ticker) || !Object.hasOwn(horizons, horizon)) throw new HttpError(400, "Choose a supported stock and time horizon.");
        accounts.rateLimit("market:" + user.id, 120, 60_000);
        json(response, 200, await marketSnapshot(mcp, ticker, horizon));
        return;
      }
      if (method === "POST" && path === "/api/analysis") {
        const input = await body(request);
        const stock = findStock(input.ticker);
        if (!stock) throw new HttpError(400, "Choose a supported stock.");
        const { provider, horizon, agentCount } = options(input);
        if (provider === "demo" && mode === "live") throw new HttpError(400, "Live analysis requires a configured AI model.");
        if (activeRuns.has(user.id) || activeRuns.size >= 4) throw new HttpError(429, "An analysis is already running. Try again shortly.");
        accounts.rateLimit("analysis:" + user.id, 15, 3_600_000);
        if (provider !== "demo") accounts.rateLimit("paid-analysis", 40, 3_600_000);
        activeRuns.add(user.id);
        try {
          const result = await analyze(mcp, stock, { horizon, agentCount, providerId: provider });
          const currentUser = await accounts.account(session);
          if (!currentUser) throw new HttpError(401, "Sign in again to save an analysis.");
          await accounts.saveRun(currentUser, result);
          json(response, 201, { result });
        } finally {
          activeRuns.delete(user.id);
        }
        return;
      }
      throw new HttpError(404, "Endpoint not found.");
    } catch (error) {
      const status = error.status ?? 500;
      if (status >= 500) console.error("Request failed:", error.message);
      json(response, status, { error: status >= 500 ? "The workspace could not complete this request." : error.message });
    }
  };
  return { handle, close() { mcp.close(); accounts.close(); } };
}

if (import.meta.main) {
  const dashboard = createDashboard();
  const server = createServer(dashboard.handle);
  server.listen(port, host, () => {
    const address = containerOrigin ?? "http://" + host + ":" + server.address().port;
    console.log("Stock Research Dashboard listening on " + address);
  });
  server.once("close", () => dashboard.close());
  for (const event of ["SIGINT", "SIGTERM"]) process.on(event, () => { server.close(); server.closeIdleConnections(); });
}
