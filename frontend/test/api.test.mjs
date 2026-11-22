import assert from "node:assert/strict";
import { test } from "node:test";
import { request } from "../src/api.js";

test("API failures preserve status for a non-JSON proxy response", async t => {
  t.mock.method(globalThis, "fetch", () => Promise.resolve(new Response("<h1>Bad gateway</h1>", { status: 502 })));
  await assert.rejects(request("/api/account"), { status: 502, message: "The request could not be completed." });
});

test("server validation errors remain visible to the account form", async t => {
  t.mock.method(globalThis, "fetch", () => Promise.resolve(Response.json({
    error: "The email address or password is incorrect.",
  }, { status: 400 })));
  await assert.rejects(request("/api/account"), { status: 400, message: "The email address or password is incorrect." });
});
