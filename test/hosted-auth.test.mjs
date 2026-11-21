import assert from "node:assert/strict";
import { test } from "node:test";

test("hosted signup stores the username and issues a session after verification", async t => {
  process.env.SUPABASE_URL = "https://test-project.supabase.co";
  process.env.SUPABASE_PUBLISHABLE_KEY = "test-publishable-key";
  const { createAccounts } = await import("../src/accounts.mjs");
  const accounts = createAccounts(":memory:");
  t.after(() => accounts.close());

  const email = "researcher@example.test";
  const password = "test-password";
  const username = "Stock_Researcher";
  const confirmationUrl = "http://127.0.0.1:8083/";
  const confirmedUser = {
    id: "confirmed-user", email, email_confirmed_at: "2026-11-20T12:00:00Z",
    user_metadata: { username }
  };
  const auth = {
    user: confirmedUser, access_token: "test-access-token", refresh_token: "test-refresh-token", expires_in: 3600
  };
  let confirmed = false;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const { pathname, searchParams } = new URL(url);
    const payload = JSON.parse(options.body);
    assert.equal(options.method, "POST");
    assert.equal(payload.email, email);
    if (pathname === "/auth/v1/signup") {
      assert.equal(searchParams.get("redirect_to"), confirmationUrl);
      assert.deepEqual(payload, { email, password, data: { username } });
      return Response.json({ id: confirmedUser.id });
    }
    if (pathname === "/auth/v1/resend") {
      assert.equal(searchParams.get("redirect_to"), confirmationUrl);
      assert.deepEqual(payload, { email, type: "signup" });
      return Response.json({});
    }
    if (pathname === "/auth/v1/verify") {
      assert.equal(payload.type, "signup");
      if (payload.token !== "123456" || confirmed) return Response.json({ msg: "Invalid code" }, { status: 403 });
      confirmed = true;
      return Response.json(auth);
    }
    assert.equal(pathname, "/auth/v1/token");
    assert.equal(searchParams.get("grant_type"), "password");
    if (payload.password !== password) {
      return Response.json({ msg: "Invalid login credentials", error_code: "invalid_credentials" }, { status: 400 });
    }
    if (!confirmed) {
      return Response.json({ msg: "Email not confirmed", error_code: "email_not_confirmed" }, { status: 400 });
    }
    return Response.json(auth);
  });

  await assert.rejects(accounts.signIn("signup", { email, password, username: "bad name" }), { status: 400 });
  const signup = await accounts.signIn("signup", { email, password, username }, confirmationUrl);
  assert.equal(signup.session, null);
  assert.equal(signup.verificationRequired, true);
  await assert.rejects(accounts.signIn("login", { email, password: "incorrect-password" }), {
    status: 400, code: "invalid_credentials", message: "The email address or password is incorrect."
  });
  const pending = await accounts.signIn("login", { email, password });
  assert.equal(pending.session, null);
  assert.equal(pending.verificationRequired, true);
  assert.equal((await accounts.signIn("resend", { email }, confirmationUrl)).verificationRequired, true);
  await assert.rejects(accounts.signIn("verify", { email, code: "654321" }), { status: 403 });
  const verified = await accounts.signIn("verify", { email, code: "123456" });
  assert.equal((await accounts.account(verified.session)).username, username);
  await assert.rejects(accounts.signIn("verify", { email, code: "123456" }), { status: 403 });
  const login = await accounts.signIn("login", { email, password });
  assert.equal((await accounts.account(login.session)).username, username);
});
