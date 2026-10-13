import type { Catalog, Market, MarketCategory, Sport, Venue } from "./types";
import { estimateBinaryMarket, frechetBounds } from "./models";

export interface ComboRequest {
  sports: Sport[];
  start: string;
  end: string;
  venue: Venue | "all";
  legs: number;
  stake?: number;
  marketCategories?: MarketCategory[];
  minLiquidity?: number;
  maxSpread?: number;
  excluded?: string[];
  gameIds?: string[];
  requireEachSport?: boolean;
  minReferencePayout?: number;
  anchorGameId?: string;
}

export interface ComboLeg extends Market {
  marketId: string;
  side: "yes" | "no";
  probability: number;
  probabilityMethod: string;
  entryPrice: number | null;
  spread: number | null;
  reason: string;
  eventGroup: string;
}

export interface Combo {
  id: string;
  rank: number;
  legs: ComboLeg[];
  probability: number;
  probabilityBasis: "market-implied-independent";
  lowerBound: number;
  upperBound: number;
  assumptions: string[];
  warnings: string[];
  hypothetical: true;
  executableQuote: null;
  stake: number;
  estimatedReturn: null;
  modelStatus: "unavailable";
  independentEvents: number;
  repeatedTeams: string[];
  referenceGrossMultiplier: number;
  referenceBreakEven: number;
}

export interface ComboResult {
  combos: Combo[];
  warnings: string[];
  diagnostics: {
    inputMarkets: number;
    eligibleMarkets: number;
    candidateSelections: number;
    independentEventGroups: number;
    requestedLegs: number;
    availableLegs: number;
    algorithm: "payout-bucket-dynamic-programming";
    ranking: "payout-constrained-market-proxy";
    modelStatus: "unavailable";
    rejected: Record<string, number>;
  };
}

const FRESHNESS_MS = 5 * 60 * 1000;
const dateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
});

