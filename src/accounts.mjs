import { createHash, randomBytes, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const endpoint = process.env.SUPABASE_URL?.replace(/\/$/, "");
const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY;
if (Boolean(endpoint) !== Boolean(publishableKey)) throw new Error("Set both Supabase URL and publishable key.");
if (endpoint && !/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(endpoint)) {
  throw new Error("SUPABASE_URL must be the HTTPS URL of the dedicated Supabase project.");
}
export const hosted = Boolean(endpoint && publishableKey);
export const confirmationMode = process.env.SUPABASE_EMAIL_CONFIRMATION === "code" ? "code" : "link";
const defaults = { provider: "demo", horizon: "1m", agentCount: 5 };
const sessionLife = 60 * 60 * 24 * 7;
const hash = value => createHash("sha256").update(value).digest("hex");
const usernamePattern = /^[a-zA-Z0-9_]{3,24}$/;
const confirmationMessage = confirmationMode === "code" ? "Check your email for the verification code."
  : "Check your email for the confirmation link.";

export class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function supabase(path, { method = "GET", token, payload, prefer, redirectTo } = {}) {
  const headers = { apikey: publishableKey, "Content-Type": "application/json" };
  if (token) headers.Authorization = "Bearer " + token;
  if (prefer) headers.Prefer = prefer;
  const url = new URL(path, endpoint);
  if (redirectTo) url.searchParams.set("redirect_to", redirectTo);
  const response = await fetch(url, {
    method, headers, body: payload === undefined ? undefined : JSON.stringify(payload), signal: AbortSignal.timeout(12_000)
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const authError = path.startsWith("/auth/");
    const code = authError ? (response.headers.get("x-sb-error-code") ?? data?.error_code ?? data?.code) : undefined;
    const message = authError
      ? (code === "invalid_credentials" ? "The email address or password is incorrect."
        : data?.msg ?? data?.error_description ?? data?.message ?? "Account request failed.")
      : "The workspace database could not complete the request.";
    throw new HttpError(response.status, message, code);
  }
  return data;
}

export function createAccounts(dbFile = process.env.WORKSPACE_DB ?? fileURLToPath(new URL("../data/workspace.sqlite", import.meta.url))) {
  if (dbFile !== ":memory:") mkdirSync(dirname(dbFile), { recursive: true });
  const db = new DatabaseSync(dbFile);
  db.exec(
    "PRAGMA journal_mode = WAL;" +
    "CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, email TEXT, access TEXT, refresh TEXT, expires INTEGER NOT NULL, access_expires INTEGER, username TEXT);" +
    "CREATE TABLE IF NOT EXISTS watchlist (user_id TEXT NOT NULL, ticker TEXT NOT NULL, added INTEGER NOT NULL, PRIMARY KEY (user_id, ticker));" +
    "CREATE TABLE IF NOT EXISTS holdings (user_id TEXT NOT NULL, ticker TEXT NOT NULL, shares REAL NOT NULL, average_cost REAL NOT NULL, PRIMARY KEY (user_id, ticker));" +
    "CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created TEXT NOT NULL, result TEXT NOT NULL);" +
    "CREATE INDEX IF NOT EXISTS runs_by_user ON runs (user_id, created DESC);" +
    "CREATE TABLE IF NOT EXISTS preferences (user_id TEXT PRIMARY KEY, options TEXT NOT NULL);" +
    "CREATE TABLE IF NOT EXISTS requests (scope TEXT NOT NULL, requested INTEGER NOT NULL);" +
    "CREATE INDEX IF NOT EXISTS requests_by_scope ON requests (scope, requested);"
  );
  if (!db.prepare("PRAGMA table_info(sessions)").all().some(column => column.name === "username")) {
    db.exec("ALTER TABLE sessions ADD COLUMN username TEXT");
  }
  const refreshing = new Map();

  function saveSession(account, auth) {
    const session = randomBytes(32).toString("base64url");
    const username = account.user_metadata?.username;
    db.prepare("DELETE FROM sessions WHERE expires <= ?").run(Date.now());
    db.prepare("INSERT INTO sessions (id, user_id, email, access, refresh, expires, access_expires, username) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(hash(session), account.id, account.email ?? null, auth?.access_token ?? null, auth?.refresh_token ?? null,
        Date.now() + sessionLife * 1000, auth ? Date.now() + auth.expires_in * 1000 : null,
        typeof username === "string" && usernamePattern.test(username) ? username : null);
    return session;
  }

  async function signIn(action, { email, password, username, code }, confirmationUrl) {
    if (!hosted) {
      if (action !== "demo") throw new HttpError(400, "Use the local demo workspace.");
      return { session: saveSession({ id: randomUUID() }), message: null };
    }
    if (!["login", "signup", "verify", "resend"].includes(action)) throw new HttpError(400, "Unknown account action.");
    email = typeof email === "string" ? email.trim() : "";
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new HttpError(400, "Enter a valid email address.");
    }
    if (action === "resend") {
      await supabase("/auth/v1/resend", { method: "POST", payload: { email, type: "signup" }, redirectTo: confirmationUrl });
      return { session: null, verificationRequired: true, message: confirmationMessage };
    }
    if (action === "verify") {
      if (typeof code !== "string" || !/^\d{6,10}$/.test(code.trim())) {
        throw new HttpError(400, "Enter the numeric code from your confirmation email.");
      }
      const result = await supabase("/auth/v1/verify", { method: "POST", payload: { email, token: code.trim(), type: "signup" } });
      return verifiedSession(result);
    }
    if (typeof password !== "string" || password.length > 256 || password.length < 8) {
      throw new HttpError(400, "Enter a password with at least 8 characters.");
    }
    if (action === "signup") {
      if (typeof username !== "string" || !usernamePattern.test(username.trim())) {
        throw new HttpError(400, "Use 3–24 letters, numbers, or underscores for your username.");
      }
      const result = await supabase("/auth/v1/signup", {
        method: "POST", payload: { email, password, data: { username: username.trim() } }, redirectTo: confirmationUrl
      });
      if (result?.access_token) throw new HttpError(503, "Email confirmation is unavailable. Contact the dashboard administrator.");
      return { session: null, verificationRequired: true, message: confirmationMessage };
    }
    try {
      const result = await supabase("/auth/v1/token?grant_type=password", { method: "POST", payload: { email, password } });
      return verifiedSession(result);
    } catch (error) {
      if (error.code !== "email_not_confirmed") throw error;
      return { session: null, verificationRequired: true, message: confirmationMessage };
    }
  }

  function verifiedSession(result) {
    if (!result?.access_token || !result.refresh_token || !result.user?.id || !result.user.email_confirmed_at) {
      throw new HttpError(403, "Confirm your email before signing in.");
    }
    return { session: saveSession(result.user, result), message: null };
  }

  async function account(session) {
    if (!session || !/^[\w-]{43}$/.test(session)) return null;
    const id = hash(session);
    const row = db.prepare("SELECT * FROM sessions WHERE id = ? AND expires > ?").get(id, Date.now());
    if (!row || Boolean(row.access) !== hosted) return null;
    if (row.refresh && row.access_expires <= Date.now() + 15_000) {
      if (!refreshing.has(id)) refreshing.set(id, (async () => {
        try {
          const next = await supabase("/auth/v1/token?grant_type=refresh_token", {
            method: "POST", payload: { refresh_token: row.refresh }
          });
          const replacement = { access: next.access_token, refresh: next.refresh_token, access_expires: Date.now() + next.expires_in * 1000 };
          db.prepare("UPDATE sessions SET access = ?, refresh = ?, access_expires = ? WHERE id = ?")
            .run(replacement.access, replacement.refresh, replacement.access_expires, id);
          return replacement.access;
        } catch (error) {
          if (![400, 401, 403].includes(error.status)) throw error;
          db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
          return null;
        } finally {
          refreshing.delete(id);
        }
      })());
      row.access = await refreshing.get(id);
      if (!row.access) return null;
    }
    return { id: row.user_id, email: row.email, username: row.username, token: row.access };
  }

  async function signOut(session, user) {
    if (session) db.prepare("DELETE FROM sessions WHERE id = ?").run(hash(session));
    if (user?.token) {
      try { await supabase("/auth/v1/logout?scope=local", { method: "POST", token: user.token }); }
      catch (error) { if (![401, 403].includes(error.status)) throw error; }
    }
  }

  const owner = user => "user_id=eq." + encodeURIComponent(user.id);
  async function watchlist(user) {
    const rows = hosted ? await supabase("/rest/v1/watchlist_items?select=ticker&order=created_at.desc&" + owner(user), { token: user.token })
      : db.prepare("SELECT ticker FROM watchlist WHERE user_id = ? ORDER BY added DESC").all(user.id);
    return rows.map(row => row.ticker);
  }
  async function setWatch(user, ticker, add) {
    if (hosted) {
      if (add) await supabase("/rest/v1/watchlist_items?on_conflict=user_id,ticker", {
        method: "POST", token: user.token, payload: { user_id: user.id, ticker }, prefer: "resolution=ignore-duplicates"
      });
      else await supabase("/rest/v1/watchlist_items?" + owner(user) + "&ticker=eq." + encodeURIComponent(ticker), { method: "DELETE", token: user.token });
    } else if (add) {
      db.prepare("INSERT OR IGNORE INTO watchlist VALUES (?, ?, ?)").run(user.id, ticker, Date.now());
    } else {
      db.prepare("DELETE FROM watchlist WHERE user_id = ? AND ticker = ?").run(user.id, ticker);
    }
  }
  async function portfolio(user) {
    if (hosted) return supabase("/rest/v1/holdings?select=ticker,shares,average_cost&order=ticker&" + owner(user), { token: user.token });
    return db.prepare("SELECT ticker, shares, average_cost FROM holdings WHERE user_id = ? ORDER BY ticker").all(user.id);
  }
  async function setHolding(user, { ticker, shares, average_cost: cost }) {
    if (hosted) {
      if (shares === 0) await supabase("/rest/v1/holdings?" + owner(user) + "&ticker=eq." + encodeURIComponent(ticker), { method: "DELETE", token: user.token });
      else await supabase("/rest/v1/holdings?on_conflict=user_id,ticker", {
        method: "POST", token: user.token, prefer: "resolution=merge-duplicates",
        payload: { user_id: user.id, ticker, shares, average_cost: cost }
      });
    } else if (shares === 0) {
      db.prepare("DELETE FROM holdings WHERE user_id = ? AND ticker = ?").run(user.id, ticker);
    } else {
      db.prepare("INSERT INTO holdings VALUES (?, ?, ?, ?) ON CONFLICT(user_id,ticker) DO UPDATE SET shares=excluded.shares, average_cost=excluded.average_cost")
        .run(user.id, ticker, shares, cost);
    }
  }
  async function history(user) {
    if (hosted) return (await supabase("/rest/v1/analysis_runs?select=result&order=created_at.desc&limit=75&" + owner(user), { token: user.token })).map(row => row.result);
    return db.prepare("SELECT result FROM runs WHERE user_id = ? ORDER BY created DESC LIMIT 75").all(user.id).map(row => JSON.parse(row.result));
  }
  async function saveRun(user, result) {
    if (hosted) {
      await supabase("/rest/v1/analysis_runs", {
        method: "POST", token: user.token,
        payload: { id: result.id, user_id: user.id, created_at: result.createdAt, result }
      });
    } else {
      db.prepare("INSERT INTO runs VALUES (?, ?, ?, ?)").run(result.id, user.id, result.createdAt, JSON.stringify(result));
    }
  }
  async function preferences(user) {
    if (hosted) {
      const [row] = await supabase("/rest/v1/preferences?select=provider,horizon,agent_count&" + owner(user), { token: user.token });
      return row ? { provider: row.provider, horizon: row.horizon, agentCount: row.agent_count } : defaults;
    }
    const row = db.prepare("SELECT options FROM preferences WHERE user_id = ?").get(user.id);
    return row ? JSON.parse(row.options) : defaults;
  }
  async function savePreferences(user, options) {
    if (hosted) {
      await supabase("/rest/v1/preferences?on_conflict=user_id", {
        method: "POST", token: user.token, prefer: "resolution=merge-duplicates",
        payload: { user_id: user.id, provider: options.provider, horizon: options.horizon, agent_count: options.agentCount }
      });
    } else {
      db.prepare("INSERT INTO preferences VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET options = excluded.options")
        .run(user.id, JSON.stringify(options));
    }
  }
  function rateLimit(scope, max, interval) {
    const now = Date.now();
    db.prepare("DELETE FROM requests WHERE requested < ?").run(now - 3_600_000);
    const { count } = db.prepare("SELECT count(*) AS count FROM requests WHERE scope = ? AND requested > ?").get(scope, now - interval);
    if (count >= max) throw new HttpError(429, "Too many attempts. Try again later.");
    db.prepare("INSERT INTO requests VALUES (?, ?)").run(scope, now);
  }
  return { signIn, signOut, account, watchlist, setWatch, portfolio, setHolding, history, saveRun, preferences, savePreferences, rateLimit, close: () => db.close() };
}

export function readSession(request) {
  return request.headers.cookie?.split(";").map(part => part.trim()).find(part => part.startsWith("sr_session="))?.slice(11);
}

export function sessionCookie(value, secure) {
  return "sr_session=" + (value ?? "") + "; Path=/; HttpOnly; SameSite=Lax; Max-Age="
    + (value ? sessionLife : 0) + (secure ? "; Secure" : "");
}
