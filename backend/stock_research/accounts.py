import asyncio
import logging
import math
import re
import secrets
from uuid import uuid4

import httpx

from .config import encode_urlsafe
from .security import AppError, SESSION_LIFE, SESSION_PATTERN, SessionCipher, digest, now_ms
from .storage import User

logger = logging.getLogger(__name__)
USERNAME = re.compile(r"[a-zA-Z0-9_]{3,24}")
EXPIRED = {400, 401, 403}


class Supabase:
    def __init__(self, settings, client):
        self.url = settings.supabase_url
        self.key = settings.supabase_key
        self.client = client

    async def request(self, path, *, method="GET", token=None, payload=None, prefer=None,
                      redirect_to=None, timeout=12):
        headers = {"apikey": self.key, "Content-Type": "application/json"}
        if token:
            headers["Authorization"] = "Bearer " + token
        if prefer:
            headers["Prefer"] = prefer
        url = httpx.URL(self.url + path)
        if redirect_to:
            url = url.copy_add_param("redirect_to", redirect_to)
        async with asyncio.timeout(timeout):
            response = await self.client.request(method, url, headers=headers, json=payload,
                                                 timeout=timeout, follow_redirects=False)
        try:
            data = response.json() if response.content else None
        except ValueError:
            data = None
        if not response.is_success:
            if response.status_code >= 500 or response.status_code < 400:
                raise AppError(502, "The workspace database could not complete the request.")
            if not path.startswith("/auth/"):
                raise AppError(response.status_code, "The workspace database could not complete the request.")
            error = data if isinstance(data, dict) else {}
            code = response.headers.get("x-sb-error-code") or error.get("error_code") or error.get("code")
            message = error.get("msg") or error.get("error_description") or error.get("message") or "Account request failed."
            if code == "invalid_credentials":
                message = "The email address or password is incorrect."
            raise AppError(response.status_code, str(message), code)
        return data


