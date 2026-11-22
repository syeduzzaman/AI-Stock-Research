import asyncio
import json
import unittest
from contextlib import closing
from dataclasses import replace

import httpx
from fastapi.testclient import TestClient

from stock_research.accounts import Accounts, Supabase
from stock_research.app import create_app
from stock_research.config import Settings
from stock_research.security import digest
from stock_research.storage import open_database

ORIGIN = "https://research.example.test"
SETTINGS = Settings(
    public_origin=ORIGIN, supabase_url="https://fixture.supabase.co",
    supabase_key="sb_publishable_fixture", encryption_key=bytes(range(32)),
    password_recovery=True, database=":memory:",
)
USER = {"id": "owner", "email": "test@example.test", "email_confirmed_at": "2025-01-01", "user_metadata": {"username": "analyst"}}
AUTH = {"user": USER, "access_token": "access-fixture", "refresh_token": "refresh-fixture", "expires_in": 3600}
LOGIN = {"action": "login", "email": USER["email"], "password": "a-local-test-password"}


class SecurityTests(unittest.TestCase):
    def test_public_login_reset_and_logout(self):
        calls = []

        def upstream(request):
            path = request.url.path
            calls.append((path, dict(request.url.params)))
            self.assertEqual(request.headers["apikey"], SETTINGS.supabase_key)
            if path.endswith("/token"):
                return httpx.Response(200, json=AUTH)
            if path.endswith("/recover"):
                self.assertEqual(request.url.params["redirect_to"], ORIGIN + "/")
                return httpx.Response(400, headers={"x-sb-error-code": "user_not_found"})
            if path.endswith("/verify"):
                self.assertEqual(json.loads(request.content)["type"], "recovery")
                return httpx.Response(200, json=AUTH)
            if path.endswith("/user"):
                self.assertEqual(request.headers["authorization"], "Bearer " + AUTH["access_token"])
                return httpx.Response(200, json=USER)
            if path.endswith("/logout"):
                raise httpx.ConnectError("fixture disconnect")
            self.fail(f"Unexpected upstream request {path}")

        app = create_app(SETTINGS, transport=httpx.MockTransport(upstream))
        with TestClient(app, base_url=ORIGIN) as client:
            self.assertEqual(client.get("/api/config", headers={"Host": "untrusted.example.test"}).status_code, 403)
            self.assertEqual(client.get("/openapi.json").status_code, 404)
            self.assertEqual(client.get("/api/market-overview").status_code, 401)
            self.assertEqual(client.post("/api/account", json=LOGIN).status_code, 403)
            self.assertEqual(client.post("/api/account", json=LOGIN, headers={"origin": "https://untrusted.example.test"}).status_code, 403)
            self.assertFalse(calls)
            headers = {"Origin": ORIGIN}
            login = client.post("/api/account", json=LOGIN, headers=headers)
            self.assertEqual(login.status_code, 200)
            self.assertIn("__Host-sr_session=", login.headers["set-cookie"])
            self.assertIn("; Secure", login.headers["set-cookie"])
            self.assertIn("; HttpOnly; SameSite=Lax", login.headers["set-cookie"])
            self.assertEqual(login.headers["cache-control"], "no-store")
            self.assertIn("max-age", login.headers["strict-transport-security"])
            self.assertNotIn(AUTH["access_token"], login.text)
            self.assertEqual(client.get("/api/session").json()["user"]["username"], "analyst")
            cookie = login.headers["set-cookie"].split(";", 1)[0]
            self.assertIsNone(client.get("/api/session", headers={"Cookie": cookie + "; " + cookie}).json()["user"])

            recovery = {"action": "recover", "email": USER["email"]}
            self.assertTrue(client.post("/api/account", json=recovery, headers=headers).json()["recoveryRequested"])
            reset = {"action": "reset", "email": USER["email"], "code": "123456", "password": "new-local-password"}
            response = client.post("/api/account", json=reset, headers=headers)
            self.assertTrue(response.json()["passwordReset"])
            self.assertEqual(client.get("/api/workspace").status_code, 401)
            self.assertIn(("/auth/v1/logout", {"scope": "global"}), calls)

            client.post("/api/account", json=LOGIN, headers=headers)
            logout = client.post("/api/logout", headers=headers)
            self.assertEqual(logout.status_code, 200)
            self.assertIn("Max-Age=0", logout.headers["set-cookie"])
            self.assertEqual(client.get("/api/workspace").status_code, 401)
            self.assertIn(("/auth/v1/logout", {"scope": "local"}), calls)


    def test_signup_requires_confirmation_and_preserves_username(self):
        def upstream(request):
            path = request.url.path
            payload = json.loads(request.content)
            if path.endswith("/signup"):
                self.assertEqual(request.url.params["redirect_to"], ORIGIN + "/")
                self.assertEqual(payload["data"], {"username": "analyst"})
                return httpx.Response(200, json={"id": USER["id"]})
            if path.endswith("/verify"):
                self.assertEqual(payload, {"email": USER["email"], "type": "signup", "token": "123456"})
                return httpx.Response(200, json=AUTH)
            self.fail(f"Unexpected upstream request {path}")

        settings = replace(SETTINGS, confirmation_mode="code")
        app = create_app(settings, transport=httpx.MockTransport(upstream))
        with TestClient(app, base_url=ORIGIN) as client:
            headers = {"Origin": ORIGIN}
            registration = client.post("/api/account", json={**LOGIN, "action": "signup", "username": "analyst"}, headers=headers)
            self.assertEqual(registration.status_code, 200)
            self.assertTrue(registration.json()["verificationRequired"])
            self.assertNotIn("set-cookie", registration.headers)
            verification = {"action": "verify", "email": USER["email"], "code": "123456"}
            self.assertTrue(client.post("/api/account", json=verification, headers=headers).json()["signedIn"])
            self.assertEqual(client.get("/api/session").json()["user"]["username"], "analyst")

    def test_rate_limit_normalizes_email(self):
        def rejected(request):
            return httpx.Response(400, json={"code": "invalid_credentials"})

        app = create_app(SETTINGS, transport=httpx.MockTransport(rejected))
        with TestClient(app, base_url=ORIGIN) as client:
            headers = {"Origin": ORIGIN}
            for index in range(8):
                email = USER["email"].upper() if index % 2 else USER["email"]
                attempt = client.post("/api/account", json={**LOGIN, "email": email}, headers=headers)
                self.assertEqual(attempt.status_code, 400)
            self.assertEqual(client.post("/api/account", json=LOGIN, headers=headers).status_code, 429)
            other = client.post("/api/account", json={**LOGIN, "email": "other@example.test"}, headers=headers)
            self.assertEqual(other.status_code, 400)


