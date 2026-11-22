import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { test } from "node:test";

process.env.PUBLIC_ORIGIN = "https://research.example.test";
process.env.SUPABASE_URL = "https://security-fixture.supabase.co";
process.env.SUPABASE_PUBLISHABLE_KEY = "sb_publishable_fixture";
process.env.SUPABASE_PASSWORD_RECOVERY = "code";
process.env.SESSION_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64url");
const { createAccounts, readSession } = await import("../src/accounts.mjs");
const { createDashboard } = await import("../src/server.mjs");
const { readSessionToken, sealSessionToken } = await import("../src/session-security.mjs");
const origin = process.env.PUBLIC_ORIGIN;
const email = "researcher@example.test";
const password = "fixture-password";
const confirmed = { id: "fixture-user", email, email_confirmed_at: "2026-11-21T12:00:00Z" };
const auth = { user: confirmed, access_token: "fixture-access", refresh_token: "fixture-refresh", expires_in: 3600 };

function requestFor(dashboard) {
  return async (path, { method = "GET", host = "research.example.test", requestOrigin, cookie, body, sameSite } = {}) => {
    const req = Object.assign(Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []), {
      method, url: path,
      headers: { host, origin: requestOrigin, cookie, "content-type": "application/json", "sec-fetch-site": sameSite },
      socket: { remoteAddress: "127.0.0.1" }
    });
    const headers = {};
    let responseBody;
    let status;
    await dashboard.handle(req, {
      setHeader(name, value) { headers[name.toLowerCase()] = value; },
      writeHead(code, extra) {
        status = code;
        for (const [name, value] of Object.entries(extra)) this.setHeader(name, value);
        return this;
      },
      end(data) { responseBody = JSON.parse(data); }
    });
    return { status, headers, body: responseBody };
  };
}

test("public auth validates host and origin, scopes cookies to HTTPS, and rotates sessions", async t => {
  const accounts = createAccounts(":memory:");
  const dashboard = createDashboard({ accounts, mcp: { close() {} } });
  t.after(() => dashboard.close());
  const fetch = t.mock.method(globalThis, "fetch", async url => {
    if (new URL(url).pathname === "/auth/v1/logout") return new Response(null, { status: 204 });
    return Response.json(auth);
  });
  const request = requestFor(dashboard);
  const body = { action: "login", email, password };
  for (const options of [
    { host: "other.example.test", requestOrigin: origin },
    { requestOrigin: "https://other.example.test" },
    {},
    { requestOrigin: origin, sameSite: "cross-site" }
  ]) {
    assert.equal((await request("/api/account", { method: "POST", body, ...options })).status, 403);
  }
  assert.equal(fetch.mock.callCount(), 0);
  const first = await request("/api/account", { method: "POST", requestOrigin: origin, body });
  assert.equal(first.status, 200);
  assert.match(first.headers["strict-transport-security"], /max-age=/);
  assert.match(first.headers["set-cookie"], /^__Host-sr_session=.+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=\d+; Secure$/);
  assert.equal(first.headers["cache-control"], "no-store");
  const oldCookie = first.headers["set-cookie"].split(";")[0];
  const newLogin = await request("/api/account", { method: "POST", requestOrigin: origin, body, cookie: oldCookie });
  const newCookie = newLogin.headers["set-cookie"].split(";")[0];
  assert.notEqual(newCookie, oldCookie);
  assert.equal((await request("/api/session", { cookie: oldCookie })).body.user, null);
  assert.equal((await request("/api/session", { cookie: newCookie.replace("__Host-", "") })).body.user, null);
  assert.equal((await request("/api/session", { cookie: newCookie })).body.user.email, email);

  const signedOut = await request("/api/logout", { method: "POST", requestOrigin: origin, cookie: newCookie });
  assert.equal(signedOut.status, 200);
  assert.match(signedOut.headers["set-cookie"], /^__Host-sr_session=;.*Max-Age=0; Secure$/);
  assert.equal((await request("/api/workspace", { cookie: newCookie })).status, 401);
  assert.equal(readSession({ headers: { cookie: newCookie + "; " + newCookie } }, true), undefined);
});

