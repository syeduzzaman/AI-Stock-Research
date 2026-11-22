import asyncio
import os
import sys
from contextlib import asynccontextmanager
from pathlib import Path

from mcp import Client, StdioServerParameters

MARKET_ENV = {
    "TWELVE_DATA_API_KEY", "SEC_USER_AGENT", "SSL_CERT_FILE", "SSL_CERT_DIR",
    "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY", "SYSTEMROOT", "WINDIR", "TEMP", "TMP",
}


class EvidenceTools:
    def __init__(self, client, tools):
        self.client = client
        self.names = {tool.name for tool in tools}

    @classmethod
    @asynccontextmanager
    async def connect(cls, mode):
        env = {key: value for key, value in os.environ.items() if key.upper() in MARKET_ENV}
        env["MARKET_DATA_MODE"] = mode
        server = StdioServerParameters(command=sys.executable, args=["-B", "-m", "stock_research.mcp_server"],
                                       cwd=str(Path(__file__).resolve().parents[1]), env=env)
        async with Client(server) as client:
            async with asyncio.timeout(8):
                tool_list = await client.list_tools()
            yield cls(client, tool_list.tools)

    async def ping(self):
        async with asyncio.timeout(3):
            await self.client.list_tools(cache_mode="bypass")

    async def call(self, name, **arguments):
        if name not in self.names:
            raise RuntimeError("An evidence tool is unavailable.")
        async with asyncio.timeout(35):
            result = await self.client.call_tool(name, arguments)
        if result.is_error or not isinstance(result.structured_content, dict):
            raise RuntimeError("An evidence tool could not return results.")
        return result.structured_content
