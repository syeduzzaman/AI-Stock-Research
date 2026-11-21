import { compareWithPrevious } from "./analysis-comparison.js";
import { translate } from "./i18n.js";

const $ = id => document.getElementById(id);
const ranges = { "1w": "1 week", "1m": "1 month", "3m": "3 months", "6m": "6 months" };
const languageKey = "stock-research-language";
const staticCopy = [...document.querySelectorAll("[data-i18n]")].map(node => [node, node.textContent]);
const staticAttributes = [...document.querySelectorAll("[data-i18n-attrs]")].map(node => {
  const attr = node.dataset.i18nAttrs;
  return [node, attr, node.getAttribute(attr)];
});
const languageButtons = document.querySelectorAll("[data-language]");

function preferredLanguage() {
  try { return localStorage.getItem(languageKey) === "de" ? "de" : "en"; }
  catch { return "en"; }
}

function formatters(language) {
  const locale = language === "de" ? "de-DE" : "en-US";
  const currency = { style: "currency", currency: "USD" };
  return {
    money: new Intl.NumberFormat(locale, currency),
    signedMoney: new Intl.NumberFormat(locale, { ...currency, signDisplay: "exceptZero" }),
    signedPercent: new Intl.NumberFormat(locale, {
      style: "percent", signDisplay: "exceptZero", minimumFractionDigits: 2, maximumFractionDigits: 2
    }),
    shareCount: new Intl.NumberFormat(locale, { maximumFractionDigits: 6 }),
    decimal: new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 }),
    calendar: new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", timeZone: "UTC" }),
    quoteDate: new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" }),
    eventDate: new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }),
    runDate: new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "medium" })
  };
}

let language = preferredLanguage();
let { money, signedMoney, signedPercent, shareCount, decimal, calendar, quoteDate, eventDate, runDate } = formatters(language);
const t = (message, values) => translate(language, message, values);

function dateLabel(date) {
  return quoteDate.format(new Date(date));
}

const defaults = { horizon: "1m", provider: "demo", agentCount: 5 };
let config;
let user;
let authAction = "login";
let stock;
let market;
let marketStatus;
let displayedResult;
let lastNotice;
let marketRequest = 0;
let featuredQuotes;
let loadingFeaturedQuotes = false;
let signedInVersion = 0;
let saved = [];
let holdings = [];
let history = [];
let watchPending = false;
let watchUpdates;
let holdingPending = false;
const closingQuotes = new Map();
const newsByStock = new Map();
let newsInView = false;

function el(tag, text, className) {
  const item = document.createElement(tag);
  if (text !== undefined) item.textContent = text;
  if (className) item.className = className;
  return item;
}

