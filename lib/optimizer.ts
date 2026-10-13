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
  anchorGameId?: string;
  requireEachSport?: boolean;
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
    algorithm: "exact-k-best-dynamic-programming";
    ranking: "winning-probability";
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

interface PartialCombo {
  legs: ComboLeg[];
  logProbability: number;
  sportsMask: number;
  hasAnchor: boolean;
  key: string;
}

function keepBest(options: PartialCombo[], count: number): PartialCombo[] {
  options.sort((a, b) => b.logProbability - a.logProbability || a.key.localeCompare(b.key));
  const seen = new Set<string>();
  return options.filter((option) => {
    if (seen.has(option.key)) return false;
    seen.add(option.key);
    return true;
  }).slice(0, count);
}

/**
 * Exact k-best grouped dynamic programming. Each group contributes zero or one selection;
 * retaining k paths per (count, sport mask) is exact because all share the same future choices.
 * This optimizes the explicitly declared independence proxy, not unknown true joint probability.
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
        reason: `${(probability * 100).toFixed(1)}% market-implied marginal; ranked solely by the probability proxy.`,
      });
    }
    if (!selections.length) continue;
    eligibleMarkets++;
    candidateSelections += selections.length;
    groups.set(group, [...(groups.get(group) ?? []), ...selections]);
  }

  const warnings = [...catalog.warnings];
  warnings.push("No calibrated sports model is connected. Probabilities are normalized market prices, not independent forecasts.");
  const availableLegs = Math.min(10, groups.size);
  const result: ComboResult = {
    combos: [],
    warnings,
    diagnostics: {
      inputMarkets: catalog.markets.length, eligibleMarkets, candidateSelections,
      independentEventGroups: groups.size, requestedLegs: request.legs, availableLegs,
      algorithm: "exact-k-best-dynamic-programming", ranking: "winning-probability",
      modelStatus: "unavailable", rejected,
    },
  };
  // Prefer a smaller valid combo to returning no result when the feed has fewer
  // eligible games than requested. The warning keeps the adjustment explicit.
  const targetLegs = Math.min(request.legs, groups.size);
  if (groups.size < request.legs) {
    warnings.push(groups.size
      ? `Only ${groups.size} eligible distinct events are available for ${request.legs} requested legs. Showing the best ${targetLegs}-leg combo available; expand sports, dates, or games for more legs.`
      : `No eligible games are available for the current sport, date, venue, and market settings. Expand the search or try another venue.`);
  }
  if (targetLegs === 0) return result;
  if (request.requireEachSport && selectedSports.length > targetLegs) {
    warnings.push(`There are more required sports than the ${targetLegs} available legs. Select fewer sports or broaden the search.`);
    return result;
  }
  let states = new Map<string, PartialCombo[]>([["0:0:0", [{ legs: [], logProbability: 0, sportsMask: 0, hasAnchor: false, key: "" }]]]);
  for (const [groupId, selections] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const next = new Map<string, PartialCombo[]>();
    const put = (stateKey: string, path: PartialCombo) => next.set(stateKey, [...(next.get(stateKey) ?? []), path]);
    // At most k choices per sport are needed from one event: lower choices cannot enter top k.
    const eventOptions = new Map<Sport, ComboLeg[]>();
    for (const selection of selections) eventOptions.set(selection.sport, [...(eventOptions.get(selection.sport) ?? []), selection]);
    const candidates = [...eventOptions.values()].flatMap((legs) =>
      legs.sort((a, b) => b.probability - a.probability || a.id.localeCompare(b.id)).slice(0, limit));
    for (const paths of states.values()) {
      for (const path of paths) {
        put(`${path.legs.length}:${path.sportsMask}:${Number(path.hasAnchor)}`, path);
        if (path.legs.length >= targetLegs) continue;
        for (const leg of candidates) {
          const sportsMask = request.requireEachSport
            ? path.sportsMask | (1 << selectedSports.indexOf(leg.sport)) : 0;
          const hasAnchor = path.hasAnchor || leg.gameId === request.anchorGameId;
          const key = path.key ? `${path.key}|${groupId}/${leg.id}` : `${groupId}/${leg.id}`;
          put(`${path.legs.length + 1}:${sportsMask}:${Number(hasAnchor)}`, {
            legs: [...path.legs, leg], logProbability: path.logProbability + Math.log(leg.probability), sportsMask, hasAnchor, key,
          });
        }
      }
    }
    for (const [stateKey, paths] of next) next.set(stateKey, keepBest(paths, limit));
    states = next;
  }
  const fullMask = request.requireEachSport ? (1 << selectedSports.length) - 1 : 0;
  const winners = states.get(`${targetLegs}:${fullMask}:${Number(Boolean(request.anchorGameId))}`) ?? [];
  if (!winners.length) warnings.push("No combination satisfies all of the selected sports and event constraints.");
  result.combos = winners.map((path, index) => {
    const marginals = path.legs.map((leg) => leg.probability);
    const bounds = frechetBounds(marginals);
    const teamCounts = new Map<string, { label: string; count: number }>();
    for (const leg of path.legs) {
      for (const team of new Set(leg.teams ?? [])) {
        const key = `${leg.sport}:${team.toLowerCase().replace(/[^a-z0-9]/g, "")}`;
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
    };
  });
  return result;
}