class RefreshTests(unittest.IsolatedAsyncioTestCase):
    async def test_encryption_and_logout_during_refresh(self):
        started, finish = asyncio.Event(), asyncio.Event()

        async def upstream(request):
            if request.url.path.endswith("/token"):
                started.set()
                await finish.wait()
                return httpx.Response(200, json={**AUTH, "access_token": "rotated-fixture"})
            self.assertEqual(request.headers["authorization"], "Bearer rotated-fixture")
            return httpx.Response(204)

        with closing(open_database(":memory:")) as db:
            async with httpx.AsyncClient(transport=httpx.MockTransport(upstream)) as client:
                accounts = Accounts(SETTINGS, db, Supabase(SETTINGS, client))
                session = accounts.save_session(USER, {**AUTH, "expires_in": 1})
                row = db.execute("SELECT * FROM sessions").fetchone()
                self.assertEqual(row["id"], digest(session))
                self.assertTrue(row["access"].startswith("v1."))
                self.assertNotIn("fixture", row["access"])
                self.assertEqual(accounts.cipher.open(row["access"], row["id"], "access"), AUTH["access_token"])
                pending = asyncio.create_task(accounts.account(session))
                await asyncio.wait_for(started.wait(), 2)
                logout = asyncio.create_task(accounts.sign_out(session))
                await asyncio.sleep(0)
                self.assertIsNone(await accounts.account(session))
                finish.set()
                self.assertIsNone(await pending)
                await logout
                self.assertIsNone(db.execute("SELECT id FROM sessions").fetchone())
