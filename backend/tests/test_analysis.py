import json
import unittest
from datetime import datetime

import httpx

from stock_research.analysis import Provider, analyze
from stock_research.updates import company_news, watchlist_updates

SOURCE = {"id": "example", "title": "Example filing", "text": "Demand increased."}


class AnalysisTests(unittest.IsolatedAsyncioTestCase):
    async def test_one_model_call_per_agent_returns_both_languages(self):
        english = "The company reported higher demand."
        german = "Das Unternehmen meldete eine höhere Nachfrage."
        calls = []

        def gemini(request):
            self.assertEqual(request.url.host, "generativelanguage.googleapis.com")
            payload = json.loads(request.content)
            self.assertIn("rationaleDe", payload["generationConfig"]["responseJsonSchema"]["required"])
            self.assertIn("rationaleDe in German", payload["systemInstruction"]["parts"][0]["text"])
            calls.append(payload)
            result = {"score": 70, "rationale": english, "rationaleDe": german, "citationIds": [SOURCE["id"]]}
            return httpx.Response(200, json={"candidates": [{"content": {"parts": [{"text": json.dumps(result)}]}}]})

        class Tools:
            async def call(self, name, **arguments):
                return {"mode": "demo", "excerpts": [SOURCE]}

        async with httpx.AsyncClient(transport=httpx.MockTransport(gemini)) as client:
            result = await analyze(Tools(), client, "NVDA", "1m", 3, Provider("gemini", "Gemini", "fixture", "fixture"), "demo")
        self.assertEqual(result["score"], 70)
        self.assertEqual(len(calls), 3)
        for agent in result["agents"]:
            self.assertEqual(agent["rationale"], english)
            self.assertEqual(agent["rationaleDe"], german)
            self.assertEqual(agent["sources"], [SOURCE])

    async def test_partial_feeds_preserve_available_evidence(self):
        class Tools:
            async def call(self, name, **arguments):
                if name == "get_recent_filings":
                    return {"filings": [{"form": "10-Q", "date": "2025-03-31", "url": None}]}
                raise RuntimeError("Feed unavailable")

        news = await company_news(Tools(), "MU", "demo")
        self.assertEqual(news["unavailable"], {"filings": False, "releases": True})
        self.assertEqual([item["kind"] for item in news["items"]], ["filing"])
        updates = await watchlist_updates(Tools(), ["MU"], "demo")
        self.assertEqual(updates["unavailable"], {"filings": [], "prices": ["MU"]})
        self.assertEqual([item["kind"] for item in updates["events"]], ["filing"])

    async def test_watchlist_excludes_the_unfinished_trading_session(self):
        class Tools:
            async def call(self, name, **arguments):
                if name == "get_price_history":
                    return {"prices": [
                        {"date": "2026-06-02", "close": 101},
                        {"date": "2026-06-03", "close": 104.03},
                        {"date": "2026-06-04", "close": 99},
                        {"date": "2026-06-05", "close": 110},
                    ]}
                return {"filings": [
                    {"form": "8-K", "date": "2026-06-06", "url": "future"},
                    {"form": "10-Q", "date": "2026-06-05", "url": "recent"},
                    {"form": "8-K", "date": "2026-05-23", "url": "boundary"},
                    {"form": "8-K", "date": "2026-05-22", "url": "old"},
                ]}

        feed = await watchlist_updates(Tools(), ["NVDA"], "live", datetime.fromisoformat("2026-06-05T20:59:59Z"))
        self.assertEqual([(item["date"], item["kind"]) for item in feed["events"]], [
            ("2026-06-05", "filing"), ("2026-06-04", "price"), ("2026-06-03", "price"), ("2026-05-23", "filing"),
        ])
        later = await watchlist_updates(Tools(), ["NVDA"], "live", datetime.fromisoformat("2026-06-05T21:00:00Z"))
        self.assertTrue(any(item["date"] == "2026-06-05" and item["kind"] == "price" for item in later["events"]))
