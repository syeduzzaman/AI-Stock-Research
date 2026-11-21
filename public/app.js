const $ = id => document.getElementById(id);
const ranges = { "1w": "1 week", "1m": "1 month", "3m": "3 months", "6m": "6 months" };
const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const signedPercent = new Intl.NumberFormat("en-US", {
  style: "percent", signDisplay: "exceptZero", minimumFractionDigits: 2, maximumFractionDigits: 2
});
const calendar = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const eventDate = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" });
const defaults = { horizon: "1m", provider: "demo", agentCount: 5 };
let config;
let user;
let authAction = "login";
let stock;
let market;
let marketRequest = 0;
let featuredQuotes;
let loadingFeaturedQuotes = false;
let signedInVersion = 0;
let saved = [];
let holdings = [];
let history = [];

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

function notice(message, isError = false) {
  const box = $("notice");
  box.hidden = !message;
  box.textContent = message ?? "";
  box.classList.toggle("error", isError);
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
  return "Agent " + (index + 1) + " · " + agent.name;
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
  $("analysis-title").textContent = demo ? "Demo stock analysis" : "AI stock analysis";
  $("run-label").textContent = running ? "Running analysis…" : demo ? "Run demo analysis" : "Run AI analysis";
  button.disabled = running || !provider;
}

const viewTitles = {
  research: ["AI Stock Research", "Run independent analyses and follow the evidence behind each score."],
  watchlist: ["Watchlist", "Open the stocks you’ve saved for research."],
  portfolio: ["Portfolio", "Track your shares, cost basis, and value at the latest available close."],
  history: ["Analysis history", "Reopen scores, explanations, and the evidence from previous runs."]
};

function openView(view) {
  if (!user) return;
  const [title, description] = viewTitles[view];
  $("view-title").textContent = title;
  $("view-description").textContent = description;
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
}