test("local revocation wins against an in-progress hosted refresh and an upstream outage", async t => {
  const accounts = createAccounts(":memory:");
  t.after(() => accounts.close());
  t.mock.method(console, "warn", () => {});
  const refresh = Promise.withResolvers();
  const refreshing = Promise.withResolvers();
  t.mock.method(globalThis, "fetch", async url => {
    const { pathname, searchParams } = new URL(url);
    if (pathname === "/auth/v1/logout") throw new Error("Fixture outage during revocation");
    if (searchParams.get("grant_type") === "refresh_token") {
      refreshing.resolve();
      return refresh.promise;
    }
    return Response.json({ ...auth, expires_in: 1 });
  });
  const { session } = await accounts.signIn("login", { email, password });
  const pending = accounts.account(session);
  await refreshing.promise;
  const signOut = accounts.signOut(session);
  assert.equal(await accounts.account(session), null);
  refresh.resolve(Response.json({ ...auth, access_token: "fixture-rotated-token" }));
  assert.equal(await pending, null);
  await signOut;
  assert.equal(await accounts.account(session), null);
});

test("auth limits repeated attempts for one normalized email without affecting another account", async t => {
  const dashboard = createDashboard({ accounts: createAccounts(":memory:"), mcp: { close() {} } });
  t.after(() => dashboard.close());
  const upstream = t.mock.method(globalThis, "fetch", async () => Response.json({ code: "invalid_credentials" }, { status: 400 }));
  const request = requestFor(dashboard);
  const login = email => request("/api/account", {
    method: "POST", requestOrigin: origin, body: { action: "login", email, password }
  });
  for (let attempt = 0; attempt < 8; attempt++) {
    assert.equal((await login(attempt % 2 ? email.toUpperCase() : email)).status, 400);
  }
  assert.equal((await login(email)).status, 429);
  assert.equal((await login("someone-else@example.test")).status, 400);
  assert.equal(upstream.mock.callCount(), 9);
});

test("recovery returns a generic request response and invalidates the user's existing sessions", async t => {
  const accounts = createAccounts(":memory:");
  t.after(() => accounts.close());
  let updates = 0;
  const calls = t.mock.method(globalThis, "fetch", async (url, options) => {
    const { pathname, searchParams } = new URL(url);
    const payload = options.body && JSON.parse(options.body);
    if (pathname === "/auth/v1/recover") {
      return payload.email === email ? Response.json({}) : Response.json({ code: "user_not_found" }, { status: 404 });
    }
    if (pathname === "/auth/v1/verify") {
      assert.equal(payload.type, "recovery");
      return payload.token === "123456" ? Response.json(auth) : Response.json({ code: "otp_expired" }, { status: 403 });
    }
    if (pathname === "/auth/v1/user") {
      assert.equal(options.method, "PUT");
      assert.equal(options.headers.Authorization, "Bearer " + auth.access_token);
      assert.equal(payload.password, "new fixture password");
      updates += 1;
      return Response.json(confirmed);
    }
    if (pathname === "/auth/v1/logout") {
      assert.equal(searchParams.get("scope"), "global");
      return new Response(null, { status: 204 });
    }
    return Response.json(auth);
  });
  const { session } = await accounts.signIn("login", { email, password });
  assert.deepEqual(await accounts.signIn("recover", { email }, origin), { recoveryRequested: true });
  assert.deepEqual(await accounts.signIn("recover", { email: "missing@example.test" }, origin), { recoveryRequested: true });
  await assert.rejects(accounts.signIn("reset", { email, code: "000000", password: "new fixture password" }), { status: 403 });
  assert.equal(updates, 0);
  assert.deepEqual(await accounts.signIn("reset", { email, code: "123456", password: "new fixture password" }), { passwordReset: true });
  assert.equal(updates, 1);
  assert.equal(await accounts.account(session), null);
  assert.ok(calls.mock.callCount() >= 7);
});

test("the encryption binds stored tokens to their session and token type", () => {
  const encrypted = sealSessionToken("sample token", "session-id", "refresh");
  assert.match(encrypted, /^v1\./);
  assert.doesNotMatch(encrypted, /sample token/);
  assert.equal(readSessionToken(encrypted, "session-id", "refresh"), "sample token");
  assert.throws(() => readSessionToken(encrypted, "another-session", "refresh"));
  assert.throws(() => readSessionToken(encrypted, "session-id", "access"));
});
