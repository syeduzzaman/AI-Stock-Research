import unittest

from fastapi.testclient import TestClient

from stock_research.app import create_app
from stock_research.config import Settings
from stock_research.market import rank_passages


class WorkspaceTests(unittest.TestCase):
    def test_filing_retrieval(self):
        passages = [
            {"id": "a", "text": "Competition increased in the European market."},
            {"id": "b", "text": "Debt maturities and debt refinancing are management priorities."},
            {"id": "c", "text": "Management stated that debt levels declined."},
        ]
        self.assertEqual([item["id"] for item in rank_passages(passages, "debt maturity refinancing")], ["b", "c"])
        self.assertEqual(rank_passages(passages, "unmatched"), [])

    def test_workspace_through_real_mcp_subprocess(self):
        app = create_app(Settings(database=":memory:"))
        with TestClient(app, base_url="http://127.0.0.1:8082") as client:
            self.assertEqual(client.get("/healthz").json(), {"status": "ok"})
            self.assertEqual(len(client.get("/api/config").json()["stocks"]), 12)
            self.assertEqual(client.get("/openapi.json").status_code, 200)
            self.assertEqual(client.get("/api/workspace").status_code, 401)
            self.assertEqual(client.get("/api/company-news?ticker=MU").status_code, 401)
            overview = client.get("/api/market-overview").json()["stocks"]
            self.assertEqual([item["ticker"] for item in overview], ["NVDA", "AAPL", "MSFT", "TSLA"])
            self.assertTrue(all(len(item["prices"]) == 20 for item in overview))

            login = client.post("/api/account", json={"action": "demo"})
            cookie = login.headers["set-cookie"].split(";", 1)[0]
            self.assertTrue(login.json()["signedIn"])
            self.assertIn("HttpOnly; SameSite=Lax", login.headers["set-cookie"])
            self.assertEqual(client.put("/api/watchlist", json={"ticker": "MU", "add": True}).json(), {"watchlist": ["MU"]})
            updates = client.get("/api/watchlist/updates").json()["events"]
            self.assertTrue(updates)
            self.assertTrue(all(item["ticker"] == "MU" for item in updates))
            self.assertEqual(
                client.put("/api/holdings", json={"ticker": "MU", "shares": 2.5, "averageCost": 110}).json()["portfolio"],
                [{"ticker": "MU", "shares": 2.5, "average_cost": 110}],
            )
            self.assertEqual(client.put("/api/holdings", json={"ticker": "MU", "shares": -1, "averageCost": 1}).status_code, 400)
            self.assertEqual(client.put("/api/watchlist", json={"ticker": "MU", "add": "true"}).status_code, 400)
            self.assertEqual(client.get("/api/market?ticker=MU&horizon=3m").json()["metrics"]["sessions"], 63)
            self.assertEqual([item["kind"] for item in client.get("/api/company-news?ticker=MU").json()["items"]], ["release", "filing"])
            options = {"provider": "demo", "horizon": "3m", "agentCount": 5}
            self.assertEqual(client.put("/api/preferences", json=options).json()["preferences"], options)
            response = client.post("/api/analysis", json={"ticker": "MU", **options})
            self.assertEqual(response.status_code, 201)
            result = response.json()["result"]
            self.assertEqual(result["scoredAgents"], 5)
            self.assertTrue(all(agent["sources"] for agent in result["agents"]))
            self.assertNotIn("trace", result)
            self.assertEqual(client.get("/api/workspace").json()["history"], [result])

            second = client.post("/api/account", json={"action": "demo"})
            self.assertNotEqual(cookie, second.headers["set-cookie"].split(";", 1)[0])
            self.assertEqual(client.get("/api/workspace", headers={"Cookie": cookie}).status_code, 401)
            data = client.get("/api/workspace").json()
            self.assertEqual([data[key] for key in ("watchlist", "portfolio", "history")], [[], [], []])
            self.assertEqual(client.post("/api/logout").status_code, 200)
            self.assertEqual(client.get("/api/workspace").status_code, 401)

    def test_loopback_host_and_body_guards(self):
        app = create_app(Settings(database=":memory:", container_origin="http://127.0.0.1:8082"))
        with TestClient(app, base_url="http://127.0.0.1:8082") as client:
            self.assertEqual(client.get("/api/config", headers={"host": "elsewhere.example"}).status_code, 403)
            self.assertEqual(client.post("/api/account", content="x").status_code, 415)
            headers = {"Content-Type": "application/json"}
            self.assertEqual(client.post("/api/account", headers=headers, content="x" * 17_000).status_code, 413)
            self.assertEqual(client.post("/api/account", headers=headers, content="{").status_code, 400)
            self.assertEqual(client.post("/api/account", json={"action": "demo"}, headers={"origin": "https://elsewhere.example"}).status_code, 403)