function renderMarketOverview() {
  const showOverview = config.marketPreview || Boolean(user);
  $("market-overview").hidden = !showOverview;
  if (!showOverview) return;

  $("market-overview-caption").textContent = config.marketMode === "demo"
    ? "Synthetic closes · 20 sessions" : "Daily closes · 20 sessions";
  const tiles = (featuredQuotes ?? config.featuredStocks).map(({ ticker, name, prices }) => {
    const tile = el(user ? "button" : "article", undefined, "market-tile");
    if (user) {
      tile.type = "button";
      tile.addEventListener("click", () => {
        openView("research");
        chooseStock(ticker);
      });
    }

    const identity = el("div", undefined, "market-tile-identity");
    identity.append(el("strong", ticker), el("span", name));
    tile.append(identity);
    if (!prices?.length) {
      tile.append(el("span", prices ? "Price unavailable" : "Loading price…", "market-tile-status"));
      return tile;
    }

    const latest = prices.at(-1);
    const previous = prices.at(-2);
    const change = (latest.close - previous.close) / previous.close;
    const value = el("div", undefined, "market-tile-value");
    const close = el("strong", money.format(latest.close));
    close.title = "Closing price on " + latest.date;
    const daily = el("span", signedPercent.format(change), change < 0 ? "market-change negative" : "market-change");
    daily.title = "Change from previous close";
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
  $("account-title").textContent = signup ? "Create your account" : verify ? "Check your email" : login ? "Sign in" : "Open the demo workspace";
  $("account-intro").textContent = enterCode ? "Enter the verification code from your email."
    : followLink ? "Open the email from Supabase Auth and select Confirm your email. Then sign in to AI Stock Research."
    : hosted ? "Your watchlist, holdings, and analyses are saved to your account."
      : marketMode === "demo" ? "Try the research flow with synthetic prices and sample filing excerpts." : "Open a local workspace to research your stocks.";
  $("auth-fields").hidden = !hosted;
  $("username-field").hidden = !signup;
  $("password-field").hidden = !hosted || verify;
  $("code-field").hidden = !enterCode;
  $("auth-switch").hidden = !hosted || followLink;
  $("resend-confirmation").hidden = !verify;
  $("username").required = signup;
  $("email").required = hosted;
  $("password").required = hosted && !verify;
  $("email-code").required = enterCode;
  $("password").autocomplete = signup ? "new-password" : "current-password";
  $("sign-in").textContent = signup ? "Create account" : enterCode ? "Verify code" : followLink ? "Back to sign in" : login ? "Sign in" : "Open demo";
  $("sign-in").formNoValidate = followLink;
  $("auth-switch").textContent = login ? "Create account" : "Back to sign in";
}

async function showAccount(account) {
  signedInVersion += 1;
  user = account;
  void loadMarketOverview();
  $("result-panel").hidden = true;
  $("account-area").hidden = !user;
  $("account-panel").hidden = Boolean(user);
  $("workspace").hidden = !user;
  if (!user) {
    saved = [];
    holdings = [];
    history = [];
    $("agent-results").replaceChildren();
    $("history-items").replaceChildren();
    $("watch-items").replaceChildren();
    $("holding-items").replaceChildren();
    $("holding-form").reset();
    authControls();
    return;
  }
  const label = user.username ?? user.email ?? "Demo workspace";
  $("account-name").textContent = label;
  $("account-initials").textContent = label[0].toUpperCase();
  const initialMarketRequest = marketRequest;
  const data = await api("/api/workspace");
  saved = data.watchlist;
  holdings = data.portfolio;
  history = data.history;
  selectSettings(data.preferences);
  openView("research");
  if (marketRequest === initialMarketRequest) await chooseStock(saved[0] ?? config.stocks[0].ticker);
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
  $("search-results").replaceChildren(...(items.length ? items : [el("p", "No covered stock matched.", "empty")]));
  $("search-results").hidden = false;
}

async function chooseStock(ticker, keepResult = false) {
  stock = config.stocks.find(item => item.ticker === ticker);
  if (!stock) return;
  if (!keepResult) {
    $("result-panel").hidden = true;
  }
  $("stock-name").textContent = stock.name;
  $("stock-logo").textContent = stock.ticker.slice(0, 1);
  $("stock-symbol").textContent = stock.ticker + " · " + stock.sector;
  watchState();
  await loadMarket();
}

function watchState() {
  const isSaved = saved.includes(stock?.ticker);
  $("watch-toggle").setAttribute("aria-pressed", String(isSaved));
  $("watch-toggle").textContent = isSaved ? "★ Saved" : "☆ Save stock";
}

async function loadMarket() {
  if (!stock || !user) return;
  const current = ++marketRequest;
  market = null;
  $("price").textContent = "—";
  $("change").textContent = "";
  $("market-date").textContent = "Loading closing prices…";
  $("chart-labels").replaceChildren();
  drawChart();
  try {
    const params = new URLSearchParams({ ticker: stock.ticker, horizon: settings().horizon });
    const result = await api("/api/market?" + params);
    if (current !== marketRequest) return;
    market = result;
    const { from, asOf, last, change, sessions } = market.metrics;
    $("price").textContent = money.format(last);
    $("change").textContent = signedPercent.format(change / 100);
    $("change").classList.toggle("negative", change < 0);
    $("market-date").textContent = (market.marketMode === "demo" ? "Synthetic close" : "Latest available close") + " · " + asOf + " · " + sessions + " trading sessions";
    $("chart-labels").replaceChildren(el("span", calendar.format(new Date(from))), el("span", calendar.format(new Date(asOf))));
    drawChart();
  } catch {
    if (current === marketRequest) $("market-date").textContent = "Closing prices are unavailable. Check the market data configuration.";
  }
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
  if (!market) return;
  const points = market.prices.slice(-market.metrics.sessions - 1);
  const lows = Math.min(...points.map(point => point.close));
  const highs = Math.max(...points.map(point => point.close));
  const spread = Math.max(highs - lows, 0.1);
  const margin = 10;
  const labelWidth = 59;
  const span = width - labelWidth - margin;
  const right = margin + span;
  const x = index => margin + span * index / (points.length - 1);
  const y = price => height - margin - (price - lows) / spread * (height - 2 * margin);
  const palette = getComputedStyle(canvas);
  context.strokeStyle = palette.getPropertyValue("--line").trim();
  context.fillStyle = palette.getPropertyValue("--muted").trim();
  context.font = "11px Segoe UI";
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
  canvas.setAttribute("aria-label", stock.ticker + " closing prices from " + market.metrics.from + " to " + market.metrics.asOf
    + ", change " + market.metrics.change + " percent.");
}

const providerLabel = id => config.providers.find(item => item.id === id)?.label ?? id;

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
  ring.setAttribute("aria-label", hasScore ? score + " out of 100" : "Unscored");
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
    return outlook.description + " Agents disagreed. " + best.name + " was favorable (" + best.score
      + "/100) and " + worst.name + " was unfavorable (" + worst.score + "/100).";
  }
  return outlook.description;
}

