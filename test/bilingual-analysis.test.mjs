import assert from "node:assert/strict";
import { test } from "node:test";

test("each Gemini agent returns both languages with one score and one set of citations", async t => {
  process.env.GEMINI_MODEL = "fixture-model";
  process.env.GEMINI_API_KEY = "fixture-key";
  const { analyze } = await import("../src/analysis.mjs");

  const source = { id: "evidence-1", title: "Example filing", text: "Demand increased." };
  const english = "The company reported higher demand.";
  const german = "Das Unternehmen meldete eine höhere Nachfrage.";
  const fetch = t.mock.method(globalThis, "fetch", async (url, request) => {
    assert.match(url, /generativelanguage\.googleapis\.com/);
    const body = JSON.parse(request.body);
    assert.ok(body.generationConfig.responseJsonSchema.required.includes("rationaleDe"));
    assert.match(body.systemInstruction.parts[0].text, /rationaleDe in German/);
    const text = JSON.stringify({ score: 70, rationale: english, rationaleDe: german, citationIds: [source.id] });
    return Response.json({ candidates: [{ content: { parts: [{ text }] } }] });
  });
  const mcp = { call: async () => ({ mode: "demo", excerpts: [source] }) };
  const result = await analyze(mcp, { ticker: "NVDA" }, { horizon: "1m", agentCount: 3, providerId: "gemini" });

  assert.equal(fetch.mock.callCount(), 3);
  assert.equal(result.score, 70);
  for (const agent of result.agents) {
    assert.equal(agent.rationale, english);
    assert.equal(agent.rationaleDe, german);
    assert.deepEqual(agent.sources, [source]);
  }
});
