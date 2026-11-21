import { setTimeout as wait } from "node:timers/promises";

export const stocks = [
  { ticker: "NVDA", name: "NVIDIA", sector: "Semiconductors", cik: 1045810, indexes: ["nasdaq", "sp500"], seed: 83 },
  { ticker: "MU", name: "Micron Technology", sector: "Semiconductors", cik: 723125, indexes: ["nasdaq", "sp500"], seed: 54 },
  { ticker: "MSFT", name: "Microsoft", sector: "Software", cik: 789019, indexes: ["nasdaq", "sp500"], seed: 94 },
  { ticker: "AAPL", name: "Apple", sector: "Consumer technology", cik: 320193, indexes: ["nasdaq", "sp500"], seed: 72 },
  { ticker: "AMD", name: "Advanced Micro Devices", sector: "Semiconductors", cik: 2488, indexes: ["nasdaq", "sp500"], seed: 47 },
  { ticker: "AMZN", name: "Amazon", sector: "Retail & cloud", cik: 1018724, indexes: ["nasdaq", "sp500"], seed: 79 },
  { ticker: "GOOGL", name: "Alphabet", sector: "Internet services", cik: 1652044, indexes: ["nasdaq", "sp500"], seed: 86 },
  { ticker: "META", name: "Meta Platforms", sector: "Internet services", cik: 1326801, indexes: ["nasdaq", "sp500"], seed: 76 },
  { ticker: "AVGO", name: "Broadcom", sector: "Semiconductors", cik: 1730168, indexes: ["nasdaq", "sp500"], seed: 66 },
  { ticker: "TSLA", name: "Tesla", sector: "Automotive", cik: 1318605, indexes: ["nasdaq", "sp500"], seed: 28 },
  { ticker: "JPM", name: "JPMorgan Chase", sector: "Banking", cik: 19617, indexes: ["sp500"], seed: 65 },
  { ticker: "XOM", name: "Exxon Mobil", sector: "Energy", cik: 34088, indexes: ["sp500"], seed: 33 }
];

export const mode = process.env.MARKET_DATA_MODE === "live" ? "live" : "demo";
export const fixtureDate = "2025-03-31";

export function findStock(ticker) {
  return stocks.find(stock => stock.ticker === ticker);
}

export function publicStock({ ticker, name, sector, indexes }) {
  return { ticker, name, sector, indexes };
}

function demoHistory(stock) {
  const dates = [];
  const day = new Date(fixtureDate + "T00:00:00Z");
  while (dates.length < 140) {
    if (day.getUTCDay() !== 0 && day.getUTCDay() !== 6) dates.unshift(day.toISOString().slice(0, 10));
    day.setUTCDate(day.getUTCDate() - 1);
  }
  return dates.map((date, index) => {
    const curve = Math.sin(index / 5 + stock.seed) * 3 + Math.cos(index * 1.37) * 1.7;
    const drift = index * (stock.seed - 52) / 240;
    return { date, close: Number((90 + stock.seed * 0.72 + curve + drift).toFixed(2)) };
  });
}

const cached = new Map();
let nextSecRequest = 0;

async function cachedFetch(key, ttl, request) {
  const entry = cached.get(key);
  if (entry && entry.until > Date.now()) return entry.result;
  try {
    const result = Promise.resolve().then(request);
    cached.set(key, { until: Date.now() + ttl, result });
    return await result;
  } catch (error) {
    cached.delete(key);
    throw error;
  }
}

async function sec(path) {
  if (!process.env.SEC_USER_AGENT) throw new Error("Set SEC_USER_AGENT to an app name and contact email.");
  const now = Date.now();
  const start = Math.max(now, nextSecRequest);
  nextSecRequest = start + 125;
  if (start > now) await wait(start - now);
  const response = await fetch(path, {
    headers: { "User-Agent": process.env.SEC_USER_AGENT, Accept: "application/json, text/html" },
    signal: AbortSignal.timeout(12_000)
  });
  if (!response.ok) throw new Error("SEC EDGAR data is temporarily unavailable.");
  return response;
}

