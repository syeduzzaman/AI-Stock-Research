import asyncio
import logging
import re
from urllib.parse import urlsplit

from starlette.datastructures import Headers
from starlette.requests import Request
from starlette.responses import JSONResponse

from .config import LOOPBACK
from .security import AppError

logger = logging.getLogger(__name__)
SECURITY_HEADERS = {
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "cross-origin-resource-policy": "same-origin",
    "referrer-policy": "no-referrer",
    "content-security-policy": (
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
        "object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
    ),
}
MUTATIONS = {"POST", "PUT", "PATCH", "DELETE"}
ORIGIN_CHECKED_READS = {"/api/market-overview", "/api/watchlist/updates", "/api/company-news"}
MAX_BODY = 16_384


def verify_host(request, settings):
    hosts = request.headers.getlist("host")
    if len(hosts) != 1:
        raise AppError(403, "Open the configured address to use the dashboard.")
    if settings.allowed_host:
        allowed = hosts[0] == settings.allowed_host
    else:
        try:
            url = urlsplit("http://" + hosts[0])
            allowed = url.hostname in LOOPBACK and url.netloc == hosts[0] and not url.username and not url.password
        except ValueError:
            allowed = False
    if not allowed:
        raise AppError(403, "Open the configured address to use the dashboard.")
    return hosts[0]


def verify_origin(request, settings, host):
    origins = request.headers.getlist("origin")
    expected = settings.public_origin or "http://" + host
    require_origin = settings.public_origin and request.method in MUTATIONS
    if ("cross-site" in request.headers.getlist("sec-fetch-site")
            or ((origins or require_origin) and origins != [expected])):
        raise AppError(403, "This request must come from your dashboard.")


async def bounded_body(request):
    if not re.match(r"application/json\b", request.headers.get("content-type", ""), re.I):
        raise AppError(415, "Send a JSON request.")
    body = bytearray()
    try:
        async with asyncio.timeout(15):
            async for chunk in request.stream():
                if len(body) + len(chunk) > MAX_BODY:
                    raise AppError(413, "The request is too large.")
                body.extend(chunk)
    except TimeoutError as error:
        raise AppError(408, "The request timed out.") from error
    return bytes(body)


class DashboardSecurity:
    def __init__(self, app, settings):
        self.app = app
        self.settings = settings

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        request = Request(scope, receive=receive)
        api_path = request.url.path.startswith("/api/")
        response_started = False

        async def secure_send(message):
            nonlocal response_started
            if message["type"] == "http.response.start":
                response_started = True
                headers = Headers(raw=message["headers"]).mutablecopy()
                for key, value in SECURITY_HEADERS.items():
                    headers[key] = value
                if self.settings.public_origin:
                    headers["strict-transport-security"] = "max-age=31536000"
                if api_path or request.url.path == "/healthz" or message["status"] >= 400:
                    headers["cache-control"] = "no-store"
                message["headers"] = headers.raw
            await send(message)

        try:
            host = verify_host(request, self.settings)
            if api_path and (request.method in MUTATIONS or request.url.path in ORIGIN_CHECKED_READS):
                verify_origin(request, self.settings, host)
            if api_path and request.method in {"POST", "PUT"} and request.url.path != "/api/logout":
                body = await bounded_body(request)
                pending = True

                async def body_received():
                    nonlocal pending
                    if pending:
                        pending = False
                        return {"type": "http.request", "body": body, "more_body": False}
                    return await receive()

                await self.app(scope, body_received, secure_send)
            else:
                await self.app(scope, receive, secure_send)
        except Exception as error:
            if response_started:
                raise
            status = error.status if isinstance(error, AppError) else 500
            message = str(error) if status < 500 else "The workspace could not complete this request."
            if status >= 500:
                logger.error("Dashboard request failed (%s).", type(error).__name__)
            await JSONResponse({"error": message}, status_code=status)(scope, receive, secure_send)