async function api(path, method = "GET", body) {
  const response = await fetch(path, {
    method, headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "The request could not be completed.");
  return data;
}

function notice(message, isError = false, values, target = "notice") {
  lastNotice = { message, isError, values, target };
  renderNotice();
}

function accountNotice(message, isError = false) {
  notice(message, isError, undefined, $("account-panel").hidden ? "notice" : "auth-notice");
}

function renderNotice() {
  const { message, isError, values, target } = lastNotice ?? {};
  const copy = message ? t(message, values) : "";
  const display = language === "de" && isError && copy === message
    ? t("The request could not be completed.") : copy;
  for (const id of ["notice", "auth-notice"]) {
    const box = $(id);
    const visible = id === target && Boolean(message);
    box.hidden = !visible;
    box.textContent = visible ? display : "";
    box.classList.toggle("error", visible && isError);
  }
}

function settings() {
  return {
    provider: $("provider").value,
    horizon: document.querySelector("input[name=horizon]:checked")?.value ?? defaults.horizon,
    agentCount: Number(document.querySelector("input[name=agents]:checked")?.value ?? defaults.agentCount)
  };
}

function selectSettings(input) {
  const available = config.providers.find(item => item.id === input.provider && item.enabled);
  const fallback = config.marketMode === "live"
    ? config.providers.find(item => item.enabled && item.id !== "demo")?.id
    : "demo";
  $("provider").value = available && (config.marketMode !== "live" || available.id !== "demo")
    ? available.id : (fallback ?? "");
  document.querySelectorAll("input[name=horizon]").forEach(item => { item.checked = item.value === (input.horizon ?? defaults.horizon); });
  document.querySelectorAll("input[name=agents]").forEach(item => { item.checked = Number(item.value) === (input.agentCount ?? defaults.agentCount); });
  showAgentPreview();
}

function agentTitle(agent, index) {
  return t("Agent {number} · {name}", { number: index + 1, name: t(agent.name) });
}

function showAgentPreview() {
  const selected = config.agents.slice(0, settings().agentCount);
  $("agent-preview").replaceChildren(...selected.map((agent, index) => el("li", agentTitle(agent, index))));
  updateAnalysisControls();
}

function updateAnalysisControls() {
  const provider = $("provider").value;
  const demo = provider === "demo";
  const button = $("run-button");
  const running = button.hasAttribute("aria-busy");
  $("analysis-title").textContent = t(demo ? "Demo stock analysis" : "AI stock analysis");
  $("run-label").textContent = t(running ? "Running analysis…" : demo ? "Run demo analysis" : "Run AI analysis");
  button.disabled = running || !provider;
}

const viewTitles = {
  research: ["AI Stock Research", "Run independent analyses and follow the evidence behind each score."],
  watchlist: ["Watchlist", "Follow stocks you’re interested in and revisit your latest research."],
  portfolio: ["Portfolio", "Enter the shares you own to track their value and unrealized gain or loss."],
  history: ["Analysis history", "Reopen scores, explanations, and the evidence from previous runs."]
};

function renderViewTitle(view) {
  const [title, description] = viewTitles[view];
  $("view-title").textContent = t(title);
  $("view-description").textContent = t(description);
}

function openView(view) {
  if (!user || $("workspace").hidden) return;
  const changedView = $(view).hidden;
  renderViewTitle(view);
  document.querySelectorAll(".view").forEach(item => { item.hidden = item.id !== view; });
  document.querySelectorAll("[data-view]").forEach(item => {
    item.classList.toggle("selected", item.dataset.view === view);
    if (item.dataset.view === view) item.setAttribute("aria-current", "page");
    else item.removeAttribute("aria-current");
  });
  if (view === "watchlist") renderWatchlist();
  if (view === "portfolio") renderPortfolio();
  if (view === "history") renderHistory();
  if (view === "research") requestAnimationFrame(drawChart);
  if (changedView) window.scrollTo(0, 0);
}

function openResearch(ticker) {
  if ($("workspace").hidden) return;
  openView("research");
  void chooseStock(ticker);
}

function renderMarketOverview() {
  const showOverview = config.marketPreview || Boolean(user);
  $("market-overview").hidden = !showOverview;
  if (!showOverview) return;

  $("market-overview-caption").textContent = t(config.marketMode === "demo" ? "Synthetic closes · 20 sessions" : "Daily closes · 20 sessions");
  const tiles = (featuredQuotes ?? config.featuredStocks).map(({ ticker, name, prices }) => {
    const tile = el(user ? "button" : "article", undefined, "market-tile");
    if (user) {
      tile.type = "button";
      tile.addEventListener("click", () => openResearch(ticker));
    }

    const identity = el("div", undefined, "market-tile-identity");
    identity.append(el("strong", ticker), el("span", name));
    tile.append(identity);
    if (!prices?.length) {
      tile.append(el("span", t(prices ? "Price unavailable" : "Loading price…"), "market-tile-status"));
      return tile;
    }

    const latest = prices.at(-1);
    const previous = prices.at(-2);
    const change = (latest.close - previous.close) / previous.close;
    const value = el("div", undefined, "market-tile-value");
    const close = el("strong", money.format(latest.close));
    close.title = t("Closing price on {date}", { date: dateLabel(latest.date) });
    const daily = el("span", signedPercent.format(change), change < 0 ? "market-change negative" : "market-change");
    daily.title = t("Change from previous close");
    value.append(close, daily);
    const chart = el("canvas", undefined, "market-sparkline");
    chart.setAttribute("aria-hidden", "true");
    drawSparkline(chart, prices);
    tile.append(value, chart);
    return tile;
  });
  $("market-tiles").replaceChildren(...tiles);
}

async function loadMarketOverview() {
  renderMarketOverview();
  if ($("market-overview").hidden || featuredQuotes || loadingFeaturedQuotes) return;
  loadingFeaturedQuotes = true;
  try {
    featuredQuotes = (await api("/api/market-overview")).stocks;
  } catch {
    featuredQuotes = config.featuredStocks.map(stock => ({ ...stock, prices: [] }));
  } finally {
    loadingFeaturedQuotes = false;
    renderMarketOverview();
  }
}

function pricePath(context, prices, x, y) {
  context.beginPath();
  context.moveTo(x(0), y(prices[0].close));
  for (let i = 1; i < prices.length; i++) context.lineTo(x(i), y(prices[i].close));
}

function drawSparkline(canvas, prices) {
  const width = canvas.width = 192;
  const height = canvas.height = 76;
  const pad = 5;
  const closes = prices.map(point => point.close);
  const low = Math.min(...closes);
  const high = Math.max(...closes);
  const spread = high - low;
  const x = index => pad + (width - 2 * pad) * index / (prices.length - 1);
  const y = close => spread ? height - pad - (height - 2 * pad) * (close - low) / spread : height / 2;
  const context = canvas.getContext("2d");
  const palette = getComputedStyle(document.documentElement);
  const color = palette.getPropertyValue(closes.at(-1) >= closes[0] ? "--up" : "--red").trim();
  const fill = context.createLinearGradient(0, 0, 0, height);
  fill.addColorStop(0, color + "2b");
  fill.addColorStop(1, color + "00");
  pricePath(context, prices, x, y);
  context.lineTo(width - pad, height);
  context.lineTo(pad, height);
  context.closePath();
  context.fillStyle = fill;
  context.fill();
  pricePath(context, prices, x, y);
  context.strokeStyle = color;
  context.lineWidth = 3.5;
  context.lineJoin = "round";
  context.lineCap = "round";
  context.stroke();
}

function authControls() {
  const { hosted, marketMode } = config;
  const signup = hosted && authAction === "signup";
  const verify = hosted && authAction === "verify";
  const login = hosted && authAction === "login";
  const enterCode = verify && config.confirmationMode === "code";
  const followLink = verify && !enterCode;
  $("account-title").textContent = t(signup ? "Create your account" : verify ? "Check your email" : login ? "Sign in" : "Open the demo workspace");
  $("account-intro").textContent = t(enterCode ? "Enter the verification code from your email."
    : followLink ? "Open the email from Supabase Auth and select Confirm your email. Then sign in to AI Stock Research."
    : hosted ? "Your watchlist, holdings, and analyses are saved to your account."
      : marketMode === "demo" ? "Try the research flow with synthetic prices and sample filing excerpts." : "Open a local workspace to research your stocks.");
  $("auth-fields").hidden = !hosted;
  $("username-field").hidden = !signup;
  $("password-field").hidden = !hosted || verify;
  $("code-field").hidden = !enterCode;
  $("auth-switch").hidden = !hosted || followLink;
  $("resend-confirmation").hidden = !verify;
  const activeFields = { username: signup, email: hosted, password: hosted && !verify, "email-code": enterCode };
  for (const [id, active] of Object.entries(activeFields)) {
    $(id).disabled = !active;
    $(id).required = active;
  }
  $("email").autocomplete = login ? "username" : "email";
  $("password").autocomplete = signup ? "new-password" : "current-password";
  $("sign-in").textContent = t(signup ? "Create account" : enterCode ? "Verify code" : followLink ? "Back to sign in" : login ? "Sign in" : "Open demo");
  $("sign-in").formNoValidate = followLink;
  $("auth-switch").textContent = t(login ? "Create account" : "Back to sign in");
}

async function showAccount(account) {
  const version = ++signedInVersion;
  marketRequest += 1;
  closingQuotes.clear();
  newsByStock.clear();
  $("company-news").hidden = true;
  watchPending = false;
  watchUpdates = null;
  holdingPending = false;
  $("holding-fields").disabled = false;
  $("holding-save").disabled = false;
  user = account;
  void loadMarketOverview();
  displayedResult = null;
  $("result-panel").hidden = true;
  $("account-area").hidden = !user;
  $("account-panel").hidden = Boolean(user);
  $("workspace").hidden = true;
  if (!user) {
    saved = [];
    holdings = [];
    history = [];
    $("agent-results").replaceChildren();
    $("history-items").replaceChildren();
    $("watch-items").replaceChildren();
    $("holding-items").replaceChildren();
    prepareHolding();
    renderViewTitle("research");
    authControls();
    return;
  }
  renderAccountName();
  const data = await api("/api/workspace");
  if (version !== signedInVersion) return;
  saved = data.watchlist;
  holdings = data.portfolio;
  history = data.history;
  selectSettings(data.preferences);
  $("workspace").hidden = false;
  openView("research");
  await chooseStock(saved[0] ?? config.stocks[0].ticker);
}

function renderAccountName() {
  const label = user.username ?? user.email ?? t("Demo workspace");
  $("account-name").textContent = label;
  $("account-initials").textContent = label[0].toUpperCase();
}

function renderSearch() {
  const term = $("stock-search").value.trim().toLowerCase();
  const universe = $("universe").value;
  const matching = config.stocks.filter(item => (universe === "all" || item.indexes.includes(universe))
    && (item.ticker.toLowerCase().includes(term) || item.name.toLowerCase().includes(term)));
  const items = matching.map(item => {
    const button = el("button");
    button.type = "button";
    button.append(el("strong", item.ticker), el("span", item.name));
    button.addEventListener("click", () => {
      $("stock-search").value = "";
      $("search-results").hidden = true;
      chooseStock(item.ticker);
    });
    return button;
  });
  $("search-results").replaceChildren(...(items.length ? items : [el("p", t("No covered stock matched."), "empty")]));
  $("search-results").hidden = false;
}

async function chooseStock(ticker, keepResult = false) {
  stock = config.stocks.find(item => item.ticker === ticker);
  if (!stock) return;
  if (!keepResult) {
    displayedResult = null;
    $("result-panel").hidden = true;
  }
  $("stock-name").textContent = stock.name;
  $("stock-logo").textContent = stock.ticker.slice(0, 1);
  renderStockSector();
  updateStockActions();
  renderCompanyNews();
  if (newsInView) void loadCompanyNews();
  await loadMarket();
}

function companyNewsItem(item, demo) {
  const release = item.kind === "release";
  const headline = el("h3", release ? (demo ? t(item.title) : item.title) : t("SEC Form {form}", { form: item.form }));
  const source = t(demo ? (release ? "Demo press release" : "Demo filing") : (release ? "Company press release · Twelve Data" : "SEC EDGAR"));
  const meta = el("p", undefined, "company-news-meta");
  const time = el("time", dateLabel(item.publishedAt));
  time.dateTime = item.publishedAt;
  meta.append(source, " · ", time);
  const details = el("div");
  details.append(meta, headline);
  if (item.excerpt) {
    details.append(el("p", demo ? t(item.excerpt) : item.excerpt, "company-news-excerpt"));
  }
  if (release && !demo) {
    headline.lang = "en";
    if (item.excerpt) details.lastElementChild.lang = "en";
  }
  const row = el("li", undefined, "company-news-item");
  row.append(details);
  if (item.url?.startsWith("https://www.sec.gov/Archives/edgar/data/")) {
    const link = el("a", t("Open SEC filing"), "secondary");
    link.href = item.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    row.append(link);
  }
  return row;
}

function renderCompanyNews() {
  if (!stock) return;
  $("company-news").hidden = false;
  $("company-news-title").textContent = t("Latest news for {ticker}", { ticker: stock.ticker });
  const { data, loading, failed } = newsByStock.get(stock.ticker) ?? {};
  const messages = [];
  const list = $("company-news-items");
  list.setAttribute("aria-busy", String(Boolean(loading)));
  list.replaceChildren(...(data?.items ?? []).map(item => companyNewsItem(item, data.marketMode === "demo")));
  if (loading) messages.push(t("Loading company news…"));
  if (failed) messages.push(t("Company news could not be loaded. Try again."));
  if (data) {
    if (data.unavailable.releases) messages.push(t("Company press releases are temporarily unavailable."));
    if (data.unavailable.filings) messages.push(t("SEC filings are temporarily unavailable."));
    if (!data.items.length && !data.unavailable.releases && !data.unavailable.filings) {
      messages.push(t("No company press releases or SEC filings in the past {days} days.", { days: data.days }));
    }
  }
  const status = $("company-news-status");
  status.textContent = messages.join(" ");
  status.hidden = !messages.length;
  $("company-news-retry").hidden = Boolean(loading) || !(failed || data?.unavailable.releases || data?.unavailable.filings);
}

async function loadCompanyNews(force = false) {
  if (!stock || !user || $("research").hidden || $("workspace").hidden) return;
  const ticker = stock.ticker;
  const cached = newsByStock.get(ticker);
  if (cached?.loading || (!force && cached?.expires > Date.now())) return;
  const request = { loading: true, data: cached?.data };
  newsByStock.set(ticker, request);
  renderCompanyNews();
  try {
    request.data = await api("/api/company-news?" + new URLSearchParams({ ticker }));
  } catch {
    request.failed = true;
  } finally {
    request.loading = false;
    request.expires = Date.now() + 300_000;
    if (newsByStock.get(ticker) === request && stock?.ticker === ticker) renderCompanyNews();
  }
}

function renderStockSector() {
  $("stock-symbol").textContent = stock.ticker + " · " + t(stock.sector);
}

function updateStockActions() {
  const ticker = stock?.ticker;
  const isSaved = saved.includes(ticker);
  const hasHolding = holdings.some(item => item.ticker === ticker);
  for (const id of ["watch-toggle", "result-watch"]) {
    const button = $(id);
    button.setAttribute("aria-pressed", String(isSaved));
    button.textContent = t(isSaved ? "★ On watchlist" : "☆ Add to watchlist");
    button.disabled = !ticker || watchPending;
  }
  for (const id of ["stock-holding", "result-holding"]) {
    $(id).textContent = t(hasHolding ? "Edit holding" : "Add holding");
    $(id).disabled = !ticker || holdingPending;
  }
}

async function loadMarket() {
  if (!stock || !user) return;
  const current = ++marketRequest;
  market = null;
  $("price").textContent = "—";
  $("change").textContent = "";
  marketStatus = "Loading closing prices…";
  $("chart-labels").replaceChildren();
  renderMarketQuote();
  try {
    const params = new URLSearchParams({ ticker: stock.ticker, horizon: settings().horizon });
    const result = await api("/api/market?" + params);
    if (current !== marketRequest) return;
    market = result;
    renderMarketQuote();
  } catch {
    if (current !== marketRequest) return;
    marketStatus = "Closing prices are unavailable. Check the market data configuration.";
    renderMarketQuote();
  }
}

function renderMarketQuote() {
  if (!market) {
    $("market-date").textContent = marketStatus ? t(marketStatus) : "";
    drawChart();
    return;
  }
  const { from, asOf, last, change, sessions } = market.metrics;
  $("price").textContent = money.format(last);
  $("change").textContent = signedPercent.format(change / 100);
  $("change").classList.toggle("negative", change < 0);
  const modeLabel = t(market.marketMode === "demo" ? "Synthetic close" : "Latest available close");
  $("market-date").textContent = [modeLabel, dateLabel(asOf), t("{count} trading sessions", { count: sessions })].join(" · ");
  $("chart-labels").replaceChildren(el("span", calendar.format(new Date(from))), el("span", calendar.format(new Date(asOf))));
  drawChart();
}

function drawChart() {
  const canvas = $("chart");
  const { width, height } = canvas.getBoundingClientRect();
  if (!width || !height) return;
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  const context = canvas.getContext("2d");
  context.scale(ratio, ratio);
  if (!market) {
    canvas.setAttribute("aria-label", t("Closing-price chart for the selected horizon"));
    return;
  }
  const points = market.prices.slice(-market.metrics.sessions - 1);
  const lows = Math.min(...points.map(point => point.close));
  const highs = Math.max(...points.map(point => point.close));
  const spread = Math.max(highs - lows, 0.1);
  const margin = 10;
  context.font = "11px Segoe UI";
  const labelWidth = Math.max(59, context.measureText(money.format(highs)).width + 10);
  const span = width - labelWidth - margin;
  const right = margin + span;
  const x = index => margin + span * index / (points.length - 1);
  const y = price => height - margin - (price - lows) / spread * (height - 2 * margin);
  const palette = getComputedStyle(canvas);
  context.strokeStyle = palette.getPropertyValue("--line").trim();
  context.fillStyle = palette.getPropertyValue("--muted").trim();
  for (let i = 0; i < 4; i++) {
    const value = lows + spread * i / 3;
    const h = y(value);
    context.beginPath();
    context.moveTo(margin, h);
    context.lineTo(right, h);
    context.stroke();
    context.fillText(money.format(value), right + 6, h + 4);
  }
  const color = palette.getPropertyValue(market.metrics.change >= 0 ? "--up" : "--red").trim();
  const fade = context.createLinearGradient(0, 0, 0, height);
  fade.addColorStop(0, color + "30");
  fade.addColorStop(1, color + "00");
  pricePath(context, points, x, y);
  context.lineTo(right, height);
  context.lineTo(margin, height);
  context.closePath();
  context.fillStyle = fade;
  context.fill();
  pricePath(context, points, x, y);
  context.strokeStyle = color;
  context.lineWidth = 2;
  context.stroke();
  canvas.setAttribute("aria-label", t("{ticker} closing prices from {from} to {to}, change {change}.", {
    ticker: stock.ticker, from: dateLabel(market.metrics.from), to: dateLabel(market.metrics.asOf),
    change: signedPercent.format(market.metrics.change / 100)
  }));
}

const providerLabel = id => t(config.providers.find(item => item.id === id)?.label ?? id);

const outlookBands = [
  { min: 80, tone: "strong-upside", label: "Strong upside signal", agentLabel: "Strongly favorable",
    description: "The scored evidence strongly favors an increase over this time horizon." },
  { min: 65, tone: "upside", label: "Upside lean", agentLabel: "Favorable",
    description: "The scored evidence leans toward an increase over this time horizon." },
  { min: 45, tone: "mixed", label: "Mixed outlook", agentLabel: "Mixed evidence",
    description: "The combined evidence gives no clear direction over this time horizon." },
  { min: 30, tone: "downside", label: "Downside lean", agentLabel: "Unfavorable",
    description: "The scored evidence leans toward a decline over this time horizon." },
  { min: 0, tone: "strong-downside", label: "Strong downside signal", agentLabel: "Strongly unfavorable",
    description: "The scored evidence strongly favors a decline over this time horizon." }
];
const unscored = { tone: "unscored", label: "Unscored", agentLabel: "Unscored",
  description: "None of the agents produced a usable score. Check their explanations below." };

function scoreOutlook(score) {
  if (!Number.isFinite(score)) return unscored;
  return outlookBands.find(band => score >= band.min) ?? unscored;
}

function scoreRing(score, outlook) {
  const ring = el("div", undefined, "score-ring");
  const hasScore = outlook !== unscored;
  ring.dataset.outlook = outlook.tone;
  ring.setAttribute("role", "img");
  ring.setAttribute("aria-label", hasScore ? t("{score} out of 100", { score }) : t("Unscored"));
  if (hasScore) ring.style.setProperty("--score-progress", score / 100 + "turn");
  const value = el("div", undefined, "score-ring-value");
  value.setAttribute("aria-hidden", "true");
  value.append(el("strong", hasScore ? String(score) : "—"));
  if (hasScore) value.append(el("span", "/ 100"));
  ring.append(value);
  return ring;
}

function explainOutlook(result, outlook) {
  const scored = result.agents.filter(agent => Number.isFinite(agent.score)).sort((a, b) => b.score - a.score);
  const best = scored[0];
  const worst = scored.at(-1);
  if (best?.score >= 65 && worst?.score < 45) {
    return t(outlook.description) + " " + t("Agents disagreed. {best} was favorable ({high}/100) and {worst} was unfavorable ({low}/100).", {
      best: t(best.name), high: best.score, worst: t(worst.name), low: worst.score
    });
  }
  return t(outlook.description);
}

function localizedRationale(agent) {
  if (language === "en") return agent.rationale;
  if (agent.rationaleDe) return agent.rationaleDe;
  const asText = t(agent.rationale);
  if (asText !== agent.rationale) return asText;

  const cash = /^Illustrative cash of \$([\d.]+)B versus \$([\d.]+)B of fixture debt\./.exec(agent.rationale);
  if (cash) {
    return t("Illustrative cash of ${cash}B versus ${debt}B of fixture debt. Operating cash generation also affects the score.", {
      cash: decimal.format(Number(cash[1])), debt: decimal.format(Number(cash[2]))
    });
  }
  const momentum = /^Synthetic closing prices moved (-?[\d.]+)% over (\d+) sessions\./.exec(agent.rationale);
  if (momentum) {
    return t("Synthetic closing prices moved {change}% over {count} sessions. The score moves with the strength and direction of that trend.", {
      change: decimal.format(Number(momentum[1])), count: momentum[2]
    });
  }
  const httpError = /^The model provider returned HTTP (\d+)\.$/.exec(agent.rationale);
  return httpError ? t("The model provider returned HTTP {status}.", { status: httpError[1] }) : agent.rationale;
}

function parseSourceData(text) {
  try { return JSON.parse(text); }
  catch { return null; }
}

function localizedSource(source) {
  const data = source.id?.endsWith("-data") ? parseSourceData(source.text) : null;
  if (data) {
    const entries = Object.hasOwn(data, "from")
      ? [
          ["From", dateLabel(data.from)], ["As of", dateLabel(data.asOf)],
          ["First close", money.format(data.first)], ["Last close", money.format(data.last)],
          ["Change", signedPercent.format(data.change / 100)], ["Trading sessions", shareCount.format(data.sessions)]
        ]
      : [
          ["As of", data.as_of ? dateLabel(data.as_of) : "—"],
          ...[["Cash", data.cash], ["Debt", data.debt], ["Operating cash flow", data.operatingCash], ["Revenue", data.revenue]]
            .map(([label, value]) => [label, value == null ? "—" : money.format(value)])
        ];
    return { text: entries.map(([label, value]) => t(label) + " " + value).join(" · ") };
  }
  if (language === "en") return { text: source.text };
  const synthetic = /^Synthetic (\w+) example\. (.*)$/.exec(source.text);
  if (synthetic && !source.url) {
    const lead = t("Synthetic {ticker} example.", { ticker: synthetic[1] });
    return { text: lead + " " + synthetic[2].split(/(?<=\.) /).map(sentence => t(sentence)).join(" ") };
  }
  return { text: source.text, original: true };
}

function sourceItem(source) {
  const item = el("li");
  const label = t(source.title) + (source.date ? " · " + dateLabel(source.date) : "");
  if (source.url?.startsWith("https://")) {
    const link = el("a", label);
    link.href = source.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    item.append(link);
  } else {
    item.append(el("span", label));
  }
  const { text, original } = localizedSource(source);
  const excerpt = el("blockquote", text);
  if (original) {
    excerpt.lang = "en";
    item.append(el("small", t("Original excerpt in English"), "content-language"));
  }
  item.append(excerpt);
  return item;
}

function scoreChange(previous, current) {
  const value = el("span", undefined, "comparison-change");
  if (!Number.isFinite(previous) || !Number.isFinite(current)) {
    value.textContent = t(Number.isFinite(current) ? "Now scored" : Number.isFinite(previous) ? "Now unscored" : "Unscored");
    return value;
  }
  const change = current - previous;
  if (change === 0) {
    value.textContent = t("No change");
  } else {
    const delta = change > 0 ? "+" + change : "−" + Math.abs(change);
    value.textContent = t(Math.abs(change) === 1 ? "{delta} point" : "{delta} points", { delta });
    value.dataset.direction = change > 0 ? "up" : "down";
  }
  return value;
}

function scoreComparisonRow(label, previous, current) {
  const row = el("tr");
  const title = el("th", label);
  title.scope = "row";
  const showScore = score => Number.isFinite(score) ? score + "/100" : t("Unscored");
  const change = el("td");
  change.append(scoreChange(previous, current));
  row.append(title, el("td", showScore(previous)), el("td", showScore(current)), change);
  return row;
}

function renderComparison(result) {
  const content = $("comparison-content");
  const summary = $("comparison-summary");
  const comparison = compareWithPrevious(result, history);
  if (!comparison) {
    summary.textContent = t("No matching earlier run");
    content.replaceChildren(el("p", t("Run another analysis for this stock with the same settings to compare results.")));
    return;
  }
  const { previous, agents, addedSources, updatedSources } = comparison;
  summary.replaceChildren(scoreChange(previous.score, result.score));

  const dates = el("dl", undefined, "comparison-dates");
  for (const [label, run] of [["Earlier run", previous], ["Current run", result]]) {
    const entry = el("div");
    const date = el("time", runDate.format(new Date(run.createdAt)));
    date.dateTime = run.createdAt;
    const value = el("dd");
    value.append(date);
    entry.append(el("dt", t(label)), value);
    dates.append(entry);
  }
  const openEarlier = el("button", t("Open earlier result"), "secondary");
  openEarlier.type = "button";
  openEarlier.addEventListener("click", () => {
    openAnalysis(previous);
    $("analysis-comparison").querySelector("summary").focus({ preventScroll: true });
  });
  const header = el("div", undefined, "comparison-header");
  header.append(dates, openEarlier);

  const table = el("table", undefined, "comparison-table");
  table.setAttribute("aria-label", t("Analysis score comparison"));
  const headings = table.createTHead().insertRow();
  for (const title of ["Score", "Earlier", "Current", "Change"]) {
    const heading = el("th", t(title));
    heading.scope = "col";
    headings.append(heading);
  }
  table.createTBody().append(
    scoreComparisonRow(t("Overall"), previous.score, result.score),
    ...agents.map((agent, index) => scoreComparisonRow(agentTitle(agent.current, index), agent.previous.score, agent.current.score))
  );
  content.replaceChildren(header, table);
  if (agents.some(({ previous, current }) => Number.isFinite(previous.score) !== Number.isFinite(current.score))) {
    content.append(el("p", t("Different agents contributed scores to the two totals.")));
  }

  const evidence = el("div", undefined, "comparison-evidence");
  for (const [title, sources, emptyMessage] of [
    ["Newly cited sources", addedSources, "All cited sources already appeared in the earlier run."],
    ["Updated data snapshots", updatedSources, "Shared data snapshots are unchanged."]
  ]) {
    evidence.append(el("h3", t(title)));
    if (sources.length) {
      const list = el("ul");
      list.append(...sources.map(sourceItem));
      evidence.append(list);
    } else {
      evidence.append(el("p", t(emptyMessage)));
    }
  }
  content.append(evidence);
}

function renderResult(result) {
  if (displayedResult?.id !== result.id) $("analysis-comparison").open = false;
  displayedResult = result;
  $("result-panel").hidden = false;
  $("result-title").textContent = t("{ticker} · {range} outlook", { ticker: result.ticker, range: t(ranges[result.horizon]) });
  const summary = [
    providerLabel(result.provider),
    t("{scored} of {total} agents scored", { scored: result.scoredAgents, total: result.agentCount })
  ];
  if (result.min != null) summary.push(t("Score range {min}–{max}", { min: result.min, max: result.max }));
  if (result.marketMode === "demo") summary.push(t("Synthetic evidence"));
  $("result-meta").textContent = summary.join(" · ");
  const outlook = scoreOutlook(result.score);
  $("result-summary").dataset.outlook = outlook.tone;
  $("result-outlook").textContent = t(outlook.label);
  $("result-explanation").textContent = explainOutlook(result, outlook);
  $("result-score").replaceChildren(scoreRing(result.score, outlook));
  renderComparison(result);
  $("agent-results").replaceChildren(...result.agents.map((agent, index) => {
    const card = el("article", undefined, "card agent-card");
    const agentOutlook = scoreOutlook(agent.score);
    const heading = el("header", undefined, "agent-heading");
    const signal = el("span", t(agentOutlook.agentLabel), "agent-outlook");
    signal.dataset.outlook = agentOutlook.tone;
    heading.append(el("h3", agentTitle(agent, index)), signal);
    const evidence = el("div", undefined, "agent-evidence");
    const rationale = el("p", localizedRationale(agent));
    if (language === "de" && !agent.rationaleDe && rationale.textContent === agent.rationale) {
      rationale.lang = "en";
      evidence.append(el("small", t("English original"), "content-language"));
    }
    evidence.append(rationale);
    if (agent.sources.length) {
      const info = el("details");
      info.append(el("summary", agent.sources.length === 1 ? t("Source") : t("{count} sources", { count: agent.sources.length })));
      const list = el("ul");
      list.append(...agent.sources.map(sourceItem));
      info.append(list);
      evidence.append(info);
    }
    card.append(heading, scoreRing(agent.score, agentOutlook), evidence);
    return card;
  }));
}

function listRow(title, sub, action, onClick) {
  const row = el("div", undefined, "list-row");
  const detail = el("div");
  detail.append(el("h3", title), el("p", sub));
  const button = el("button", t(action), "secondary");
  button.type = "button";
  button.addEventListener("click", onClick);
  row.append(detail, button);
  return row;
}

function loadClose(ticker) {
  const cached = closingQuotes.get(ticker);
  if (cached && cached.expires > Date.now()) return cached.request;
  const request = api("/api/market?" + new URLSearchParams({ ticker, horizon: "1w" }))
    .then(({ prices }) => {
      const previous = prices.at(-2);
      const latest = prices.at(-1);
      return { price: latest.close, date: latest.date, change: latest.close / previous.close - 1 };
    }).catch(() => {
      if (closingQuotes.get(ticker)?.request === request) closingQuotes.delete(ticker);
      return null;
    });
  closingQuotes.set(ticker, { request, expires: Date.now() + 60_000 });
  return request;
}

function positionAction(text, label, onClick) {
  const button = el("button", t(text), "secondary");
  button.type = "button";
  button.setAttribute("aria-label", label);
  button.addEventListener("click", onClick);
  return button;
}

function positionRow(ticker, subtitle) {
  const name = config.stocks.find(item => item.ticker === ticker)?.name;
  const row = el("article", undefined, "card position-row");
  const heading = el("header", undefined, "position-heading");
  const identity = el("div");
  identity.append(el("h3", name ? ticker + " · " + name : ticker), el("p", subtitle));
  const actions = el("div", undefined, "row-actions");
  actions.append(positionAction("Research", t("Research {ticker}", { ticker }), () => openResearch(ticker)));
  const metrics = el("dl", undefined, "position-metrics");
  heading.append(identity, actions);
  row.append(heading, metrics);
  return { row, actions, metrics };
}

function addMetric(group, label, initial = "—") {
  const term = el("div");
  const value = el("dd", t(initial));
  term.append(el("dt", t(label)), value);
  group.append(term);
  return value;
}

function setMetric(node, value, detail, change) {
  node.textContent = t(value);
  if (detail) node.append(el("small", detail));
  if (change) node.dataset.direction = change < 0 ? "down" : "up";
}

function emptyPosition(title, description) {
  const card = el("div", undefined, "card position-empty");
  card.append(el("h3", t(title)), el("p", t(description)));
  return card;
}

function stockOption(value, label) {
  const option = el("option", label);
  option.value = value;
  return option;
}

function watchUpdateRow(update) {
  const { ticker, kind, date } = update;
  const row = el("li", undefined, "watch-update");
  const info = el("div");
  const title = el("p", undefined, "watch-update-title");
  const daily = kind === "price";
  title.append(el("strong", ticker), el("span", t(daily ? "Daily price move" : "SEC Form {form}", { form: update.form })));
  if (daily) {
    const move = el("strong", signedPercent.format(update.change / 100), "watch-update-move");
    move.dataset.direction = update.change > 0 ? "up" : "down";
    title.append(move);
  }
  const time = el("time", dateLabel(date));
  time.dateTime = date;
  const details = el("p", undefined, "watch-update-date");
  details.append(time);
  if (daily) details.append(" · " + t("Close {price}", { price: money.format(update.close) }));
  if (!daily && !update.url) details.append(" · " + t("Demo filing"));
  info.append(title, details);

  const actions = el("div", undefined, "row-actions");
  if (!daily && update.url?.startsWith("https://www.sec.gov/Archives/edgar/data/")) {
    const link = el("a", t("Open SEC filing"), "secondary");
    link.href = update.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.setAttribute("aria-label", t("Open {ticker} SEC Form {form}", { ticker, form: update.form }));
    actions.append(link);
  }
  actions.append(positionAction("Research", t("Research {ticker}", { ticker }), () => openResearch(ticker)));
  row.append(info, actions);
  return row;
}

function renderWatchUpdates() {
  const refresh = $("watch-updates-refresh");
  const list = $("watch-updates-list");
  const status = $("watch-updates-status");
  const more = $("watch-updates-more");
  const { data, loading, failed, expanded } = watchUpdates ?? {};
  refresh.hidden = !saved.length;
  refresh.disabled = Boolean(loading);
  list.setAttribute("aria-busy", String(Boolean(loading)));
  $("watch-updates-caption").textContent = data
    ? t("Past {days} days · Close-to-close moves of {minimum}% or more", { days: data.days, minimum: data.minimumMove })
    : t("Recent filings and large moves in daily closing prices.");

  const visible = data ? data.events.slice(0, expanded ? undefined : 6) : [];
  list.replaceChildren(...visible.map(watchUpdateRow));
  more.hidden = !data || data.events.length <= 6;
  more.textContent = t(expanded ? "Show fewer updates" : "Show more updates");
  more.setAttribute("aria-expanded", String(Boolean(expanded)));

  const messages = [];
  if (!saved.length) messages.push(t("Add a stock to see its filings and daily price moves here."));
  if (loading) messages.push(t("Loading watchlist updates…"));
  if (failed) messages.push(t(data ? "Refresh failed. Showing the last loaded updates." : "Updates could not be loaded. Try refreshing."));
  if (data) {
    const { prices, filings } = data.unavailable;
    if (prices.length) messages.push(t("Price moves unavailable for {stocks}.", { stocks: prices.join(", ") }));
    if (filings.length) messages.push(t("Filings unavailable for {stocks}.", { stocks: filings.join(", ") }));
    if (!data.events.length) messages.push(t(prices.length || filings.length
      ? "No updates from the available data." : "No qualifying updates in this period."));
    if (visible.length < data.total) messages.push(t("Showing {shown} of {total} updates.", { shown: visible.length, total: data.total }));
  }
  status.textContent = messages.join(" ");
  status.hidden = !messages.length;
}

async function loadWatchUpdates(force = false) {
  const key = [...saved].sort().join(",");
  const existing = watchUpdates?.key === key ? watchUpdates : null;
  if (!key || existing?.loading || (!force && existing?.expires > Date.now())) {
    if (!key) watchUpdates = null;
    renderWatchUpdates();
    return;
  }
  const request = { key, data: existing?.data, expanded: existing?.expanded, loading: true };
  watchUpdates = request;
  renderWatchUpdates();
  try {
    request.data = await api("/api/watchlist/updates");
  } catch {
    request.failed = true;
  } finally {
    request.loading = false;
    request.expires = Date.now() + 120_000;
    if (watchUpdates === request) renderWatchUpdates();
  }
}

function renderWatchlist() {
  void loadWatchUpdates();
  const picker = $("watch-stock");
  const selection = picker.value;
  const available = config.stocks.filter(item => !saved.includes(item.ticker));
  picker.replaceChildren(stockOption("", t("Choose a stock")), ...available.map(item => stockOption(item.ticker, item.ticker + " · " + item.name)));
  if (available.some(item => item.ticker === selection)) picker.value = selection;
  $("watch-form").hidden = !available.length;
  $("watch-all").hidden = Boolean(available.length);
  updateWatchPicker();

  const rows = saved.map(ticker => {
    const item = config.stocks.find(item => item.ticker === ticker);
    const { row, actions, metrics } = positionRow(ticker, t(item?.sector ?? "Saved stock"));
    actions.append(positionAction("Remove", t("Remove {ticker} from watchlist", { ticker }), event => {
      void saveWatch(ticker, false, event.currentTarget);
    }));
    const close = addMetric(metrics, "Latest close", "Loading…");
    const daily = addMetric(metrics, "1-day change");
    const lastRun = history.find(item => item.ticker === ticker);
    const research = addMetric(metrics, "Latest saved analysis", "No analysis yet");
    if (lastRun) {
      const score = lastRun.score == null ? t("Unscored") : lastRun.score + "/100";
      const open = el("button", score + " · " + t(ranges[lastRun.horizon]), "text-button");
      open.type = "button";
      open.setAttribute("aria-label", t("Open latest analysis for {ticker}, {result}", { ticker, result: open.textContent }));
      open.addEventListener("click", () => openAnalysis(lastRun));
      research.replaceChildren(open, el("small", eventDate.format(new Date(lastRun.createdAt))));
    }
    void loadClose(ticker).then(quote => {
      setMetric(close, quote ? money.format(quote.price) : "Unavailable", quote ? dateLabel(quote.date) : null);
      if (quote) setMetric(daily, signedPercent.format(quote.change), null, quote.change);
    });
    return row;
  });
  $("watch-items").replaceChildren(...(rows.length ? rows : [emptyPosition("No stocks on your watchlist",
    "Choose a stock above, or add it while you’re viewing its chart or analysis.")]));
}

function updateWatchPicker() {
  $("watch-stock").disabled = watchPending;
  $("watch-add").disabled = watchPending || !$("watch-stock").value;
}

async function saveWatch(ticker, add, button) {
  if (!ticker || watchPending) return;
  const version = signedInVersion;
  watchPending = true;
  button.disabled = true;
  updateStockActions();
  updateWatchPicker();
  let changed = false;
  try {
    const data = await api("/api/watchlist", "PUT", { ticker, add });
    if (version !== signedInVersion) return;
    saved = data.watchlist;
    watchUpdates = null;
    changed = true;
    notice(add ? "{ticker} added to your watchlist." : "{ticker} removed from your watchlist.", false, { ticker });
  } catch (error) {
    if (version === signedInVersion) notice(error.message, true);
  } finally {
    if (version === signedInVersion) {
      watchPending = false;
      button.disabled = false;
      updateStockActions();
      if (changed && !$("watchlist").hidden) renderWatchlist();
      else updateWatchPicker();
    }
  }
}

function openAnalysis(result) {
  selectSettings({ provider: result.provider, horizon: result.horizon, agentCount: result.agentCount });
  openView("research");
  void chooseStock(result.ticker, true);
  renderResult(result);
  $("result-panel").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function renderHistory() {
  const rows = history.map(result => listRow(result.ticker + " · " + t(ranges[result.horizon]) + " · " + (result.score == null ? t("Unscored") : result.score + "/100"),
    (Number.isFinite(result.score) ? t(scoreOutlook(result.score).label) + " · " : "")
      + providerLabel(result.provider) + " · " + eventDate.format(new Date(result.createdAt)), "Open result", () => openAnalysis(result)));
  $("history-items").replaceChildren(...(rows.length ? rows : [el("p", t("Run an analysis to start your history."), "empty")]));
}

function prepareHolding(ticker = "") {
  const holding = holdings.find(item => item.ticker === ticker);
  $("holding-stock").value = ticker;
  $("holding-shares").value = holding?.shares ?? "";
  $("holding-cost").value = holding?.average_cost ?? "";
  updateHoldingLabels();
}

function updateHoldingLabels() {
  const ticker = $("holding-stock").value;
  const editing = holdings.some(item => item.ticker === ticker);
  $("holding-form-title").textContent = editing ? t("Edit {ticker} holding", { ticker }) : t("Add a holding");
  $("holding-save").textContent = t(editing ? "Save changes" : "Add holding");
  $("holding-cancel").hidden = !ticker;
}

function openHolding(ticker) {
  if (holdingPending) return;
  openView("portfolio");
  prepareHolding(ticker);
  $("holding-shares").focus();
}

async function saveHolding(ticker, shares, averageCost, button) {
  if (holdingPending) return;
  const version = signedInVersion;
  holdingPending = true;
  button.disabled = true;
  $("holding-fields").disabled = true;
  updateStockActions();
  let changed = false;
  try {
    const data = await api("/api/holdings", "PUT", { ticker, shares, averageCost });
    if (version !== signedInVersion) return;
    holdings = data.portfolio;
    changed = true;
    if (shares || $("holding-stock").value === ticker) prepareHolding();
    notice(shares ? "{ticker} holding saved." : "{ticker} holding removed.", false, { ticker });
  } catch (error) {
    if (version === signedInVersion) notice(error.message, true);
  } finally {
    if (version === signedInVersion) {
      holdingPending = false;
      button.disabled = false;
      $("holding-fields").disabled = false;
      updateStockActions();
      if (changed && !$("portfolio").hidden) renderPortfolio();
    }
  }
}

function renderPortfolio() {
  const totals = $("portfolio-totals");
  const coverage = $("portfolio-coverage");
  totals.replaceChildren();
  coverage.textContent = "";
  $("portfolio-overview").hidden = !holdings.length;
  if (!holdings.length) {
    $("holding-items").replaceChildren(emptyPosition("No holdings yet", "Add a stock you own with the number of shares and what you paid per share."));
    return;
  }
  const count = holdings.length;
  const costTotal = holdings.reduce((sum, item) => sum + item.shares * item.average_cost, 0);
  addMetric(totals, "Total cost basis", money.format(costTotal));
  const marketValue = addMetric(totals, "Market value", "Loading…");
  const gain = addMetric(totals, "Unrealized gain or loss");

  const positions = holdings.map(({ ticker, shares, average_cost: cost }) => {
    const basis = shares * cost;
    const { row, actions, metrics } = positionRow(ticker, t(Number(shares) === 1 ? "{count} share" : "{count} shares", { count: shareCount.format(shares) }));
    actions.append(positionAction("Edit", t("Edit {ticker} holding", { ticker }), () => openHolding(ticker)),
      positionAction("Remove", t("Remove {ticker} holding", { ticker }), event => {
        if (holdingPending || !window.confirm(t("Remove {ticker} from your portfolio?", { ticker }))) return;
        void saveHolding(ticker, 0, 0, event.currentTarget);
      }));
    addMetric(metrics, "Average cost", money.format(cost));
    addMetric(metrics, "Cost basis", money.format(basis));
    const close = addMetric(metrics, "Latest close", "Loading…");
    const value = addMetric(metrics, "Market value");
    const gain = addMetric(metrics, "Unrealized gain or loss");
    const valuation = loadClose(ticker).then(quote => {
      setMetric(close, quote ? money.format(quote.price) : "Unavailable", quote ? dateLabel(quote.date) : null);
      if (!quote) return null;
      const current = quote.price * shares;
      const pnl = current - basis;
      setMetric(value, money.format(current));
      setMetric(gain, signedMoney.format(pnl), signedPercent.format(pnl / basis), pnl);
      return { current, basis };
    });
    return { row, valuation };
  });
  $("holding-items").replaceChildren(...positions.map(({ row }) => row));
  void Promise.all(positions.map(({ valuation }) => valuation)).then(values => {
    if (!marketValue.isConnected) return;
    const priced = values.filter(Boolean);
    if (!priced.length) {
      setMetric(marketValue, "Unavailable");
      coverage.textContent = t("Closing prices are unavailable for all holdings.");
      return;
    }
    const current = priced.reduce((sum, item) => sum + item.current, 0);
    const basis = priced.reduce((sum, item) => sum + item.basis, 0);
    setMetric(marketValue, money.format(current));
    setMetric(gain, signedMoney.format(current - basis), signedPercent.format((current - basis) / basis), current - basis);
    coverage.textContent = priced.length === count
      ? t(config.marketMode === "demo" ? "Based on synthetic closes." : "Based on the latest available closing prices.")
      : t("Market value and gain or loss cover {priced} of {total} holdings with available prices.", { priced: priced.length, total: count });
  });
}

$("auth-switch").addEventListener("click", () => {
  authAction = authAction === "login" ? "signup" : "login";
  notice();
  authControls();
});
$("auth-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (authAction === "verify" && config.confirmationMode !== "code") {
    authAction = "login";
    notice();
    authControls();
    return;
  }
  await submitAccount(config.hosted ? authAction : "demo");
});
$("resend-confirmation").addEventListener("click", async () => {
  if ($("email").reportValidity()) await submitAccount("resend");
});

