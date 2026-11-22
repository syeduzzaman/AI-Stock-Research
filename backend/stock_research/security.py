import hashlib
import re
import secrets
import time

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from .config import decode_urlsafe, encode_urlsafe

SESSION_LIFE = 7 * 24 * 60 * 60
SESSION_PATTERN = re.compile(r"[A-Za-z0-9_-]{43}")


class AppError(Exception):
    def __init__(self, status: int, message: str, code: str | None = None):
        super().__init__(message)
        self.status = status
        self.code = code


def now_ms() -> int:
    return time.time_ns() // 1_000_000


def digest(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


class SessionCipher:
    """Read and write the same v1 envelope used by the previous server."""

    def __init__(self, key: bytes | None):
        self.cipher = AESGCM(key) if key else None

    def seal(self, token: str | None, session_id: str, field: str) -> str | None:
        if token is None or self.cipher is None:
            return token
        nonce = secrets.token_bytes(12)
        encrypted = self.cipher.encrypt(nonce, token.encode(), f"{session_id}:{field}".encode())
        ciphertext, tag = encrypted[:-16], encrypted[-16:]
        return "v1." + encode_urlsafe(nonce + tag + ciphertext)

    def open(self, value: str | None, session_id: str, field: str) -> str | None:
        if value is None or not value.startswith("v1."):
            return value
        if self.cipher is None:
            raise RuntimeError("The session encryption key is unavailable.")
        envelope = decode_urlsafe(value[3:])
        nonce, tag, ciphertext = envelope[:12], envelope[12:28], envelope[28:]
        return self.cipher.decrypt(nonce, ciphertext + tag, f"{session_id}:{field}".encode()).decode()


def cookie_name(secure: bool) -> str:
    return "__Host-sr_session" if secure else "sr_session"


def read_session(headers, secure: bool) -> str | None:
    prefix = cookie_name(secure) + "="
    values = [part.strip()[len(prefix):] for header in headers.getlist("cookie")
              for part in header.split(";") if part.strip().startswith(prefix)]
    if len(values) == 1 and SESSION_PATTERN.fullmatch(values[0]):
        return values[0]
    return None


def session_cookie(value: str | None, secure: bool) -> str:
    suffix = "; Secure" if secure else ""
    max_age = SESSION_LIFE if value else 0
    return f"{cookie_name(secure)}={value or ''}; Path=/; HttpOnly; SameSite=Lax; Max-Age={max_age}{suffix}"
