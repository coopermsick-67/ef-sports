import assert from "node:assert/strict";
import { test, after } from "node:test";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

// Compile just the pure engine into an isolated temporary directory; no server or test dependency.
const compiled = await mkdtemp(join(tmpdir(), "edgeforge-engine-"));
for (const name of ["models", "optimizer"]) {
  const source = await readFile(new URL(`../lib/${name}.ts`, import.meta.url), "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  }).outputText.replace('from "./models"', 'from "./models.mjs"');
  await writeFile(join(compiled, `${name}.mjs`), output);
}
await writeFile(join(compiled, "types.mjs"), 'export const SPORTS = ["MLB", "NFL", "NCAAF", "NBA", "NCAAB"];');
await writeFile(join(compiled, "providers.mjs"), `
  let fixture; let failure = false;
  export function setCatalog(value) { fixture = value; failure = false; }
  export function fail() { failure = true; }
  export async function getCatalog() { if (failure) throw new Error("private provider failure"); return fixture; }
`);
const routeSource = await readFile(new URL("../app/api/combos/route.ts", import.meta.url), "utf8");
const routeOutput = ts.transpileModule(routeSource, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText
  .replaceAll('"@/lib/providers"', '"./providers.mjs"')
  .replaceAll('"@/lib/optimizer"', '"./optimizer.mjs"')
  .replaceAll('"@/lib/types"', '"./types.mjs"')
  .replace('"zod"', JSON.stringify(pathToFileURL(join(process.cwd(), "node_modules/zod/index.js")).href));
await writeFile(join(compiled, "route.mjs"), routeOutput);
const { optimizeCombos } = await import(pathToFileURL(join(compiled, "optimizer.mjs")));
const { estimateBinaryMarket, frechetBounds } = await import(pathToFileURL(join(compiled, "models.mjs")));
const { POST } = await import(pathToFileURL(join(compiled, "route.mjs")));
const fixtureProvider = await import(pathToFileURL(join(compiled, "providers.mjs")));
after(async () => rm(compiled, { recursive: true, force: true }));

const now = Date.parse("2026-10-13T22:00:00Z");
const fetchedAt = new Date(now).toISOString();
const request = { sports: ["MLB", "NFL", "NBA"], start: "2026-10-13", end: "2026-10-16", venue: "kalshi", legs: 2, stake: 10 };
function market(id, p, overrides = {}) {
  return {
    id, eventId: `event-${id}`, gameId: `game-${id}`, venue: "kalshi", sport: "MLB",
    title: `Will ${id} win?`, selection: `${id} wins`, noSelection: `${id} does not win`,
    category: "moneyline", startsAt: "2026-10-14T00:00:00Z", startsAtSource: "schedule",
    yesBid: p - 0.005, yesAsk: p + 0.005, noBid: 1 - p - 0.005, noAsk: 1 - p + 0.005,
    volume: 100, liquidity: 100, updatedAt: fetchedAt, fetchedAt, url: "https://example.test/market",
    probabilityBasis: "market-implied", status: "open",
    settlement: { type: "binary", rules: "The selected team wins this scheduled game.", verified: true },
    matching: "schedule-verified", teams: [`${id} team`, `${id} opponent`], ...overrides,
  };
}
function catalog(markets, games = []) {
  return { markets, games, sources: [], fetchedAt, warnings: [] };
}
function run(markets, overrides = {}, games = []) {
  return optimizeCombos(catalog(markets, games), { ...request, minReferencePayout: 1, ...overrides }, { now });
}
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} ≠ ${expected}`);

test("normalized binary midpoint probabilities and dependence bounds", () => {
  const estimate = estimateBinaryMarket(market("A", 0.7, { yesBid: 0.70, yesAsk: 0.74, noBid: 0.30, noAsk: 0.34 }));
  close(estimate.yes, 0.72 / 1.04);
  close(estimate.yes + estimate.no, 1);
  close(estimate.yesSpread, 0.04);
  const bounds = frechetBounds([0.8, 0.7, 0.6]);
  close(bounds.lowerBound, 0.1);
  close(bounds.upperBound, 0.6);
  assert.throws(() => frechetBounds([Number.NaN]), RangeError);
});

test("payout floor chooses a lower-chance combination with a meaningful reference multiplier", () => {
  const result = run([market("high", 0.85), market("middle", 0.75), market("cheap", 0.55)], { minReferencePayout: 3 });
  assert.ok(result.combos[0].probability < 0.85 * 0.75);
  assert.ok(result.combos[0].referenceGrossMultiplier >= 3);
  close(result.combos[0].referenceBreakEven, result.combos[0].legs.reduce((price, leg) => price * leg.entryPrice, 1));
  assert.equal(result.combos[0].estimatedReturn, null);
  assert.equal(result.combos[0].executableQuote, null);
  assert.equal(result.combos[0].modelStatus, "unavailable");
});

test("considers the NO selection and never combines contradictory sides", () => {
  const result = run([market("underdog", 0.12), market("other", 0.7)]);
  const leg = result.combos[0].legs.find((selection) => selection.marketId === "underdog");
  assert.equal(leg.side, "no");
  close(leg.probability, 0.88);
  for (const combo of result.combos) assert.equal(new Set(combo.legs.map((selection) => selection.eventGroup)).size, 2);
});

test("removes stale, closed, completed, and duplicate data before ranking", () => {
  const markets = [
    market("closed", 0.99, { status: "closed" }),
    market("stale", 0.99, { fetchedAt: new Date(now - 301_000).toISOString() }),
    market("finished", 0.99),
    market("fresh", 0.8, { fetchedAt: new Date(now - 2000).toISOString() }),
    market("fresh", 0.7),
    market("other", 0.6),
  ];
  const result = run(markets, {}, [{ id: "game-finished", status: "final" }]);
  close(result.combos[0].probability, 0.7 * 0.6);
  assert.equal(result.diagnostics.rejected["closed-market"], 1);
  assert.equal(result.diagnostics.rejected["stale-market"], 1);
  assert.equal(result.diagnostics.rejected["finished-game"], 1);
  assert.equal(result.diagnostics.rejected["duplicate-market"], 1);
});

test("live games are excluded from pregame combo research", () => {
  const result = run([market("live", 0.6), market("scheduled", 0.6)], { legs: 1 }, [{ id: "game-live", status: "live" }]);
  assert.equal(result.combos[0].legs[0].marketId, "scheduled");
  assert.equal(result.diagnostics.rejected["game-not-scheduled"], 1);
});

test("one canonical game across venues yields only one leg", () => {
  const result = run([
    market("kalshi", 0.90, { gameId: "same-game" }),
    market("poly", 0.85, { gameId: "same-game", venue: "polymarket-us" }),
    market("third", 0.7),
  ], { venue: "all" });
  close(result.combos[0].probability, 0.9 * 0.7);
  assert.equal(result.diagnostics.independentEventGroups, 2);
});

test("unmatched events cannot bypass physical game deduplication in any venue", () => {
  for (const venue of ["all", "kalshi"]) {
    const result = run([market("unknown", 0.9, { gameId: undefined }), market("mapped", 0.8)], { venue });
    assert.equal(result.combos.length, 0);
    assert.equal(result.diagnostics.rejected["unmapped-game"], 1);
  }
});

test("multi-day multi-sport constraints and optional required sport coverage", () => {
  const markets = [
    market("MLB1", 0.95), market("MLB2", 0.94),
    market("NFL", 0.8, { sport: "NFL", startsAt: "2026-10-15T23:00:00Z" }),
    market("old", 0.99, { startsAt: "2026-10-12T20:00:00Z" }),
  ];
  const result = run(markets, { sports: ["MLB", "NFL"], requireEachSport: true });
  close(result.combos[0].probability, 0.95 * 0.8);
  assert.deepEqual(new Set(result.combos[0].legs.map((leg) => leg.sport)), new Set(["MLB", "NFL"]));
  assert.equal(result.diagnostics.rejected["date-filter"], 1);
});

test("date boundaries use New York calendar days, not UTC date", () => {
  const result = run([
    market("late", 0.8, { startsAt: "2026-10-14T03:30:00Z" }),
    market("after-midnight", 0.9, { startsAt: "2026-10-14T04:30:00Z" }),
  ], { start: "2026-10-13", end: "2026-10-13", legs: 1 });
  assert.equal(result.combos[0].legs[0].marketId, "late");
});

test("ten legs are allowed even when the joint chance is low; eleven are rejected", () => {
  const markets = Array.from({ length: 10 }, (_, i) => market(`leg-${i}`, 0.51));
  const result = run(markets, { legs: 10 });
  assert.equal(result.combos[0].legs.length, 10);
  close(result.combos[0].probability, 0.51 ** 10);
  assert.ok(result.combos[0].probability < 0.002);
  assert.throws(() => run(markets, { legs: 11 }), RangeError);
  assert.throws(() => run(markets, { legs: 0 }), RangeError);
});

test("insufficient independent events returns a useful empty result", () => {
  const result = run([market("one", 0.9), market("prop", 0.95, { gameId: "game-one" })]);
  assert.equal(result.combos.length, 0);
  assert.equal(result.diagnostics.availableLegs, 1);
  assert.ok(result.warnings.some((warning) => warning.includes("Only 1 eligible distinct events")));
});

test("missing quote data and unverified settlement are not presented as modeled confidence", () => {
  const result = run([
    market("missing", 0.9, { yesBid: null, yesAsk: null, noBid: null, noAsk: null }),
    market("crossed", 0.9, { yesBid: 0.95, yesAsk: 0.8, probability: 0.9, probabilityMethod: "normalized-binary-midpoints" }),
    market("unverified", 0.95, { settlement: { type: "unknown", rules: "", verified: false } }),
  ], { legs: 1 });
  assert.equal(result.combos.length, 0);
  assert.equal(result.diagnostics.rejected["unavailable-probability"], 2);
  assert.equal(result.diagnostics.rejected["unverified-settlement"], 1);
});

test("spread, liquidity, games, categories, and excluded selection filters work", () => {
  const result = run([
    market("unknown-liquidity", 0.99, { liquidity: null }),
    market("wide", 0.9, { yesBid: 0.8, yesAsk: 1, noBid: 0, noAsk: 0.2 }),
    market("chosen", 0.8), market("unselected-game", 0.95),
  ], { legs: 1, minLiquidity: 20, maxSpread: 0.03, gameIds: ["game-chosen", "game-wide", "game-unknown-liquidity"], excluded: ["chosen:yes"] });
  assert.equal(result.combos[0].legs[0].id, "chosen:no");
  close(result.combos[0].probability, 0.2);
});

test("repeated teams across dates are excluded from the independence screen", () => {
  const result = run([
    market("today", 0.8, { teams: ["Dodgers", "Padres"] }),
    market("tomorrow", 0.7, { startsAt: "2026-10-15T00:00:00Z", teams: ["Dodgers", "Mets"] }),
  ]);
  assert.equal(result.combos.length, 0);
  const bounds = frechetBounds([0.8, 0.7]);
  close(bounds.lowerBound, 0.5);
  close(bounds.upperBound, 0.7);
});

test("payout-constrained search respects the floor and distinct games", () => {
  for (let seed = 1; seed <= 12; seed++) {
    let value = seed;
    const random = () => { value = (value * 48271) % 2147483647; return value / 2147483647; };
    const markets = Array.from({ length: 12 }, (_, i) => market(`m-${i}`, 0.1 + random() * 0.8, { gameId: `g-${Math.floor(i / 2)}` }));
    const result = run(markets, { legs: 3, minReferencePayout: 5 });
    for (const combo of result.combos) {
      assert.ok(combo.referenceGrossMultiplier >= 5 - 1e-10);
      assert.equal(new Set(combo.legs.map((leg) => leg.gameId)).size, 3);
    }
  }
});

test("anchored game combos include the selected matchup and another game", () => {
  const result = run([market("A", 0.58), market("B", 0.6), market("C", 0.7)], { anchorGameId: "game-A", minReferencePayout: 3 });
  assert.ok(result.combos.length > 0);
  for (const combo of result.combos) {
    assert.ok(combo.legs.some((leg) => leg.gameId === "game-A"));
    assert.equal(new Set(combo.legs.map((leg) => leg.gameId)).size, 2);
  }
  const missing = run([market("B", 0.6)], { anchorGameId: "game-A" });
  assert.equal(missing.combos.length, 0);
});

test("missing ask and wide spreads cannot pass the payout screen", () => {
  const result = run([
    market("missing", 0.6, { yesAsk: null, noAsk: null }),
    market("wide", 0.6, { yesBid: 0.4, yesAsk: 0.6, noBid: 0.4, noAsk: 0.6 }),
  ], { legs: 1 });
  assert.equal(result.combos.length, 0);
  assert.ok((result.diagnostics.rejected["unavailable-probability"] ?? 0) + (result.diagnostics.rejected["unavailable-ask"] ?? 0) > 0);
  assert.ok((result.diagnostics.rejected["wide-spread"] ?? 0) > 0);
});

test("payout screen avoids a near-certain filler leg", () => {
  const result = run([market("filler", 0.99), market("balanced-a", 0.58), market("balanced-b", 0.52)], { minReferencePayout: 3 });
  for (const combo of result.combos) {
    assert.ok(combo.legs.every((leg) => leg.probability <= 0.8));
    assert.ok(combo.legs.every((leg) => leg.probability >= 0.2));
  }
  assert.ok((result.diagnostics.rejected["extreme-single-leg-proxy"] ?? 0) > 0);
});

test("POST handler validates dates, sports, and the ten-leg maximum", async () => {
  for (const invalid of [
    { ...request, start: "2026-02-30" },
    { ...request, start: "2026-10-20", end: "2026-10-13" },
    { ...request, end: "2026-12-20" },
    { ...request, sports: [] },
    { ...request, legs: 11 },
    { ...request, legs: 2.5 },
    { ...request, maxSpread: 2 },
    { ...request, anchorGameId: "game-one", anchorGameIds: ["game-two"] },
    { ...request, anchorGameIds: Array.from({ length: 49 }, (_, index) => `game-${index}`) },
  ]) {
    const response = await POST(new Request("http://localhost/api/combos", { method: "POST", body: JSON.stringify(invalid) }));
    assert.equal(response.status, 400);
    assert.ok((await response.json()).error.length > 0);
  }
});

test("POST returns ranked research combinations and explicitly no executable quote", async () => {
  fixtureProvider.setCatalog(catalog([
    market("first", 0.8, { fetchedAt: new Date().toISOString() }),
    market("second", 0.7, { fetchedAt: new Date().toISOString() }),
  ]));
  const response = await POST(new Request("http://localhost/api/combos", { method: "POST", body: JSON.stringify(request) }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  const result = await response.json();
  assert.ok(result.combos[0].referenceGrossMultiplier >= 3);
  assert.equal(result.combos[0].executableQuote, null);
  assert.equal(result.combos[0].hypothetical, true);
  assert.equal(result.diagnostics.ranking, "payout-constrained-market-proxy");
});

test("POST prepares a bounded slate of one anchored combo per requested game", async () => {
  const current = new Date().toISOString();
  fixtureProvider.setCatalog(catalog([
    market("first", 0.72, { fetchedAt: current }),
    market("second", 0.66, { fetchedAt: current }),
    market("third", 0.61, { fetchedAt: current }),
  ]));
  const response = await POST(new Request("http://localhost/api/combos", {
    method: "POST",
    body: JSON.stringify({ ...request, sports: ["MLB"], minReferencePayout: 1, anchorGameIds: ["game-first", "game-second"] }),
  }));
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.deepEqual(Object.keys(result.gameCombos).sort(), ["game-first", "game-second"]);
  for (const gameId of ["game-first", "game-second"]) {
    assert.equal(result.gameCombos[gameId].combos.length, 1);
    assert.ok(result.gameCombos[gameId].combos[0].legs.some((leg) => leg.gameId === gameId));
  }
});

test("POST provider failures and invalid JSON never return fabricated selections", async () => {
  fixtureProvider.fail();
  const failed = await POST(new Request("http://localhost/api/combos", { method: "POST", body: JSON.stringify(request) }));
  assert.equal(failed.status, 503);
  const result = await failed.json();
  assert.deepEqual(result.combos, []);
  assert.equal(JSON.stringify(result).includes("private provider failure"), false);
  const invalid = await POST(new Request("http://localhost/api/combos", { method: "POST", body: "{" }));
  assert.equal(invalid.status, 400);
});
