import base64
import json
import os
import re
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[2]
LOOPBACK = {"127.0.0.1", "localhost", "::1"}


def encode_urlsafe(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode().rstrip("=")


def decode_urlsafe(value: str) -> bytes:
    return base64.b64decode(value + "=" * (-len(value) % 4), altchars=b"-_", validate=True)


def is_public_key(key: str) -> bool:
    if re.fullmatch(r"sb_publishable_[A-Za-z0-9_-]+", key):
        return True
    try:
        return json.loads(decode_urlsafe(key.split(".")[1])).get("role") == "anon"
    except (AttributeError, IndexError, UnicodeError, ValueError):
        return False


def exact_origin(value: str, scheme: str):
    url = urlsplit(value)
    if (url.scheme != scheme or not url.hostname or url.username or url.password
            or url.path or url.query or url.fragment or value != f"{scheme}://{url.netloc}"):
        raise ValueError(f"Use an exact {scheme.upper()} origin without a path or trailing slash.")
    if url.port == 0:
        raise ValueError("The origin must use a valid port.")
    return url


@dataclass(frozen=True, slots=True)
class Settings:
    host: str = "127.0.0.1"
    port: int = 8082
    public_origin: str = ""
    container_origin: str = ""
    supabase_url: str = ""
    supabase_key: str = ""
    confirmation_mode: str = "link"
    password_recovery: bool = False
    encryption_key: bytes | None = None
    market_mode: str = "demo"
    database: str = str(ROOT / "data" / "workspace.sqlite")
    frontend: Path = ROOT / "frontend" / "dist"

    @property
    def hosted(self) -> bool:
        return bool(self.supabase_url and self.supabase_key)

    @property
    def allowed_host(self) -> str:
        return urlsplit(self.public_origin or self.container_origin).netloc

    @classmethod
    def from_env(cls):
        load_dotenv(ROOT / ".env")
        env = os.environ
        key_string = env.get("SESSION_ENCRYPTION_KEY", "")
        key = decode_urlsafe(key_string) if key_string else None
        if key is not None and (len(key) != 32 or encode_urlsafe(key) != key_string):
            raise ValueError("SESSION_ENCRYPTION_KEY must be 32 random bytes encoded as base64url.")
        settings = cls(
            host=env.get("HOST") or "127.0.0.1",
            port=int(env.get("PORT") or 8082),
            public_origin=env.get("PUBLIC_ORIGIN", ""),
            container_origin=env.get("LOCAL_CONTAINER_ORIGIN", ""),
            supabase_url=env.get("SUPABASE_URL", "").rstrip("/"),
            supabase_key=env.get("SUPABASE_PUBLISHABLE_KEY", ""),
            confirmation_mode="code" if env.get("SUPABASE_EMAIL_CONFIRMATION") == "code" else "link",
            password_recovery=env.get("SUPABASE_PASSWORD_RECOVERY") == "code",
            encryption_key=key,
            market_mode="live" if env.get("MARKET_DATA_MODE") == "live" else "demo",
            database=env.get("WORKSPACE_DB", cls.__dataclass_fields__["database"].default),
        )
        settings.validate()
        return settings

    def validate(self):
        if bool(self.supabase_url) != bool(self.supabase_key):
            raise ValueError("Set both Supabase URL and publishable key.")
        if self.hosted and not re.fullmatch(r"https://[a-z0-9-]+\.supabase\.co", self.supabase_url, re.I):
            raise ValueError("SUPABASE_URL must be the HTTPS URL of the dedicated Supabase project.")
        if self.container_origin:
            if self.public_origin or exact_origin(self.container_origin, "http").hostname != "127.0.0.1":
                raise ValueError("LOCAL_CONTAINER_ORIGIN must be an exact http://127.0.0.1 origin.")
        if self.public_origin:
            exact_origin(self.public_origin, "https")
            if not self.hosted or not is_public_key(self.supabase_key) or self.encryption_key is None:
                raise ValueError("Public mode requires Supabase Auth, a publishable key, and SESSION_ENCRYPTION_KEY.")
        elif not self.container_origin and self.host not in LOOPBACK:
            raise ValueError("Set PUBLIC_ORIGIN and use HTTPS when exposing the app beyond localhost.")
        if self.hosted and self.market_mode == "live" and not all(
            os.environ.get(key) for key in ("SEC_USER_AGENT", "TWELVE_DATA_API_KEY")
        ):
            raise ValueError("Configure Twelve Data and SEC EDGAR for live mode.")
