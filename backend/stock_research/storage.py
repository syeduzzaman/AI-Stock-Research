import asyncio
import json
import sqlite3
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlencode

from .security import AppError, now_ms

DEFAULTS = {"provider": "demo", "horizon": "1m", "agentCount": 5}


@dataclass(frozen=True, slots=True)
class User:
    id: str
    email: str | None
    username: str | None
    token: str | None


def open_database(filename: str):
    if filename != ":memory:":
        Path(filename).parent.mkdir(parents=True, mode=0o700, exist_ok=True)
    db = sqlite3.connect(filename, isolation_level=None)
    db.row_factory = sqlite3.Row
    db.executescript("""
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY, user_id TEXT NOT NULL, email TEXT, access TEXT,
            refresh TEXT, expires INTEGER NOT NULL, access_expires INTEGER, username TEXT
        );
        CREATE TABLE IF NOT EXISTS watchlist (
            user_id TEXT NOT NULL, ticker TEXT NOT NULL, added INTEGER NOT NULL, PRIMARY KEY (user_id, ticker)
        );
        CREATE TABLE IF NOT EXISTS holdings (
            user_id TEXT NOT NULL, ticker TEXT NOT NULL, shares REAL NOT NULL, average_cost REAL NOT NULL,
            PRIMARY KEY (user_id, ticker)
        );
        CREATE TABLE IF NOT EXISTS runs (
            id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created TEXT NOT NULL, result TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS runs_by_user ON runs (user_id, created DESC);
        CREATE TABLE IF NOT EXISTS preferences (user_id TEXT PRIMARY KEY, options TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS requests (scope TEXT NOT NULL, requested INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS requests_by_scope ON requests (scope, requested);
    """)
    columns = {row["name"] for row in db.execute("PRAGMA table_info(sessions)")}
    if "username" not in columns:
        db.execute("ALTER TABLE sessions ADD COLUMN username TEXT")
    return db


class WorkspaceStorage:
    def __init__(self, db, supabase):
        self.db = db
        self.supabase = supabase

    def rate_limit(self, scope, maximum, interval):
        now = now_ms()
        self.db.execute("BEGIN IMMEDIATE")
        try:
            self.db.execute("DELETE FROM requests WHERE requested < ?", (now - 3_600_000,))
            count = self.db.execute(
                "SELECT count(*) FROM requests WHERE scope = ? AND requested > ?", (scope, now - interval)
            ).fetchone()[0]
            if count >= maximum:
                raise AppError(429, "Too many attempts. Try again later.")
            self.db.execute("INSERT INTO requests VALUES (?, ?)", (scope, now))
            self.db.commit()
        except BaseException:
            self.db.rollback()
            raise

    async def rows(self, table, user, select, **params):
        return await self.remote(table, user, select=select, user_id=f"eq.{user.id}", **params)

    async def remote(self, table, user, *, method="GET", payload=None, prefer=None, **params):
        query = "?" + urlencode(params) if params else ""
        return await self.supabase.request("/rest/v1/" + table + query, method=method,
                                           token=user.token, payload=payload, prefer=prefer)

    async def watchlist(self, user):
        if user.token:
            rows = await self.rows("watchlist_items", user, "ticker", order="created_at.desc")
        else:
            rows = self.db.execute("SELECT ticker FROM watchlist WHERE user_id = ? ORDER BY added DESC", (user.id,))
        return [row["ticker"] for row in rows]

    async def portfolio(self, user):
        if user.token:
            return await self.rows("holdings", user, "ticker,shares,average_cost", order="ticker")
        return [dict(row) for row in self.db.execute(
            "SELECT ticker, shares, average_cost FROM holdings WHERE user_id = ? ORDER BY ticker", (user.id,)
        )]

    async def history(self, user):
        if user.token:
            rows = await self.rows("analysis_runs", user, "result", order="created_at.desc", limit=75)
            return [row["result"] for row in rows]
        return [json.loads(row[0]) for row in self.db.execute(
            "SELECT result FROM runs WHERE user_id = ? ORDER BY created DESC LIMIT 75", (user.id,)
        )]

    async def preferences(self, user):
        if user.token:
            rows = await self.rows("preferences", user, "provider,horizon,agent_count")
            if rows:
                row = rows[0]
                return {"provider": row["provider"], "horizon": row["horizon"], "agentCount": row["agent_count"]}
            return DEFAULTS
        row = self.db.execute("SELECT options FROM preferences WHERE user_id = ?", (user.id,)).fetchone()
        return json.loads(row[0]) if row else DEFAULTS

    async def snapshot(self, user):
        watchlist, portfolio, history, preferences = await asyncio.gather(
            self.watchlist(user), self.portfolio(user), self.history(user), self.preferences(user)
        )
        return {
            "watchlist": watchlist, "portfolio": portfolio, "preferences": preferences,
            "history": [{key: value for key, value in run.items() if key != "trace"} for run in history],
        }

    async def set_watch(self, user, ticker, add):
        if user.token:
            if add:
                await self.remote("watchlist_items", user, method="POST", payload={"user_id": user.id, "ticker": ticker},
                                  prefer="resolution=ignore-duplicates", on_conflict="user_id,ticker")
            else:
                await self.remote("watchlist_items", user, method="DELETE", user_id=f"eq.{user.id}", ticker=f"eq.{ticker}")
        elif add:
            self.db.execute("INSERT OR IGNORE INTO watchlist VALUES (?, ?, ?)", (user.id, ticker, now_ms()))
        else:
            self.db.execute("DELETE FROM watchlist WHERE user_id = ? AND ticker = ?", (user.id, ticker))

    async def set_holding(self, user, ticker, shares, cost):
        if user.token:
            if shares:
                await self.remote("holdings", user, method="POST", prefer="resolution=merge-duplicates",
                                  on_conflict="user_id,ticker",
                                  payload={"user_id": user.id, "ticker": ticker, "shares": shares, "average_cost": cost})
            else:
                await self.remote("holdings", user, method="DELETE", user_id=f"eq.{user.id}", ticker=f"eq.{ticker}")
        elif shares:
            self.db.execute(
                """INSERT INTO holdings VALUES (?, ?, ?, ?) ON CONFLICT(user_id,ticker)
                   DO UPDATE SET shares=excluded.shares, average_cost=excluded.average_cost""", (user.id, ticker, shares, cost)
            )
        else:
            self.db.execute("DELETE FROM holdings WHERE user_id = ? AND ticker = ?", (user.id, ticker))

    async def save_run(self, user, result):
        if user.token:
            await self.remote("analysis_runs", user, method="POST", payload={
                "id": result["id"], "user_id": user.id, "created_at": result["createdAt"], "result": result,
            })
        else:
            self.db.execute("INSERT INTO runs VALUES (?, ?, ?, ?)",
                            (result["id"], user.id, result["createdAt"], json.dumps(result, ensure_ascii=False)))

    async def save_preferences(self, user, options):
        if user.token:
            await self.remote("preferences", user, method="POST", prefer="resolution=merge-duplicates",
                              on_conflict="user_id", payload={
                                  "user_id": user.id, "provider": options["provider"],
                                  "horizon": options["horizon"], "agent_count": options["agentCount"],
                              })
        else:
            self.db.execute(
                """INSERT INTO preferences VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET options=excluded.options""",
                (user.id, json.dumps(options)),
            )
