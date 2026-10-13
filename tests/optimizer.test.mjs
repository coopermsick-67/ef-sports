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
  return optimizeCombos(catalog(markets, games), { ...request, ...overrides }, { now });
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

test("selects highest probability irrespective of price, payout, or an edge target", () => {
  const result = run([market("high", 0.85), market("middle", 0.75), market("cheap", 0.55)]);
  assert.equal(result.combos.length, 3);
  assert.ok(result.combos.every((combo) => combo.legs.length === 2));
  assert.deepEqual(result.combos[0].legs.map((leg) => leg.marketId).sort(), ["high", "middle"]);
  close(result.combos[0].probability, 0.85 * 0.75);
  // These expensive favorites imply less than a 2x ask-price reference multiplier.
  // They must still rank first: there is no hidden payout floor.
  assert.ok(1 / result.combos[0].legs.reduce((product, leg) => product * leg.entryPrice, 1) < 2);
  assert.equal(result.diagnostics.algorithm, "exact-k-best-dynamic-programming");
  assert.equal(result.diagnostics.ranking, "winning-probability");
  assert.equal(result.combos[0].estimatedReturn, null);
  assert.equal(result.combos[0].executableQuote, null);
  assert.equal(result.combos[0].modelStatus, "unavailable");
});

test("changing standalone ask prices without changing marginals does not change ranking", () => {
  const narrow = [market("highest", 0.9), market("middle", 0.8), market("lowest", 0.7)];
  const wide = [
    market("highest", 0.9, { yesBid: 0.81, yesAsk: 0.99, noBid: 0.01, noAsk: 0.19 }),
    ...narrow.slice(1),
  ];
  const baseline = run(narrow);
  const changed = run(wide);
  assert.deepEqual(changed.combos.map((combo) => combo.legs.map((leg) => leg.id)),
    baseline.combos.map((combo) => combo.legs.map((leg) => leg.id)));
  changed.combos.forEach((combo, index) => close(combo.probability, baseline.combos[index].probability));
  assert.equal(changed.combos[0].legs.find((leg) => leg.marketId === "highest").entryPrice, 0.99);
});

test("returns the exact requested number of legs and probability optimum for every count from one through ten", () => {
  const probabilities = Array.from({ length: 10 }, (_, index) => 0.55 + index * 0.04);
  const markets = probabilities.map((p, index) => market(`count-${index}`, p));
  for (let legs = 1; legs <= 10; legs++) {
    const result = run(markets, { legs });
    assert.equal(result.combos.length, 3);
    assert.ok(result.combos.every((combo) => combo.legs.length === legs));
    const expected = [...probabilities].sort((a, b) => b - a).slice(0, legs).reduce((product, p) => product * p, 1);
    close(result.combos[0].probability, expected);
  }
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

test("repeated-team dependence is disclosed with mathematical bounds", () => {
  const result = run([
    market("today", 0.8, { teams: ["Dodgers", "Padres"] }),
    market("tomorrow", 0.7, { startsAt: "2026-10-15T00:00:00Z", teams: ["Dodgers", "Mets"] }),
  ]);
  assert.deepEqual(result.combos[0].repeatedTeams, ["Dodgers"]);
  assert.ok(result.combos[0].warnings.some((warning) => warning.includes("Shared form")));
  close(result.combos[0].lowerBound, 0.5);
  close(result.combos[0].upperBound, 0.7);
});

test("exact top-three dynamic programming agrees with exhaustive enumeration", () => {
  // Overlapping markets per game make naive top-leg selection invalid. Check the full top-k.
  for (let seed = 1; seed <= 12; seed++) {
    let value = seed;
    const random = () => { value = (value * 48271) % 2147483647; return value / 2147483647; };
    const markets = Array.from({ length: 12 }, (_, i) => market(`m-${i}`, 0.1 + random() * 0.8, { gameId: `g-${Math.floor(i / 2)}` }));
    const result = run(markets, { legs: 3 });
    assert.equal(result.combos.length, 3);
    assert.ok(result.combos.every((combo) => combo.legs.length === 3));
    const groups = new Map();
    for (const item of markets) {
      const p = estimateBinaryMarket(item).yes;
      groups.set(item.gameId, [...(groups.get(item.gameId) ?? []), p, 1 - p]);
    }
    const all = [];
    function visit(entries, index, count, product) {
      if (count === 3) { all.push(product); return; }
      if (index === entries.length) return;
      visit(entries, index + 1, count, product);
      for (const p of entries[index]) visit(entries, index + 1, count + 1, product * p);
    }
    visit([...groups.values()], 0, 0, 1);
    all.sort((a, b) => b - a);
    result.combos.forEach((combo, index) => close(combo.probability, all[index]));
  }
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
    { ...request, minReferencePayout: 3 },
    { ...request, anchorGameId: "forced-game" },
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
  close(result.combos[0].probability, 0.56);
  assert.equal(result.combos[0].executableQuote, null);
  assert.equal(result.combos[0].hypothetical, true);
  assert.equal(result.diagnostics.ranking, "winning-probability");
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