async function submitAccount(action) {
  const buttons = ["sign-in", "auth-switch", "resend-confirmation"].map($);
  for (const button of buttons) button.disabled = true;
  notice();
  try {
    const input = { action, email: $("email").value.trim() };
    if (action === "signup") input.username = $("username").value;
    if (action === "signup" || action === "login") input.password = $("password").value;
    if (action === "verify") input.code = $("email-code").value;
    const result = await api("/api/account", "POST", input);
    $("password").value = "";
    $("email-code").value = "";
    if (result.signedIn) {
      authAction = "login";
      await showAccount((await api("/api/session")).user);
    } else if (result.verificationRequired) {
      authAction = "verify";
      authControls();
      if (config.confirmationMode === "code") $("email-code").focus();
      if (action === "resend") accountNotice(result.message);
    }
  } catch (error) {
    accountNotice(error.message, true);
  } finally {
    for (const button of buttons) button.disabled = false;
  }
}
$("logout").addEventListener("click", async () => {
  try {
    await api("/api/logout", "POST");
    notice();
    await showAccount(null);
  } catch (error) { notice(error.message, true); }
});
document.querySelectorAll("[data-view]").forEach(item => item.addEventListener("click", () => openView(item.dataset.view)));
$("stock-search").addEventListener("input", renderSearch);
$("stock-search").addEventListener("focus", renderSearch);
$("universe").addEventListener("change", renderSearch);
$("stock-search").addEventListener("keydown", event => {
  if (event.key === "Escape") $("search-results").hidden = true;
  if (["ArrowDown", "Enter"].includes(event.key)) {
    const match = $("search-results").querySelector("button");
    if (match && !$("search-results").hidden) {
      event.preventDefault();
      if (event.key === "Enter") match.click();
      else match.focus();
    }
  }
});
document.addEventListener("pointerdown", event => {
  if (!event.target.closest(".stock-search")) $("search-results").hidden = true;
});
for (const id of ["watch-toggle", "result-watch"]) {
  $(id).addEventListener("click", event => {
    const ticker = stock?.ticker;
    void saveWatch(ticker, !saved.includes(ticker), event.currentTarget);
  });
}
for (const id of ["stock-holding", "result-holding"]) {
  $(id).addEventListener("click", () => openHolding(stock.ticker));
}
$("watch-stock").addEventListener("change", updateWatchPicker);
$("watch-updates-refresh").addEventListener("click", () => { void loadWatchUpdates(true); });
$("watch-updates-more").addEventListener("click", () => {
  watchUpdates.expanded = !watchUpdates.expanded;
  renderWatchUpdates();
});
$("watch-form").addEventListener("submit", event => {
  event.preventDefault();
  void saveWatch($("watch-stock").value, true, $("watch-add"));
});
$("analysis-form").addEventListener("change", event => {
  showAgentPreview();
  if (event.target.name === "horizon") loadMarket();
});
$("save-pref").addEventListener("click", async () => {
  try {
    await api("/api/preferences", "PUT", settings());
    notice("Analysis defaults saved.");
  } catch (error) { notice(error.message, true); }
});
$("holding-stock").addEventListener("change", event => prepareHolding(event.target.value));
$("holding-cancel").addEventListener("click", () => {
  prepareHolding();
  $("holding-stock").focus();
});
$("holding-form").addEventListener("submit", event => {
  event.preventDefault();
  void saveHolding($("holding-stock").value, $("holding-shares").valueAsNumber, $("holding-cost").valueAsNumber, $("holding-save"));
});
$("analysis-form").addEventListener("submit", async event => {
  event.preventDefault();
  const button = $("run-button");
  const ticker = stock.ticker;
  const currentUser = signedInVersion;
  button.setAttribute("aria-busy", "true");
  updateAnalysisControls();
  notice();
  try {
    const { result } = await api("/api/analysis", "POST", { ticker, ...settings() });
    if (currentUser !== signedInVersion) return;
    history = [result, ...history].slice(0, 75);
    if (stock?.ticker === ticker) {
      renderResult(result);
      if (!$("research").hidden) $("result-panel").scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
    if (!$("history").hidden) renderHistory();
    if (!$("watchlist").hidden) renderWatchlist();
    if (stock?.ticker !== ticker || $("research").hidden) notice("{ticker} analysis saved to history.", false, { ticker });
  } catch (error) { if (currentUser === signedInVersion) notice(error.message, true); }
  finally {
    button.removeAttribute("aria-busy");
    updateAnalysisControls();
  }
});
new ResizeObserver(drawChart).observe($("chart").parentElement);
new IntersectionObserver(([entry]) => {
  newsInView = entry.isIntersecting;
  if (newsInView) void loadCompanyNews();
}, { rootMargin: "180px" }).observe($("company-news"));
$("company-news-retry").addEventListener("click", () => { void loadCompanyNews(true); });

function renderScoreScale() {
  $("score-scale").replaceChildren(...outlookBands.map((band, index) => {
    const max = index === 0 ? 100 : outlookBands[index - 1].min - 1;
    const item = el("li", band.min + "–" + max + " " + t(band.label));
    item.dataset.outlook = band.tone;
    return item;
  }));
}

function renderDataState() {
  const dataState = $("data-state");
  const demo = config.marketMode === "demo";
  dataState.textContent = t(demo ? "Synthetic demo data" : "Real market data");
  dataState.title = t(demo ? "Sample prices and filings for demonstration"
    : "Daily closes from Twelve Data and company filings from SEC EDGAR");
  dataState.hidden = false;
}

function providerOptionLabel(provider) {
  return t(provider.label) + (provider.enabled ? "" : " · " + t("setup required"));
}

function applyLanguage(next) {
  language = next;
  ({ money, signedMoney, signedPercent, shareCount, decimal, calendar, quoteDate, eventDate, runDate } = formatters(language));
  document.documentElement.lang = language;
  for (const [node, message] of staticCopy) node.textContent = t(message);
  for (const [node, attr, message] of staticAttributes) node.setAttribute(attr, t(message));
  for (const button of languageButtons) button.setAttribute("aria-pressed", String(button.dataset.language === language));
  renderNotice();
  renderScoreScale();
  const view = $("workspace").hidden ? "research" : document.querySelector(".view:not([hidden])").id;
  renderViewTitle(view);
  if (!config) return;

  renderDataState();
  renderMarketOverview();
  authControls();
  updateHoldingLabels();
  for (const option of $("provider").options) {
    const provider = config.providers.find(item => item.id === option.value);
    option.textContent = providerOptionLabel(provider);
  }
  if (!user || $("workspace").hidden) return;

  renderAccountName();
  openView(view);
  showAgentPreview();
  if (stock) {
    renderStockSector();
    renderMarketQuote();
    updateStockActions();
    renderCompanyNews();
  }
  if (!$("search-results").hidden) renderSearch();
  if (displayedResult) {
    const expanded = [...$("agent-results").querySelectorAll("details")].map(item => item.open);
    renderResult(displayedResult);
    $("agent-results").querySelectorAll("details").forEach((item, index) => { item.open = Boolean(expanded[index]); });
  }
}

for (const button of languageButtons) {
  button.addEventListener("click", () => {
    const next = button.dataset.language;
    if (next === language) return;
    try { localStorage.setItem(languageKey, next); } catch { /* The current page can still switch languages. */ }
    applyLanguage(next);
  });
}
applyLanguage(language);

const emailReturn = new URLSearchParams(location.hash.slice(1));
const emailConfirmed = emailReturn.get("type") === "signup" && emailReturn.has("access_token");
const confirmationExpired = emailReturn.get("error_code") === "otp_expired";
if (emailConfirmed || confirmationExpired) {
  window.history.replaceState(null, "", location.pathname + location.search);
}

try {
  config = await api("/api/config");
  renderDataState();
  for (const stock of config.stocks) {
    $("holding-stock").append(stockOption(stock.ticker, stock.ticker + " · " + stock.name));
  }
  for (const provider of config.providers) {
    if (provider.id === "demo" && config.marketMode === "live") continue;
    const option = el("option", providerOptionLabel(provider));
    option.value = provider.id;
    option.disabled = !provider.enabled;
    if (provider.model) option.title = provider.model;
    $("provider").append(option);
  }
  await showAccount((await api("/api/session")).user);
  if (config.hosted && !user && emailConfirmed) accountNotice("Email confirmed. Sign in to open your workspace.");
  if (config.hosted && !user && confirmationExpired) {
    accountNotice("This confirmation link is invalid or has expired. Sign in to continue or request a new link.", true);
  }
} catch (error) {
  notice(error.message, true);
}
