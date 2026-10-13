export const SPORTS = ["MLB", "NFL", "NCAAF", "NBA", "NCAAB"] as const;
export type Sport = (typeof SPORTS)[number];
export type Venue = "kalshi" | "polymarket-us" | "polymarket-global";
export type MarketCategory = "moneyline" | "spread" | "total" | "team-total" | "player-prop" | "period" | "other";

export interface Team {
  id: string;
  name: string;
  abbreviation: string;
  aliases: string[];
}

export interface Game {
  id: string;
  sport: Sport;
  title: string;
  startsAt: string;
  status: "scheduled" | "live" | "final" | "postponed" | "unknown";
  home: Team;
  away: Team;
  source: "mlb" | "espn";
  url: string;
  fetchedAt: string;
}

export interface Market {
  id: string;
  eventId: string;
  gameId?: string;
  venue: Venue;
  sport: Sport;
  title: string;
  selection: string;
  noSelection: string;
  category: MarketCategory;
  startsAt: string;
  startsAtSource: "schedule" | "venue" | "venue-ticker";
  yesBid: number | null;
  yesAsk: number | null;
  noBid: number | null;
  noAsk: number | null;
  volume: number | null;
  liquidity: number | null;
  updatedAt: string | null;
  fetchedAt: string;
  url: string;
  probability?: number;
  probabilityBasis: "market-implied" | "unavailable";
  probabilityMethod?: string;
  status: "open" | "closed" | "settled";
  settlement: {
    type: "binary" | "unknown";
    rules: string;
    verified: boolean;
    exceptionalSettlement?: string;
  };
  matching: "schedule-verified" | "venue-event-only";
  teams?: string[];
  providerEventTitle?: string;
}

export type MarketCandidate = Market;

export interface SourceStatus {
  id: Venue | "mlb" | "espn";
  name: string;
  status: "connected" | "partial" | "unavailable";
  fetchedAt: string;
  count: number;
  message: string;
  cached: boolean;
  latencyMs: number;
  rateLimit: string;
  documentationUrl: string;
  error?: string;
}

export interface Catalog {
  markets: Market[];
  games: Game[];
  sources: SourceStatus[];
  fetchedAt: string;
  warnings: string[];
}

export interface CatalogQuery {
  sports: Sport[];
  start: string;
  end: string;
  venue: Venue | "all";
}