function gameDate(startsAt: string): string | null {
  const date = new Date(startsAt);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = dateFormatter.formatToParts(date);
  const part = (name: string) => parts.find((p) => p.type === name)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function eventGroup(market: Market): string {
  // Verified schedule identities merge markets, opposite selections, and venues for one game.
  if (market.gameId) return `game:${market.gameId}`;
  return `event:${market.venue}:${market.eventId}`;
}

function teamKey(sport: Sport, team: string): string {
  return `${sport}:${team.toLowerCase().replace(/[^a-z0-9]/g, "")}`;
}

interface PartialCombo {
  legs: ComboLeg[];
  logProbability: number;
  logReferencePayout: number;
  sportsMask: number;
  hasAnchor: boolean;
  key: string;
}

function keepBest(options: PartialCombo[]): PartialCombo[] {
  const buckets = new Map<number, PartialCombo[]>();
  const seen = new Set<string>();
  for (const option of options.sort((a, b) => b.logProbability - a.logProbability || a.key.localeCompare(b.key))) {
    if (seen.has(option.key)) continue;
    seen.add(option.key);
    const bucket = Math.min(60, Math.floor(option.logReferencePayout / 0.15));
    const paths = buckets.get(bucket) ?? [];
    if (paths.length < 5) { paths.push(option); buckets.set(bucket, paths); }
  }
  return [...buckets.values()].flat().sort((a, b) => b.logProbability - a.logProbability).slice(0, 300);
}

/**
 * Bounded payout-bucket search. Each physical game contributes at most one selection.
 * This is a market-price research screen, not a claim of positive expected value.
 */
export function optimizeCombos(
  catalog: Catalog,
  request: ComboRequest,
  options: { now?: number; limit?: number } = {},
): ComboResult {
  if (!Number.isInteger(request.legs) || request.legs < 1 || request.legs > 10) {
    throw new RangeError("Choose between 1 and 10 legs.");
  }
  const now = options.now ?? Date.now();
  const limit = Math.max(1, Math.min(10, Math.floor(options.limit ?? 3)));
  const payoutFloor = request.minReferencePayout ?? 3;
  if (!Number.isFinite(payoutFloor) || payoutFloor < 1 || payoutFloor > 100) {
    throw new RangeError("Choose a reference payout target between 1x and 100x.");
  }
  const rejected: Record<string, number> = {};
  const reject = (reason: string) => { rejected[reason] = (rejected[reason] ?? 0) + 1; };
  const selectedSports = [...new Set(request.sports)];
  const sports = new Set(selectedSports);
  const excluded = new Set(request.excluded ?? []);
  const games = new Set(request.gameIds ?? []);
  const categories = new Set(request.marketCategories ?? []);
  const schedule = new Map(catalog.games.map((game) => [game.id, game]));
  const groups = new Map<string, ComboLeg[]>();
  const seenMarkets = new Set<string>();
  let eligibleMarkets = 0;
  let candidateSelections = 0;

  // Freshest record wins when provider pages overlap.
  const markets = [...catalog.markets].sort((a, b) => Date.parse(b.fetchedAt) - Date.parse(a.fetchedAt));
  for (const market of markets) {
    const identity = `${market.venue}:${market.id}`;
    if (seenMarkets.has(identity)) { reject("duplicate-market"); continue; }
    seenMarkets.add(identity);
    if (!sports.has(market.sport)) { reject("sport-filter"); continue; }
    if (request.venue !== "all" && market.venue !== request.venue) { reject("venue-filter"); continue; }
    if (excluded.has(market.id) || excluded.has(identity)) { reject("excluded-market"); continue; }
    if (market.status !== "open") { reject("closed-market"); continue; }
    if (!market.settlement.verified || market.settlement.type !== "binary") { reject("unverified-settlement"); continue; }
    if (!market.eventId && !market.gameId) { reject("unknown-event"); continue; }
    // Different market categories may have different venue event IDs for the same game.
    // Require a physical schedule identity even within one venue to prevent hidden same-game legs.
    if (!market.gameId || market.matching !== "schedule-verified") { reject("unmapped-game"); continue; }
    const snapshot = Date.parse(market.fetchedAt);
    if (!Number.isFinite(snapshot) || now - snapshot > FRESHNESS_MS || snapshot - now > 60_000) {
      reject("stale-market"); continue;
    }
    const date = gameDate(market.startsAt);
    if (!date || date < request.start || date > request.end) { reject("date-filter"); continue; }
    const game = market.gameId ? schedule.get(market.gameId) : undefined;
    if (game && (game.status === "final" || game.status === "postponed")) { reject("finished-game"); continue; }
    if (game && game.status !== "scheduled") { reject("game-not-scheduled"); continue; }
    if (games.size && (!market.gameId || !games.has(market.gameId))) { reject("game-filter"); continue; }
    if (categories.size && !categories.has(market.category)) { reject("category-filter"); continue; }
    if ((request.minLiquidity ?? 0) > 0 &&
        (market.liquidity === null || market.liquidity < request.minLiquidity!)) {
      reject(market.liquidity === null ? "unknown-liquidity" : "liquidity-filter"); continue;
    }
    const estimate = estimateBinaryMarket(market);
    if (!estimate) { reject("unavailable-probability"); continue; }
    const group = eventGroup(market);
    const selections: ComboLeg[] = [];
    for (const side of ["yes", "no"] as const) {
      if (excluded.has(`${market.id}:${side}`)) continue;
      const spread = side === "yes" ? estimate.yesSpread : estimate.noSpread;
      if (request.maxSpread !== undefined && (spread === null || spread > request.maxSpread + 1e-12)) {
        reject(spread === null ? "unknown-spread" : "spread-filter"); continue;
      }
      const probability = side === "yes" ? estimate.yes : estimate.no;
      const entryPrice = side === "yes" ? market.yesAsk : market.noAsk;
      if (payoutFloor > 1 && (probability < 0.2 || probability > 0.8)) {
        reject("extreme-single-leg-proxy"); continue;
      }
      if (entryPrice === null || !Number.isFinite(entryPrice) || entryPrice <= 0 || entryPrice >= 1) {
        reject("unavailable-ask"); continue;
      }
      if (spread === null || spread > (request.maxSpread ?? 0.15) + 1e-12) {
        reject(spread === null ? "unknown-spread" : "wide-spread"); continue;
      }
      selections.push({
        ...market,
        id: `${market.id}:${side}`,
        marketId: market.id,
        side,
        selection: side === "yes" ? market.selection : market.noSelection,
        probability,
        probabilityMethod: estimate.method,
        entryPrice,
        spread,
        eventGroup: group,
        reason: `${(probability * 100).toFixed(1)}% market-implied marginal; ${(entryPrice * 100).toFixed(1)}¢ standalone ask.`,
      });
    }
    if (!selections.length) continue;
    eligibleMarkets++;
    candidateSelections += selections.length;
    groups.set(group, [...(groups.get(group) ?? []), ...selections]);
  }

  const warnings = [...catalog.warnings];
  warnings.push("No calibrated sports model is connected. Probabilities are normalized market prices, not independent forecasts.");
  warnings.push("Reference payout multiplies standalone asks only. It is not an executable combo price or an expected-value estimate.");
  if (payoutFloor > 1) warnings.push("The screen excludes standalone legs outside a 20%–80% market-implied range to avoid lottery legs and near-certain fillers.");
  const availableLegs = Math.min(10, groups.size);
  const result: ComboResult = {
    combos: [],
    warnings,
    diagnostics: {
      inputMarkets: catalog.markets.length, eligibleMarkets, candidateSelections,
      independentEventGroups: groups.size, requestedLegs: request.legs, availableLegs,
      algorithm: "payout-bucket-dynamic-programming", ranking: "payout-constrained-market-proxy",
      modelStatus: "unavailable", rejected,
    },
  };
  if (groups.size < request.legs) {
    warnings.push(`Only ${groups.size} eligible distinct events are available for ${request.legs} requested legs. Expand sports, dates, games, or filters.`);
    return result;
  }
  if (request.requireEachSport && selectedSports.length > request.legs) {
    warnings.push("There are more required sports than legs. Increase the leg count or select fewer sports.");
    return result;
  }
  if (request.anchorGameId && !groups.has(`game:${request.anchorGameId}`)) {
    warnings.push("No eligible current contract is matched to the selected game.");
    return result;
  }

  let states = new Map<string, PartialCombo[]>([["0:0:0", [{ legs: [], logProbability: 0, logReferencePayout: 0, sportsMask: 0, hasAnchor: false, key: "" }]]]);
  for (const [groupId, selections] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const next = new Map<string, PartialCombo[]>();
    const put = (stateKey: string, path: PartialCombo) => next.set(stateKey, [...(next.get(stateKey) ?? []), path]);
    const eventOptions = new Map<string, ComboLeg[]>();
    for (const selection of selections) {
      const bucket = `${selection.sport}:${Math.floor(-Math.log(selection.entryPrice!) / 0.15)}`;
      eventOptions.set(bucket, [...(eventOptions.get(bucket) ?? []), selection]);
    }
    const candidates = [...eventOptions.values()].flatMap((legs) =>
      legs.sort((a, b) => b.probability - a.probability || a.id.localeCompare(b.id)).slice(0, 3));
    for (const paths of states.values()) {
      for (const path of paths) {
        put(`${path.legs.length}:${path.sportsMask}:${Number(path.hasAnchor)}`, path);
        if (path.legs.length >= request.legs) continue;
        for (const leg of candidates) {
          if ((leg.teams ?? []).some((team) => path.legs.some((previous) =>
            (previous.teams ?? []).some((priorTeam) => teamKey(previous.sport, priorTeam) === teamKey(leg.sport, team))))) continue;
          const sportsMask = request.requireEachSport
            ? path.sportsMask | (1 << selectedSports.indexOf(leg.sport)) : 0;
          const hasAnchor = path.hasAnchor || leg.gameId === request.anchorGameId;
          const key = path.key ? `${path.key}|${groupId}/${leg.id}` : `${groupId}/${leg.id}`;
          put(`${path.legs.length + 1}:${sportsMask}:${Number(hasAnchor)}`, {
            legs: [...path.legs, leg], logProbability: path.logProbability + Math.log(leg.probability),
            logReferencePayout: path.logReferencePayout - Math.log(leg.entryPrice!), sportsMask, hasAnchor, key,
          });
        }
      }
    }
    for (const [stateKey, paths] of next) next.set(stateKey, keepBest(paths));
    states = next;
  }
  const fullMask = request.requireEachSport ? (1 << selectedSports.length) - 1 : 0;
  const finalists = states.get(`${request.legs}:${fullMask}:${Number(Boolean(request.anchorGameId))}`) ?? [];
  const eligible = finalists.filter((path) => path.logReferencePayout + 1e-12 >= Math.log(payoutFloor))
    .sort((a, b) => b.logProbability - a.logProbability || a.logReferencePayout - b.logReferencePayout);
  const winners: PartialCombo[] = [];
  for (const path of eligible) {
    if (winners.some((previous) => path.legs.filter((leg) => previous.legs.some((other) => other.eventGroup === leg.eventGroup)).length > Math.floor(request.legs / 2))) continue;
    winners.push(path);
    if (winners.length === limit) break;
  }
  if (!winners.length) warnings.push(finalists.length ? `No combination reaches the ${payoutFloor}x standalone-ask reference payout with the selected filters.` : "No combination satisfies all selected sports and game constraints.");
  result.combos = winners.map((path, index) => {
    const marginals = path.legs.map((leg) => leg.probability);
    const bounds = frechetBounds(marginals);
    const teamCounts = new Map<string, { label: string; count: number }>();
    for (const leg of path.legs) {
      for (const team of new Set(leg.teams ?? [])) {
        const key = teamKey(leg.sport, team);
        const previous = teamCounts.get(key);
        teamCounts.set(key, { label: team, count: (previous?.count ?? 0) + 1 });
      }
    }
    const repeatedTeams = [...teamCounts.values()].filter(({ count }) => count > 1).map(({ label }) => label);
    const comboWarnings = [
      "This is a research combination. No executable venue combo or RFQ price has been obtained.",
      "Dependence bounds assume the market-implied marginals are correct; they do not measure model calibration or forecast error.",
    ];
    if (repeatedTeams.length) comboWarnings.push(`Repeated teams across games: ${repeatedTeams.join(", ")}. Shared form, injuries, and scheduling can invalidate independence.`);
    if (path.legs.some((leg) => leg.matching !== "schedule-verified")) comboWarnings.push("Some events are identified only by the venue; schedule matching has not been independently verified.");
    const exceptional = [...new Set(path.legs.map((leg) => leg.settlement.exceptionalSettlement).filter(Boolean))];
    if (exceptional.length) comboWarnings.push(...exceptional as string[]);
    return {
      id: `combo-${index + 1}-${path.legs.map((leg) => leg.id).join("_")}`,
      rank: index + 1,
      legs: path.legs.sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.id.localeCompare(b.id)),
      probability: Math.exp(path.logProbability),
      probabilityBasis: "market-implied-independent",
      ...bounds,
      assumptions: [
        "Distinct events are assumed independent for ranking. Actual dependence is unknown.",
        "At most one leg from each verified scheduled game is allowed; same-game correlation is not estimated.",
        "Selected sports form the search pool. A sport appears only when its selection improves the probability proxy, unless sport coverage is required.",
      ],
      warnings: comboWarnings,
      hypothetical: true,
      executableQuote: null,
      stake: request.stake ?? 10,
      estimatedReturn: null,
      modelStatus: "unavailable",
      independentEvents: path.legs.length,
      repeatedTeams,
      referenceGrossMultiplier: Math.exp(path.logReferencePayout),
      referenceBreakEven: Math.exp(-path.logReferencePayout),
    };
  });
  return result;
}