class Accounts:
    def __init__(self, settings, db, supabase):
        self.settings = settings
        self.db = db
        self.supabase = supabase
        self.cipher = SessionCipher(settings.encryption_key)
        self.refreshing = {}
        if self.cipher.cipher:
            rows = db.execute("SELECT id, access, refresh FROM sessions WHERE access IS NOT NULL AND substr(access, 1, 3) <> 'v1.'").fetchall()
            for row in rows:
                db.execute("UPDATE sessions SET access = ?, refresh = ? WHERE id = ?", self.session_values(
                    row["access"], row["refresh"], row["id"],
                ) + (row["id"],))

    def session_values(self, token, refresh, session_id):
        return self.cipher.seal(token, session_id, "access"), self.cipher.seal(refresh, session_id, "refresh")

    def save_session(self, account, auth=None):
        session = encode_urlsafe(secrets.token_bytes(32))
        session_id = digest(session)
        now = now_ms()
        username = (account.get("user_metadata") or {}).get("username")
        username = username if isinstance(username, str) and USERNAME.fullmatch(username) else None
        access, refresh = self.session_values(auth["access_token"], auth["refresh_token"], session_id) if auth else (None, None)
        self.db.execute("DELETE FROM sessions WHERE expires <= ?", (now,))
        self.db.execute(
            """INSERT INTO sessions (id, user_id, email, access, refresh, expires, access_expires, username)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (session_id, account["id"], account.get("email"), access, refresh, now + SESSION_LIFE * 1000,
             now + int(auth["expires_in"] * 1000) if auth else None, username),
        )
        return session

    @staticmethod
    def validate_tokens(auth):
        expiry = (auth or {}).get("expires_in")
        if (not auth or not auth.get("access_token") or not auth.get("refresh_token")
                or type(expiry) not in (int, float) or not math.isfinite(expiry) or expiry <= 0):
            raise AppError(502, "Authentication returned an invalid session.")

    @staticmethod
    def validate_password(password):
        if not isinstance(password, str) or len(password) < 12 or len(password.encode()) > 72:
            raise AppError(400, "Use at least 12 characters and at most 72 bytes for your new password.")

    @staticmethod
    def validate_code(code):
        if not isinstance(code, str) or not re.fullmatch(r"[0-9]{6,10}", code.strip()):
            raise AppError(400, "Enter the numeric code from your email.")
        return code.strip()

    def verification_required(self):
        message = "Check your email for the verification code." if self.settings.confirmation_mode == "code" else "Check your email for the confirmation link."
        return {"verificationRequired": True, "message": message}

    def verified_session(self, auth):
        user = (auth or {}).get("user") or {}
        if not user.get("id") or not user.get("email_confirmed_at"):
            raise AppError(403, "Confirm your email before signing in.")
        self.validate_tokens(auth)
        return {"session": self.save_session(user, auth)}

    async def auth(self, path, method="POST", **kwargs):
        return await self.supabase.request("/auth/v1/" + path, method=method, **kwargs)

    async def sign_in(self, data, confirmation_url):
        action = data.get("action")
        if not self.settings.hosted:
            if action != "demo":
                raise AppError(400, "Use the local demo workspace.")
            return {"session": self.save_session({"id": str(uuid4())})}
        actions = ["login", "signup", "verify", "resend"]
        if self.settings.password_recovery:
            actions.extend(["recover", "reset"])
        if action not in actions:
            raise AppError(400, "Unknown account action.")
        email = data.get("email")
        email = email.strip() if isinstance(email, str) else ""
        if len(email) > 254 or not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", email):
            raise AppError(400, "Enter a valid email address.")
        password = data.get("password")
        if action == "recover":
            try:
                await self.auth("recover", payload={"email": email}, redirect_to=confirmation_url)
            except AppError as error:
                if error.code != "user_not_found":
                    raise
            return {"recoveryRequested": True}
        if action == "reset":
            self.validate_password(password)
            token = self.validate_code(data.get("code"))
            auth = await self.auth("verify", payload={"email": email, "token": token, "type": "recovery"})
            user = (auth or {}).get("user") or {}
            if not auth or not auth.get("access_token") or not user.get("id") or (user.get("email") or "").lower() != email.lower():
                raise AppError(403, "This reset code could not be verified.")
            await self.auth("user", method="PUT", token=auth["access_token"], payload={"password": password})
            self.db.execute("DELETE FROM sessions WHERE user_id = ?", (user["id"],))
            await self.revoke(auth["access_token"], "global")
            return {"passwordReset": True}
        if action == "resend":
            await self.auth("resend", payload={"email": email, "type": "signup"}, redirect_to=confirmation_url)
            return self.verification_required()
        if action == "verify":
            token = self.validate_code(data.get("code"))
            return self.verified_session(await self.auth("verify", payload={"email": email, "token": token, "type": "signup"}))
        if not isinstance(password, str) or not 8 <= len(password) <= 256:
            raise AppError(400, "Enter a password with at least 8 characters.")
        if action == "signup":
            self.validate_password(password)
            username = data.get("username")
            if not isinstance(username, str) or not USERNAME.fullmatch(username.strip()):
                raise AppError(400, "Use 3–24 letters, numbers, or underscores for your username.")
            result = await self.auth("signup", payload={"email": email, "password": password, "data": {"username": username.strip()}},
                                     redirect_to=confirmation_url)
            if result and result.get("access_token"):
                await self.revoke(result["access_token"], "local")
                raise AppError(503, "Email confirmation is unavailable. Contact the dashboard administrator.")
            return self.verification_required()
        try:
            return self.verified_session(await self.auth("token?grant_type=password", payload={"email": email, "password": password}))
        except AppError as error:
            if error.code != "email_not_confirmed":
                raise
            return self.verification_required()

    def active_session(self, session_id):
        return self.db.execute("SELECT * FROM sessions WHERE id = ? AND expires > ?", (session_id, now_ms())).fetchone()

    async def refresh(self, row):
        session_id = row["id"]
        try:
            next_auth = await self.auth("token?grant_type=refresh_token",
                                        payload={"refresh_token": self.cipher.open(row["refresh"], session_id, "refresh")})
            self.validate_tokens(next_auth)
            access, refresh = self.session_values(next_auth["access_token"], next_auth["refresh_token"], session_id)
            self.db.execute("UPDATE sessions SET access = ?, refresh = ?, access_expires = ? WHERE id = ?",
                            (access, refresh, now_ms() + int(next_auth["expires_in"] * 1000), session_id))
            return next_auth["access_token"]
        except AppError as error:
            if error.status not in EXPIRED:
                raise
            self.db.execute("DELETE FROM sessions WHERE id = ?", (session_id,))
            return None

    def end_refresh(self, session_id, task):
        self.refreshing.pop(session_id, None)
        if not task.cancelled():
            task.exception()

    async def account(self, session):
        if not session or not SESSION_PATTERN.fullmatch(session):
            return None
        session_id = digest(session)
        row = self.active_session(session_id)
        if not row or bool(row["access"]) != self.settings.hosted:
            return None
        if row["refresh"] and row["access_expires"] <= now_ms() + 15_000:
            task = self.refreshing.get(session_id)
            if task is None:
                task = asyncio.create_task(self.refresh(row))
                self.refreshing[session_id] = task
                task.add_done_callback(lambda done: self.end_refresh(session_id, done))
            token = await asyncio.shield(task)
            if not token or not self.active_session(session_id):
                return None
        else:
            token = self.cipher.open(row["access"], session_id, "access")
        return User(row["user_id"], row["email"], row["username"], token)

    async def revoke(self, token, scope):
        if not token:
            return
        try:
            await self.auth("logout?scope=" + scope, token=token, timeout=4)
        except Exception as error:
            if not isinstance(error, AppError) or error.status not in EXPIRED:
                logger.warning("Supabase session revocation could not be confirmed.")

    async def sign_out(self, session):
        if not session or not SESSION_PATTERN.fullmatch(session):
            return
        session_id = digest(session)
        row = self.db.execute(
            "DELETE FROM sessions WHERE id = ? RETURNING access, refresh, access_expires", (session_id,)
        ).fetchone()
        if not row or not row["access"]:
            return
        try:
            pending = self.refreshing.get(session_id)
            if pending:
                token = await asyncio.shield(pending)
            elif row["refresh"] and row["access_expires"] <= now_ms():
                auth = await self.auth("token?grant_type=refresh_token", timeout=4,
                                       payload={"refresh_token": self.cipher.open(row["refresh"], session_id, "refresh")})
                token = (auth or {}).get("access_token")
            else:
                token = self.cipher.open(row["access"], session_id, "access")
            await self.revoke(token, "local")
        except Exception as error:
            if not isinstance(error, AppError) or error.status not in EXPIRED:
                logger.warning("Supabase session revocation could not be confirmed.")

    async def close(self):
        tasks = list(self.refreshing.values())
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
