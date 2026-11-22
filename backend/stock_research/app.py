import asyncio
import logging
from contextlib import asynccontextmanager, closing
from typing import Annotated, Literal

import httpx
from fastapi import Depends, FastAPI, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field, FiniteFloat
from starlette.exceptions import HTTPException

from .accounts import Accounts, Supabase
from .analysis import HORIZONS, SPECIALISTS, analyze, configured_providers, market_snapshot
from .config import Settings
from .http_security import DashboardSecurity
from .market import FEATURED, STOCKS
from .mcp_client import EvidenceTools
from .security import AppError, digest, read_session, session_cookie
from .storage import User, WorkspaceStorage, open_database
from .updates import company_news, watchlist_updates

logger = logging.getLogger(__name__)


class Input(BaseModel):
    model_config = ConfigDict(strict=True)


class AccountInput(Input):
    action: str | None = None
    email: str | None = None
    password: str | None = None
    username: str | None = None
    code: str | None = None


class AnalysisOptions(Input):
    provider: Literal["demo", "openai", "claude", "gemini"]
    horizon: Literal["1w", "1m", "3m", "6m"]
    agentCount: Literal[3, 5]


class AnalysisInput(AnalysisOptions):
    ticker: str


class WatchInput(Input):
    ticker: str
    add: bool


class HoldingInput(Input):
    ticker: str
    shares: Annotated[FiniteFloat, Field(ge=0, le=1e7)]
    averageCost: FiniteFloat | None = None


OPTIONS_ERROR = "Choose an available model, horizon, and agent count."
HOLDING_ERROR = "Enter a covered stock, a valid share count, and an average cost in USD."
VALIDATION_MESSAGES = {
    "/api/analysis": OPTIONS_ERROR, "/api/preferences": OPTIONS_ERROR,
    "/api/holdings": HOLDING_ERROR, "/api/watchlist": "Choose a supported stock.",
}