export async function priceHistory(stock) {
  if (mode === "demo") return demoHistory(stock);
  if (!process.env.TWELVE_DATA_API_KEY) throw new Error("Configure the market data API key for live prices.");
  return cachedFetch("price:" + stock.ticker, 900_000, async () => {
    const url = new URL("https://api.twelvedata.com/time_series");
    url.search = new URLSearchParams({ symbol: stock.ticker, interval: "1day", outputsize: "140" });
    const response = await fetch(url, {
      headers: { Authorization: "apikey " + process.env.TWELVE_DATA_API_KEY },
      signal: AbortSignal.timeout(12_000)
    });
    if (!response.ok) throw new Error("The market data provider could not return prices.");
    const result = await response.json();
    const values = (result.values ?? []).map(value => ({ date: value.datetime, close: Number(value.close) }))
      .filter(value => /^\d{4}-\d{2}-\d{2}$/.test(value.date) && Number.isFinite(value.close) && value.close > 0);
    if (values.length < 2) throw new Error("The market data provider returned insufficient price history.");
    return values.sort((a, b) => a.date.localeCompare(b.date));
  });
}

export async function financials(stock) {
  if (mode === "demo") return {
    cash: Math.round((7 + stock.seed / 3) * 1e9),
    debt: Math.round((56 - stock.seed / 2) * 1e9),
    operatingCash: Math.round((stock.seed / 6 - 5) * 1e9),
    revenue: stock.seed * 8e8,
    as_of: fixtureDate
  };
  const base = "https://data.sec.gov/api/xbrl/companyfacts/CIK";
  const cik = String(stock.cik).padStart(10, "0");
  const facts = await cachedFetch("facts:" + cik, 3_600_000, async () => (await sec(base + cik + ".json")).json());
  const gaap = facts?.facts?.["us-gaap"] ?? {};
  const latest = (tags, annual = false) => {
    const candidates = tags.flatMap(tag => gaap[tag]?.units?.USD ?? [])
      .filter(item => ["10-K", "10-Q", "10-K/A", "10-Q/A"].includes(item.form) && Number.isFinite(item.val))
      .filter(item => annual
        ? item.start && (Date.parse(item.end) - Date.parse(item.start)) / 86_400_000 >= 330
          && (Date.parse(item.end) - Date.parse(item.start)) / 86_400_000 <= 390
        : !item.start)
      .sort((a, b) => b.end.localeCompare(a.end) || b.filed.localeCompare(a.filed));
    const item = candidates[0];
    return item ? { value: item.val, period_end: item.end, filed: item.filed } : null;
  };
  return {
    cash: latest(["CashAndCashEquivalentsAtCarryingValue"]),
    longTermDebt: latest(["LongTermDebtNoncurrent", "LongTermDebt"]),
    operatingCashAnnual: latest(["NetCashProvidedByUsedInOperatingActivities"], true),
    revenueAnnual: latest(["RevenueFromContractWithCustomerExcludingAssessedTax", "Revenues", "SalesRevenueNet"], true),
    source: base + cik + ".json"
  };
}

function fixturePassages(stock) {
  const demand = stock.seed > 70 ? "Demand improved and the company increased production commitments."
    : "Demand was uneven and the company kept its prior production guidance.";
  return [
    { id: "filing-1", title: "Demo quarterly report · Outlook", date: fixtureDate, text: demand + " Management noted that a material portion of the next quarter's revenue depends on shipment timing." },
    { id: "filing-2", title: "Demo annual report · Risk factors", date: fixtureDate, text: "Customer concentration and industry pricing are material risks. A slowdown could reduce margins and increase inventory even if reported sales remain steady." },
    { id: "filing-3", title: "Demo quarterly report · Liquidity", date: fixtureDate, text: "Management expects operations and available cash to fund planned capital spending. Debt maturities and refinancing remain sensitive to market conditions." },
    { id: "filing-4", title: "Demo quarterly report · Investment", date: fixtureDate, text: "Capital expenditure is directed towards capacity and new products. Competitor investment could take market share and lead to price competition." },
    { id: "filing-5", title: "Demo quarterly report · Market conditions", date: fixtureDate, text: "Interest rates, foreign exchange and customer budgets affect demand. The timing and cost of financing are uncertain." }
  ].map(passage => ({ ...passage, text: "Synthetic " + stock.ticker + " example. " + passage.text, url: null }));
}