function renderResult(result) {
  $("result-panel").hidden = false;
  $("result-title").textContent = result.ticker + " · " + ranges[result.horizon] + " outlook";
  const range = result.min == null ? "" : " · Score range " + result.min + "–" + result.max;
  const demo = result.marketMode === "demo" ? " · Synthetic evidence" : "";
  $("result-meta").textContent = providerLabel(result.provider) + " · " + result.scoredAgents + " of " + result.agentCount + " agents scored" + range + demo;
  const outlook = scoreOutlook(result.score);
  $("result-summary").dataset.outlook = outlook.tone;
  $("result-outlook").textContent = outlook.label;
  $("result-explanation").textContent = explainOutlook(result, outlook);
  $("result-score").replaceChildren(scoreRing(result.score, outlook));
  $("agent-results").replaceChildren(...result.agents.map((agent, index) => {
    const card = el("article", undefined, "card agent-card");
    const agentOutlook = scoreOutlook(agent.score);
    const heading = el("header", undefined, "agent-heading");
    const signal = el("span", agentOutlook.agentLabel, "agent-outlook");
    signal.dataset.outlook = agentOutlook.tone;
    heading.append(el("h3", agentTitle(agent, index)), signal);
    const evidence = el("div", undefined, "agent-evidence");
    evidence.append(el("p", agent.rationale));
    if (agent.sources.length) {
      const info = el("details");
      info.append(el("summary", agent.sources.length === 1 ? "Source" : agent.sources.length + " sources"));
      const list = el("ul");
      for (const source of agent.sources) {
        const item = el("li");
        const label = source.title + (source.date ? " · " + source.date : "");
        if (source.url?.startsWith("https://")) {
          const link = el("a", label);
          link.href = source.url;
          link.target = "_blank";
          link.rel = "noopener noreferrer";
          item.append(link);
        } else {
          item.append(el("span", label));
        }
        item.append(el("blockquote", source.text));
        list.append(item);
      }
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
  const button = el("button", action, "secondary");
  button.type = "button";
  button.addEventListener("click", onClick);
  row.append(detail, button);
  return row;
}

function renderWatchlist() {
  const rows = saved.map(ticker => config.stocks.find(item => item.ticker === ticker)).filter(Boolean);
  $("watch-items").replaceChildren(...(rows.length ? rows.map(item => listRow(item.ticker + " · " + item.name, item.sector, "Research", () => {
    openView("research");
    chooseStock(item.ticker);
  })) : [el("p", "Save a stock from Research to find it here.", "empty")]));
}

function renderHistory() {
  const rows = history.map(result => listRow(result.ticker + " · " + ranges[result.horizon] + " · " + (result.score == null ? "Unscored" : result.score + "/100"),
    (Number.isFinite(result.score) ? scoreOutlook(result.score).label + " · " : "")
      + providerLabel(result.provider) + " · " + eventDate.format(new Date(result.createdAt)), "Open result", () => {
      selectSettings({ provider: result.provider, horizon: result.horizon, agentCount: result.agentCount });
      openView("research");
      chooseStock(result.ticker, true);
      renderResult(result);
      $("result-panel").scrollIntoView({ behavior: "smooth", block: "nearest" });
    }));
  $("history-items").replaceChildren(...(rows.length ? rows : [el("p", "Run an analysis to start your history.", "empty")]));
}

async function saveHolding(ticker, shares, averageCost) {
  holdings = (await api("/api/holdings", "PUT", { ticker, shares, averageCost })).portfolio;
  renderPortfolio();
}

function renderPortfolio() {
  const rows = holdings.map(({ ticker, shares, average_cost: cost }) => {
    const item = config.stocks.find(candidate => candidate.ticker === ticker);
    const row = listRow(item ? ticker + " · " + item.name : ticker, shares + " shares · Average cost " + money.format(cost), "Edit", () => {
      $("holding-stock").value = ticker;
      $("holding-shares").value = shares;
      $("holding-cost").value = cost;
      $("holding-shares").focus();
    });
    const edit = row.lastElementChild;
    const value = el("p", "Loading close…", "holding-value");
    row.firstElementChild.append(value);
    const actions = el("div", undefined, "row-actions");
    const remove = el("button", "Remove", "secondary");
    remove.type = "button";
    remove.setAttribute("aria-label", "Remove " + ticker + " holding");
    remove.addEventListener("click", async () => {
      remove.disabled = true;
      try { await saveHolding(ticker, 0, 0); }
      catch (error) { notice(error.message, true); remove.disabled = false; }
    });
    actions.append(edit, remove);
    row.append(actions);
    api("/api/market?" + new URLSearchParams({ ticker, horizon: "1w" })).then(({ metrics, marketMode }) => {
      const pnl = (metrics.last - Number(cost)) * Number(shares);
      value.textContent = money.format(metrics.last * Number(shares)) + " value · " + (pnl >= 0 ? "+" : "") + money.format(pnl)
        + " unrealized P/L · " + (marketMode === "demo" ? "Synthetic close " : "Close ") + metrics.asOf;
    }).catch(() => { value.textContent = "Closing price unavailable."; });
    return row;
  });
  $("holding-items").replaceChildren(...(rows.length ? rows : [el("p", "Add a holding to see its value and unrealized gain or loss.", "empty")]));
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
      if (action === "resend") notice(result.message);
    }
  } catch (error) {
    notice(error.message, true);
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
$("watch-toggle").addEventListener("click", async () => {
  const ticker = stock.ticker;
  $("watch-toggle").disabled = true;
  try {
    saved = (await api("/api/watchlist", "PUT", { ticker, add: !saved.includes(ticker) })).watchlist;
    watchState();
  } catch (error) { notice(error.message, true); }
  finally { $("watch-toggle").disabled = false; }
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
$("holding-form").addEventListener("submit", async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector("button");
  button.disabled = true;
  try {
    await saveHolding($("holding-stock").value, $("holding-shares").valueAsNumber, $("holding-cost").valueAsNumber);
    form.reset();
    notice("Holding saved.");
  } catch (error) { notice(error.message, true); }
  finally { button.disabled = false; }
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
    if (stock?.ticker !== ticker || $("research").hidden) notice(ticker + " analysis saved to history.");
  } catch (error) { if (currentUser === signedInVersion) notice(error.message, true); }
  finally {
    button.removeAttribute("aria-busy");
    updateAnalysisControls();
  }
});
new ResizeObserver(drawChart).observe($("chart").parentElement);

$("score-scale").replaceChildren(...outlookBands.map((band, index) => {
  const max = index === 0 ? 100 : outlookBands[index - 1].min - 1;
  const item = el("li", band.min + "–" + max + " " + band.label);
  item.dataset.outlook = band.tone;
  return item;
}));

const emailReturn = new URLSearchParams(location.hash.slice(1));
const emailConfirmed = emailReturn.get("type") === "signup" && emailReturn.has("access_token");
const confirmationExpired = emailReturn.get("error_code") === "otp_expired";
if (emailConfirmed || confirmationExpired) {
  window.history.replaceState(null, "", location.pathname + location.search);
}

try {
  config = await api("/api/config");
  const dataState = $("data-state");
  const demoMode = config.marketMode === "demo";
  dataState.textContent = demoMode ? "Synthetic demo data" : "Real market data";
  dataState.title = demoMode ? "Sample prices and filings for demonstration"
    : "Daily closes from Twelve Data and company filings from SEC EDGAR";
  dataState.hidden = false;
  for (const stock of config.stocks) {
    const option = el("option", stock.ticker + " · " + stock.name);
    option.value = stock.ticker;
    $("holding-stock").append(option);
  }
  for (const provider of config.providers) {
    const option = el("option", provider.label + (provider.enabled ? "" : " · setup required"));
    option.value = provider.id;
    option.disabled = !provider.enabled || (provider.id === "demo" && config.marketMode === "live");
    if (provider.model) option.title = provider.model;
    $("provider").append(option);
  }
  await showAccount((await api("/api/session")).user);
  if (config.hosted && !user && emailConfirmed) notice("Email confirmed. Sign in to open your workspace.");
  if (config.hosted && !user && confirmationExpired) {
    notice("This confirmation link is invalid or has expired. Sign in to continue or request a new link.", true);
  }
} catch (error) {
  notice(error.message, true);
}
