import { createInterface } from "node:readline";
import { findStock, financials, mode, pressReleases, priceHistory, recentFilings, searchFilings } from "./market.mjs";

const ticker = { type: "string", description: "A US stock symbol from the app catalog." };
const schema = properties => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const tools = [
  { name: "get_price_history", description: "Daily closing prices in chronological order.", inputSchema: schema({ ticker }) },
  { name: "get_company_financials", description: "Cash, debt, operating cash flow and revenue where reported.", inputSchema: schema({ ticker }) },
  { name: "get_recent_filings", description: "Dates and links for recent SEC company filings.", inputSchema: schema({ ticker }) },
  { name: "get_press_releases", description: "Recent company press release titles, timestamps and short excerpts.", inputSchema: schema({ ticker }) },
  { name: "search_filings", description: "Retrieve relevant filing excerpts with source IDs and dates.", inputSchema: schema({ ticker, query: { type: "string" } }) }
].map(tool => ({ ...tool, annotations: { readOnlyHint: true } }));
const compatible = ["2025-11-25", "2025-06-18", "2025-03-26"];

async function dispatch(method, params) {
  if (method === "initialize") return {
    protocolVersion: compatible.includes(params.protocolVersion) ? params.protocolVersion : compatible[0],
    capabilities: { tools: {} },
    serverInfo: { name: "stock-research-tools", version: "0.1.0" }
  };
  if (method === "ping") return {};
  if (method === "tools/list") return { tools };
  if (method !== "tools/call") throw Object.assign(new Error("Method not found"), { code: -32601 });
  try {
    const stock = findStock(params.arguments?.ticker);
    if (!stock) throw new Error("Unknown ticker.");
    let data;
    switch (params.name) {
      case "get_price_history": data = { prices: await priceHistory(stock) }; break;
      case "get_company_financials": data = { financials: await financials(stock) }; break;
      case "get_recent_filings": data = { filings: await recentFilings(stock) }; break;
      case "get_press_releases": data = { releases: await pressReleases(stock) }; break;
      case "search_filings": {
        const query = params.arguments.query;
        if (typeof query !== "string" || !query.trim() || query.length > 400) throw new Error("Provide a search query up to 400 characters.");
        data = { excerpts: await searchFilings(stock, query) };
        break;
      }
      default: throw new Error("Unknown tool.");
    }
    const result = { ticker: stock.ticker, mode, ...data };
    return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
  } catch (error) {
    return { content: [{ type: "text", text: error.message }], isError: true };
  }
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = message => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
input.on("line", async line => {
  let message;
  try { message = JSON.parse(line); }
  catch { send({ id: null, error: { code: -32700, message: "Invalid JSON" } }); return; }
  if (message.id === undefined) return;
  try {
    const result = await dispatch(message.method, message.params ?? {});
    send({ id: message.id, result });
  } catch (error) {
    send({ id: message.id, error: { code: error.code ?? -32603, message: error.message } });
  }
});