function segments(html) {
  return html.replace(/<(script|style|ix:hidden)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(?:div|p|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]*>/g, " ").replace(/&nbsp;|&#160;/gi, " ").replace(/&amp;/gi, "&")
    .replace(/&#8217;|&rsquo;/gi, "'").split("\n").map(line => line.replace(/\s+/g, " ").trim())
    .filter(line => line.length >= 100).flatMap(line => line.match(/.{1,1100}(?:\s|$)|.{1,1100}/g) ?? [])
    .slice(0, 3600);
}

async function companyReports(stock) {
  const cik = String(stock.cik).padStart(10, "0");
  return cachedFetch("submissions:" + cik, 600_000, async () => {
    const response = await sec("https://data.sec.gov/submissions/CIK" + cik + ".json");
    const recent = (await response.json()).filings.recent;
    const rows = recent.form.map((form, i) => ({
      form, date: recent.filingDate[i], accession: recent.accessionNumber[i], document: recent.primaryDocument[i]
    })).filter(row => /^(8-K|10-Q|10-K)(\/A)?$/.test(row.form)
      && /^\d{4}-\d{2}-\d{2}$/.test(row.date)
      && /^\d{10}-\d{2}-\d{6}$/.test(row.accession)
      && /^[a-zA-Z0-9_.-]+\.html?$/.test(row.document));
    return rows.map(({ form, date, accession, document }) => ({
      form, date, accession,
      url: "https://www.sec.gov/Archives/edgar/data/" + stock.cik + "/" + accession.replaceAll("-", "") + "/" + document
    }));
  });
}

export async function recentFilings(stock) {
  if (mode === "demo") return [{ form: "10-Q", date: fixtureDate, url: null }];
  return (await companyReports(stock)).map(({ form, date, url }) => ({ form, date, url }));
}

export async function pressReleases(stock) {
  if (mode === "demo") {
    return [{
      title: "Sample company announcement", publishedAt: fixtureDate + "T14:00:00Z",
      excerpt: "This fictional release illustrates how a company announcement appears in the research view."
    }];
  }
  if (!process.env.TWELVE_DATA_API_KEY) throw new Error("Configure the market data API key for live press releases.");
  return cachedFetch("press-releases:" + stock.ticker, 900_000, async () => {
    const url = new URL("https://api.twelvedata.com/press_releases");
    url.search = new URLSearchParams({ symbol: stock.ticker, outputsize: "6", language: "en,en-US", timezone: "UTC" });
    const response = await fetch(url, {
      headers: { Authorization: "apikey " + process.env.TWELVE_DATA_API_KEY },
      signal: AbortSignal.timeout(12_000)
    });
    if (!response.ok) throw new Error("The press release provider is temporarily unavailable.");
    const data = await response.json();
    if (data.status === "ok" && data.press_releases === null) return [];
    if (data.status === "error" || !Array.isArray(data.press_releases)) throw new Error("The press release provider returned an unexpected response.");
    const headlines = [];
    for (const release of data.press_releases) {
      const { title, datetime, body } = release ?? {};
      if (typeof title !== "string" || !title.trim() || typeof datetime !== "string") continue;
      const iso = datetime.replace(" ", "T");
      const time = Date.parse(/[Zz]$|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : iso + "Z");
      if (!Number.isFinite(time)) continue;
      const text = typeof body === "string" ? (segments(body.slice(0, 16_000))[0] ?? "") : "";
      const excerpt = text.length > 240 ? text.slice(0, 241).replace(/\s+\S*$/, "").slice(0, 240) + "…" : text;
      headlines.push({ title: title.trim().slice(0, 300), publishedAt: new Date(time).toISOString(), excerpt });
    }
    return headlines;
  });
}

async function filingPassages(stock) {
  if (mode === "demo") return fixturePassages(stock);
  const cik = String(stock.cik).padStart(10, "0");
  return cachedFetch("filings:" + cik, 3_600_000, async () => {
    const rows = (await companyReports(stock)).filter(row => ["10-Q", "10-K"].includes(row.form)).slice(0, 2);
    const passages = [];
    for (const { url, accession, form, date } of rows) {
      const html = await (await sec(url)).text();
      passages.push(...segments(html).map((text, i) => ({
        id: accession + "-" + (i + 1), title: "SEC " + form, date, text, url
      })));
    }
    return passages;
  });
}

const words = text => (text.toLowerCase().match(/[a-z]{3,}/g) ?? []);

export function rankPassages(passages, query, limit = 3) {
  const keys = [...new Set(words(query))];
  const rows = passages.map(passage => ({ passage, tokens: words(passage.text) }));
  const documentFrequency = Object.fromEntries(keys.map(term => [term, rows.filter(row => row.tokens.includes(term)).length]));
  const weight = term => Math.log(1 + (rows.length - documentFrequency[term] + 0.5) / (documentFrequency[term] + 0.5));
  return rows.map(({ passage, tokens }) => {
    const score = keys.reduce((total, term) => {
      const hits = tokens.filter(token => token === term).length;
      return total + weight(term) * hits / (hits + 0.6 + 0.006 * tokens.length);
    }, 0);
    return { passage, score };
  }).filter(row => row.score > 0).sort((a, b) => b.score - a.score).slice(0, limit).map(row => row.passage);
}

export async function searchFilings(stock, query) {
  return rankPassages(await filingPassages(stock), query);
}
