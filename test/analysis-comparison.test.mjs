import assert from "node:assert/strict";
import { test } from "node:test";
import { compareWithPrevious } from "../public/analysis-comparison.js";

function run(id, minute, overrides = {}) {
  return {
    id, ticker: "NVDA", horizon: "1m", provider: "gemini", model: "gemini-fixture", marketMode: "live",
    scoringVersion: "0.1", createdAt: new Date(Date.UTC(2025, 0, 1, 0, minute)).toISOString(),
    agents: [{ id: "financials", score: 62, sources: [] }, { id: "momentum", score: 71, sources: [] }],
    ...overrides
  };
}

test("comparison picks the closest older analysis with matching settings and specialists", () => {
  const current = run("current", 20);
  const previous = run("previous", 10, { agents: [...current.agents].reverse() });
  const incompatible = [
    run("other stock", 11, { ticker: "AAPL" }),
    run("other horizon", 12, { horizon: "1w" }),
    run("other provider", 13, { provider: "claude" }),
    run("other model", 14, { model: "another-model" }),
    run("demo data", 15, { marketMode: "demo" }),
    run("different scoring", 16, { scoringVersion: "0.2" }),
    run("different count", 17, { agents: current.agents.slice(0, 1) }),
    run("different agent", 18, { agents: [current.agents[0], { id: "outlook", score: 70, sources: [] }] }),
    run("simultaneous", 20),
    run("later", 21)
  ];
  assert.equal(compareWithPrevious(current, incompatible), null);
  const comparison = compareWithPrevious(current, [current, run("oldest", 1), ...incompatible, previous, run("older", 7)]);
  assert.equal(comparison.previous, previous);
  assert.deepEqual(comparison.agents.map(({ previous, current }) => [previous.id, current.id]), [
    ["financials", "financials"], ["momentum", "momentum"]
  ]);
});

test("comparison separates newly cited documents from changes to shared data snapshots", () => {
  const shared = { id: "filing-1-excerpt-1", url: "https://example.test/filing-1", text: "First exhibit." };
  const added = { id: "filing-2-excerpt-1", url: "https://example.test/filing-2", text: "Second filing." };
  const earlierSnapshot = { id: "momentum-data", url: "https://example.test/price-docs", date: "2025-01-01", text: '{"last":120}' };
  const updated = { ...earlierSnapshot, text: '{"last":125}' };
  const sharedSnapshot = { id: "financials-data", text: '{"cash":70}' };
  const earlier = run("earlier", 10, { agents: [
    { id: "financials", score: 62, sources: [shared, sharedSnapshot] },
    { id: "momentum", score: null, sources: [earlierSnapshot] }
  ] });
  const current = run("current", 20, { agents: [
    { id: "financials", score: 62, sources: [{ ...shared, id: "filing-1-excerpt-2" }, sharedSnapshot, added] },
    { id: "momentum", score: 71, sources: [updated, { ...added, id: "filing-2-excerpt-2" }] }
  ] });
  const comparison = compareWithPrevious(current, [earlier]);
  assert.deepEqual(comparison.addedSources, [added]);
  assert.deepEqual(comparison.updatedSources, [updated]);
  assert.equal(comparison.agents[1].previous.score, null);
  assert.equal(comparison.agents[1].current.score, 71);
});
