from contextlib import asynccontextmanager
from typing import TypedDict

import httpx
from mcp.server import MCPServer
from mcp.server.mcpserver import Context
from mcp.server.mcpserver.exceptions import ToolError
from mcp.types import ToolAnnotations

from .market import MarketData, STOCKS


class MarketResponse(TypedDict):
    ticker: str
    mode: str


class ClosingPrice(TypedDict):
    date: str
    close: float


class Filing(TypedDict):
    form: str
    date: str
    url: str | None


class PressRelease(TypedDict):
    title: str
    publishedAt: str
    excerpt: str


class SourceExcerpt(TypedDict):
    id: str
    title: str
    date: str
    url: str | None
    text: str


class PriceResponse(MarketResponse):
    prices: list[ClosingPrice]


class FinancialResponse(MarketResponse):
    financials: dict


class FilingResponse(MarketResponse):
    filings: list[Filing]


class ReleaseResponse(MarketResponse):
    releases: list[PressRelease]


class SearchResponse(MarketResponse):
    excerpts: list[SourceExcerpt]

@asynccontextmanager
async def lifespan(server):
    async with httpx.AsyncClient() as client:
        data = MarketData(client)
        try:
            yield data
        finally:
            await data.close()


mcp = MCPServer("stock-research-tools", version="1.0.0", lifespan=lifespan)
READ_ONLY = ToolAnnotations(read_only_hint=True, destructive_hint=False, idempotent_hint=True)


def ticker_entry(ticker):
    if ticker not in STOCKS:
        raise ToolError("Choose a covered stock.")
    return STOCKS[ticker]


@mcp.tool(annotations=READ_ONLY, structured_output=True)
async def get_price_history(ticker: str, ctx: Context[MarketData]) -> PriceResponse:
    """Return chronological daily closing prices for a covered US stock."""
    data = ctx.request_context.lifespan_context
    return {"ticker": ticker, "mode": data.mode, "prices": await data.prices(ticker_entry(ticker))}


@mcp.tool(annotations=READ_ONLY, structured_output=True)
async def get_company_financials(ticker: str, ctx: Context[MarketData]) -> FinancialResponse:
    """Return the reported cash, debt, operating cash flow, and revenue where available."""
    data = ctx.request_context.lifespan_context
    return {"ticker": ticker, "mode": data.mode, "financials": await data.financials(ticker_entry(ticker))}


@mcp.tool(annotations=READ_ONLY, structured_output=True)
async def get_recent_filings(ticker: str, ctx: Context[MarketData]) -> FilingResponse:
    """Return dates and links for recent SEC filings by a covered company."""
    data = ctx.request_context.lifespan_context
    return {"ticker": ticker, "mode": data.mode, "filings": await data.recent_filings(ticker_entry(ticker))}


@mcp.tool(annotations=READ_ONLY, structured_output=True)
async def get_press_releases(ticker: str, ctx: Context[MarketData]) -> ReleaseResponse:
    """Return company press-release headlines, timestamps, and short excerpts."""
    data = ctx.request_context.lifespan_context
    return {"ticker": ticker, "mode": data.mode, "releases": await data.press_releases(ticker_entry(ticker))}


@mcp.tool(annotations=READ_ONLY, structured_output=True)
async def search_filings(ticker: str, query: str, ctx: Context[MarketData]) -> SearchResponse:
    """Retrieve relevant filing excerpts with stable citation IDs and dates."""
    if not query.strip() or len(query) > 400:
        raise ToolError("Provide a search query up to 400 characters.")
    data = ctx.request_context.lifespan_context
    return {"ticker": ticker, "mode": data.mode, "excerpts": await data.search_filings(ticker_entry(ticker), query)}


if __name__ == "__main__":
    mcp.run(transport="stdio")