def create_app(settings: Settings | None = None, *, transport=None, providers=None):
    settings = settings or Settings.from_env()
    settings.validate()
    providers = configured_providers() if providers is None else providers
    secure = bool(settings.public_origin)

    @asynccontextmanager
    async def lifespan(app):
        with closing(open_database(settings.database)) as db:
            async with httpx.AsyncClient(transport=transport) as upstream, EvidenceTools.connect(settings.market_mode) as tools:
                supabase = Supabase(settings, upstream)
                app.state.accounts = Accounts(settings, db, supabase)
                app.state.workspace = WorkspaceStorage(db, supabase)
                app.state.tools = tools
                app.state.upstream = upstream
                app.state.running = set()
                try:
                    yield
                finally:
                    await app.state.accounts.close()

    app = FastAPI(
        title="AI Stock Research",
        description="Market evidence, independent specialist analyses, and a private research workspace.",
        version="1.0.0", lifespan=lifespan, docs_url=None, redoc_url=None,
        openapi_url=None if secure else "/openapi.json",
    )
    app.add_middleware(DashboardSecurity, settings=settings)

    @app.exception_handler(AppError)
    async def app_error(request, error):
        if error.status >= 500:
            logger.error("Dashboard operation failed (HTTP %s).", error.status)
        return JSONResponse({"error": str(error) if error.status < 500 else "The workspace could not complete this request."},
                            status_code=error.status)

    @app.exception_handler(RequestValidationError)
    async def invalid_input(request, error):
        if any(entry["type"] == "json_invalid" for entry in error.errors()):
            message = "The request is not valid JSON."
        else:
            message = VALIDATION_MESSAGES.get(request.url.path, "Send a valid JSON object.")
        return JSONResponse({"error": message}, status_code=400)

    @app.exception_handler(HTTPException)
    async def http_error(request, error):
        return JSONResponse({"error": "Endpoint not found." if error.status_code == 404 else str(error.detail)},
                            status_code=error.status_code, headers=error.headers)

    def session_id(request):
        return read_session(request.headers, secure)

    async def signed_in(request: Request):
        user = await app.state.accounts.account(session_id(request))
        if user is None:
            raise AppError(401, "Sign in to access your workspace.")
        return user

    def scope_for(request):
        return request.client.host if request.client else "unknown"

    def selected_provider(options):
        provider = providers[options.provider]
        if not provider.enabled:
            raise AppError(400, OPTIONS_ERROR)
        return provider

    @app.get("/", include_in_schema=False)
    async def home():
        index = settings.frontend / "index.html"
        if not index.is_file():
            raise AppError(404, "Build the React frontend before opening the dashboard.")
        return FileResponse(index, headers={"Cache-Control": "no-cache"})

    @app.get("/healthz", include_in_schema=False)
    async def health():
        try:
            await app.state.tools.ping()
        except Exception:
            return JSONResponse({"status": "unavailable"}, status_code=503)
        return {"status": "ok"}

    @app.get("/api/config")
    async def config():
        return {
            "hosted": settings.hosted, "confirmationMode": settings.confirmation_mode,
            "passwordRecovery": settings.hosted and settings.password_recovery,
            "marketMode": settings.market_mode, "marketPreview": not secure,
            "featuredStocks": [{"ticker": ticker, "name": STOCKS[ticker].name} for ticker in FEATURED],
            "providers": [provider.public() for provider in providers.values()],
            "agents": [agent.public() for agent in SPECIALISTS],
            "stocks": [stock.public() for stock in STOCKS.values()],
        }

    @app.post("/api/account")
    async def account(input: AccountInput, request: Request, response: Response):
        accounts, workspace = app.state.accounts, app.state.workspace
        workspace.rate_limit("login:" + scope_for(request), 120 if secure else 20, 300_000)
        email = (input.email or "").strip().lower()
        if settings.hosted and email and len(email) <= 254:
            workspace.rate_limit("account:" + digest(email), 8, 300_000)
        origin = settings.public_origin or settings.container_origin or "http://" + request.headers["host"]
        result = await accounts.sign_in(input.model_dump(), origin + "/")
        session = result.pop("session", None)
        if session:
            await accounts.sign_out(session_id(request))
            response.headers["set-cookie"] = session_cookie(session, secure)
        return {"signedIn": bool(session), "verificationRequired": False, "message": None, **result}

    @app.post("/api/logout")
    async def logout(request: Request, response: Response):
        await app.state.accounts.sign_out(session_id(request))
        response.headers["set-cookie"] = session_cookie(None, secure)
        return {"success": True}

    @app.get("/api/session")
    async def session(request: Request):
        user = await app.state.accounts.account(session_id(request))
        return {"user": {"email": user.email, "username": user.username, "demo": not settings.hosted} if user else None}

    @app.get("/api/market-overview")
    async def overview(request: Request):
        if secure:
            await signed_in(request)
        app.state.workspace.rate_limit("market-overview:" + scope_for(request), 30, 60_000)
        quotes = await asyncio.gather(
            *(app.state.tools.call("get_price_history", ticker=ticker) for ticker in FEATURED),
            return_exceptions=True,
        )
        return {"stocks": [
            {"ticker": ticker, "name": STOCKS[ticker].name,
             "prices": quote["prices"][-20:] if isinstance(quote, dict) else []}
            for ticker, quote in zip(FEATURED, quotes)
        ]}

    @app.get("/api/workspace")
    async def workspace(user: User = Depends(signed_in)):
        return await app.state.workspace.snapshot(user)

    @app.put("/api/preferences")
    async def preferences(input: AnalysisOptions, user: User = Depends(signed_in)):
        selected_provider(input)
        options = input.model_dump()
        await app.state.workspace.save_preferences(user, options)
        return {"preferences": options}

    @app.put("/api/watchlist")
    async def watchlist(input: WatchInput, user: User = Depends(signed_in)):
        if input.ticker not in STOCKS:
            raise AppError(400, "Choose a supported stock.")
        await app.state.workspace.set_watch(user, input.ticker, input.add)
        return {"watchlist": await app.state.workspace.watchlist(user)}

    @app.get("/api/watchlist/updates")
    async def updates(user: User = Depends(signed_in)):
        app.state.workspace.rate_limit("watchlist-updates:" + user.id, 12, 60_000)
        tickers = [ticker for ticker in await app.state.workspace.watchlist(user) if ticker in STOCKS]
        return await watchlist_updates(app.state.tools, tickers, settings.market_mode)

    @app.put("/api/holdings")
    async def holdings(input: HoldingInput, user: User = Depends(signed_in)):
        ticker, shares, cost = input.ticker, input.shares, input.averageCost
        if ticker not in STOCKS or (shares and (shares < 0.000001 or cost is None or not 0.000001 <= cost <= 1e7)):
            raise AppError(400, HOLDING_ERROR)
        await app.state.workspace.set_holding(user, ticker, round(shares, 6), round(cost, 6) if shares else 0)
        return {"portfolio": await app.state.workspace.portfolio(user)}

    @app.get("/api/market")
    async def market(ticker: str = "", horizon: str = "", user: User = Depends(signed_in)):
        if ticker not in STOCKS or horizon not in HORIZONS:
            raise AppError(400, "Choose a supported stock and time horizon.")
        app.state.workspace.rate_limit("market:" + user.id, 120, 60_000)
        return await market_snapshot(app.state.tools, ticker, horizon)

    @app.get("/api/company-news")
    async def news(ticker: str = "", user: User = Depends(signed_in)):
        if ticker not in STOCKS:
            raise AppError(400, "Choose a supported stock.")
        app.state.workspace.rate_limit("company-news:" + user.id, 12, 60_000)
        return await company_news(app.state.tools, ticker, settings.market_mode)

    @app.post("/api/analysis", status_code=201)
    async def analysis(input: AnalysisInput, request: Request, user: User = Depends(signed_in)):
        if input.ticker not in STOCKS:
            raise AppError(400, "Choose a supported stock.")
        provider = selected_provider(input)
        if provider.id == "demo" and settings.market_mode == "live":
            raise AppError(400, "Live analysis requires a configured AI model.")
        running, workspace = app.state.running, app.state.workspace
        if user.id in running or len(running) >= 4:
            raise AppError(429, "An analysis is already running. Try again shortly.")
        workspace.rate_limit("analysis:" + user.id, 15, 3_600_000)
        if provider.id != "demo":
            workspace.rate_limit("paid-analysis", 40, 3_600_000)
        running.add(user.id)
        try:
            result = await analyze(app.state.tools, app.state.upstream, input.ticker, input.horizon,
                                   input.agentCount, provider, settings.market_mode)
            current = await app.state.accounts.account(session_id(request))
            if current is None:
                raise AppError(401, "Sign in again to save an analysis.")
            await workspace.save_run(current, result)
            return {"result": result}
        finally:
            running.discard(user.id)

    app.mount("/assets", StaticFiles(directory=settings.frontend / "assets", check_dir=False), name="assets")
    return app
