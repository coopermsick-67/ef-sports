import { SPORTS, type Catalog, type CatalogQuery, type Game, type Market, type MarketCategory, type SourceStatus, type Sport, type Team, type Venue } from "./types";

type Json = Record<string, unknown>;
const object = (value: unknown): Json => value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
const list = (value: unknown): Json[] => Array.isArray(value) ? value.map(object) : [];
const string = (value: unknown) => typeof value === "string" ? value : value == null ? "" : String(value);
const number = (value: unknown): number | null => value == null || value === "" || !Number.isFinite(Number(value)) ? null : Number(value);
const price = (value: unknown): number | null => {
  const n = number(value);
  return n !== null && n >= 0 && n <= 1 ? n : null;
};
const iso = (value: unknown): string | null => {
  const v = string(value);
  return v && Number.isFinite(Date.parse(v)) && new Date(v).getUTCFullYear() > 2000 ? new Date(v).toISOString() : null;
};

type Snapshot = { data: unknown; cached: boolean; fetchedAt: string };
const cache = new Map<string, { data: unknown; expiresAt: number; fetchedAt: string }>();
const pending = new Map<string, Promise<Snapshot>>();
const cooldown = new Map<string, number>();
const nextRequest = new Map<string, number>();

async function pace(host: string) {
  if (!host.includes("kalshi") && !host.includes("polymarket")) return;
  const now = Date.now();
  const slot = Math.max(now, nextRequest.get(host) ?? now);
  nextRequest.set(host, slot + 250);
  if (slot > now) await new Promise<void>(resolve => setTimeout(resolve, slot - now));
  if ((cooldown.get(host) ?? 0) > Date.now()) throw new Error(`${host}: paused after HTTP 429; retry after the provider cooldown.`);
}

/** Read-only public JSON requests. No venue credential or trading endpoint is used. */
async function json(url: string, ttl = 60_000): Promise<Snapshot> {
  const previous = cache.get(url);
  if (previous && previous.expiresAt > Date.now()) return { data: previous.data, cached: true, fetchedAt: previous.fetchedAt };
  const underway = pending.get(url);
  if (underway) return underway;
  const host = new URL(url).host;
  if ((cooldown.get(host) ?? 0) > Date.now()) throw new Error(`${host}: paused after HTTP 429; retry after the provider cooldown.`);
  const task = (async () => {
    await pace(host);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(url, { headers: { Accept: "application/json" }, signal: controller.signal });
      if (response.status === 429) {
        const seconds = Math.min(120, Math.max(2, Number(response.headers.get("retry-after")) || 30));
        cooldown.set(host, Date.now() + seconds * 1_000);
      }
      if (!response.ok) throw new Error(`${host}: HTTP ${response.status}${response.status === 429 ? " (rate limited)" : ""}`);
      const data: unknown = await response.json();
      const fetchedAt = new Date().toISOString();
      cache.set(url, { data, expiresAt: Date.now() + ttl, fetchedAt });
      // Bound long-running worker memory; old snapshots are never substituted for failed requests.
      if (cache.size > 512) for (const [key, value] of cache) if (value.expiresAt <= Date.now()) cache.delete(key);
      return { data, cached: false, fetchedAt };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw new Error(`${host}: request exceeded 10-second timeout.`);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  })();
  pending.set(url, task);
  try { return await task; } finally { pending.delete(url); }
}

async function pooled<T, R>(items: T[], work: (item: T) => Promise<R>, concurrency = 4): Promise<PromiseSettledResult<R>[]> {
  const output: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      try { output[index] = { status: "fulfilled", value: await work(items[index]) }; }
      catch (reason) { output[index] = { status: "rejected", reason }; }
    }
  }));
  return output;
}

export function newYorkDate(date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const part = (type: string) => parts.find(p => p.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

/** Convert a New York wall clock to UTC, including the date's DST offset. */
export function newYorkInstant(day: string, hour = 0, minute = 0): string {
  const [year, month, date] = day.split("-").map(Number);
  const target = Date.UTC(year, month - 1, date, hour, minute);
  let guess = target;
  for (let i = 0; i < 3; i++) {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(new Date(guess));
    const get = (name: string) => Number(parts.find(p => p.type === name)?.value ?? 0);
    const wall = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
    guess += target - wall;
  }
  return new Date(guess).toISOString();
}

function days(start: string, end: string): string[] {
  const output: string[] = [];
  for (let date = Date.parse(`${start}T12:00:00Z`); date <= Date.parse(`${end}T12:00:00Z`); date += 86_400_000) output.push(new Date(date).toISOString().slice(0, 10));
  return output;
}

function shiftDate(day: string, offset: number): string {
  return new Date(Date.parse(`${day}T12:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10);
}

function inDateWindow(startsAt: string, query: CatalogQuery): boolean {
  const day = newYorkDate(new Date(startsAt));
  return day >= query.start && day <= query.end;
}

export function parseCatalogQuery(search: URLSearchParams): CatalogQuery {
  const sports = [...new Set((search.get("sports") || "MLB,NFL,NBA,NCAAF,NCAAB").split(",").map(v => v.trim().toUpperCase()))];
  if (sports.length === 0 || sports.some(s => !SPORTS.includes(s as Sport))) throw new Error(`Choose sports from ${SPORTS.join(", ")}.`);
  const start = search.get("start") || newYorkDate();
  const end = search.get("end") || start;
  for (const value of [start, end]) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(`${value}T12:00:00Z`)) || new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) !== value) throw new Error("Dates must be valid YYYY-MM-DD values.");
  }
  const length = (Date.parse(end) - Date.parse(start)) / 86_400_000;
  if (length < 0 || length > 30) throw new Error("Select an inclusive date range of 1 to 31 days.");
  const venue = search.get("venue") || "kalshi";
  if (!["kalshi", "polymarket-us", "polymarket-global", "all"].includes(venue)) throw new Error("Unknown venue.");
  return { sports: sports as Sport[], start, end, venue: venue as CatalogQuery["venue"] };
}

const normalized = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
function team(raw: Json, source: string): Team {
  const name = string(raw.displayName || raw.name);
  const aliases = [name, raw.abbreviation, raw.locationName, raw.location, raw.shortName, raw.shortDisplayName, raw.teamName, raw.clubName].map(string).filter(Boolean);
  return { id: `${source}:${string(raw.id)}`, name, abbreviation: string(raw.abbreviation), aliases: [...new Set(aliases)] };
}

/** Require both teams, the local date, and a unique schedule match; ambiguous games remain unmapped. */
export function matchGame(marketsText: string, sport: Sport, startsAt: string, games: Game[], exactTime = true): Game | undefined {
  const text = ` ${normalized(marketsText)} `;
  const day = newYorkDate(new Date(startsAt));
  const matches = games.filter(g => g.sport === sport && newYorkDate(new Date(g.startsAt)) === day && [g.home, g.away].every(t => t.aliases.some(alias => {
    const a = normalized(alias);
    return a.length >= 3 && text.includes(` ${a} `);
  })));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1 && exactTime) {
    const close = matches.filter(g => Math.abs(Date.parse(g.startsAt) - Date.parse(startsAt)) <= 30 * 60_000);
    if (close.length === 1) return close[0];
  }
  return undefined;
}

function withGame(market: Market, text: string, games: Game[]): Market {
  const exactTime = market.startsAtSource !== "venue-ticker" || /-\d{2}[A-Z]{3}\d{6}/.test(market.eventId);
  const game = matchGame(text, market.sport, market.startsAt, games, exactTime);
  return game ? { ...market, gameId: game.id, startsAt: game.startsAt, startsAtSource: "schedule", matching: "schedule-verified", teams: [game.away.name, game.home.name], providerEventTitle: market.providerEventTitle || game.title } : market;
}

function implied(yesBid: number | null, yesAsk: number | null, noBid: number | null, noAsk: number | null): Pick<Market, "probability" | "probabilityBasis" | "probabilityMethod"> {
  if (yesBid == null || yesAsk == null || noBid == null || noAsk == null || yesBid <= 0 || noBid <= 0 || yesBid > yesAsk || noBid > noAsk || yesAsk >= 1 || noAsk >= 1) return { probabilityBasis: "unavailable" };
  const yes = (yesBid + yesAsk) / 2;
  const no = (noBid + noAsk) / 2;
  return { probability: yes / (yes + no), probabilityBasis: "market-implied", probabilityMethod: "normalized-binary-midpoints" };
}

function category(value: string): MarketCategory {
  const text = value.toLowerCase();
  if (/team.?total/.test(text)) return "team-total";
  if (/spread|run.?line/.test(text)) return "spread";
  if (/total|over.?under/.test(text)) return "total";
  if (/1h|2h|[1-4]q|half|quarter|inning|period/.test(text)) return "period";
  if (/moneyline|game$|winner/.test(text)) return "moneyline";
  if (/player|prop|passyds|rshyds|recyds|rec$|pts$|reb$|ast$|3pt$|ks$|hits$|hr$|so$|td$/.test(text)) return "player-prop";
  return "other";
}

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
function source(id: SourceStatus["id"], started: number, count: number, errors: string[], cached: boolean, message: string): SourceStatus {
  const info: Record<SourceStatus["id"], [string, string, string]> = {
    kalshi: ["Kalshi", "Token-based limits by account tier; adapter capped at 4 requests/second per warm worker, 60-second quote cache; stops on 429.", "https://docs.kalshi.com/api-reference/market/get-markets"],
    "polymarket-us": ["Polymarket US", "Public gateway; capped at 4 requests/second per warm worker, 60-second quote cache. HTTP 429 cooldown respected.", "https://docs.polymarket.us/api-reference/introduction"],
    "polymarket-global": ["Polymarket Global", "Gamma read-only API; bounded pagination, capped at 4 requests/second per warm worker, 60-second cache; stops on 429.", "https://docs.polymarket.com/market-data/discover-markets"],
    mlb: ["MLB Stats", "Public schedule feed. No guaranteed published SLA or numeric limit; 5-minute cache.", "https://statsapi.mlb.com/api/v1/schedule"],
    espn: ["ESPN schedules", "Public scoreboard feed; undocumented API, no guaranteed SLA. Concurrency 4; 5-minute cache.", "https://www.espn.com/"],
  };
  return { id, name: info[id][0], status: errors.length ? count ? "partial" : "unavailable" : "connected", fetchedAt: new Date().toISOString(), count, message, cached, latencyMs: Date.now() - started, rateLimit: info[id][1], documentationUrl: info[id][2], ...(errors.length ? { error: [...new Set(errors)].slice(0, 3).join("; ") } : {}) };
}

async function schedules(query: CatalogQuery): Promise<{ games: Game[]; sources: SourceStatus[]; warnings: string[] }> {
  const started = Date.now();
  const games: Game[] = [];
  const sources: SourceStatus[] = [];
  const warnings: string[] = [];
  if (query.sports.includes("MLB")) {
    try {
      // Provider calendar dates may use a different zone from the user's New York
      // date. Fetch adjacent days, then keep only actual starts inside their range.
      const response = await json(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&startDate=${shiftDate(query.start, -1)}&endDate=${shiftDate(query.end, 1)}&hydrate=team`, 300_000);
      for (const date of list(object(response.data).dates)) for (const raw of list(date.games)) {
        const sides = object(raw.teams);
        const state = string(object(raw.status).abstractGameState);
        const detail = string(object(raw.status).detailedState);
        const startsAt = iso(raw.gameDate);
        if (!startsAt || !inDateWindow(startsAt, query)) continue;
        const away = team(object(object(sides.away).team), "mlb");
        const home = team(object(object(sides.home).team), "mlb");
        games.push({ id: `mlb:${string(raw.gamePk)}`, sport: "MLB", title: `${away.name} at ${home.name}`, startsAt, status: /postpon|cancel/i.test(detail) ? "postponed" : state === "Final" ? "final" : state === "Live" ? "live" : "scheduled", away, home, source: "mlb", url: `https://www.mlb.com/gameday/${string(raw.gamePk)}`, fetchedAt: response.fetchedAt });
      }
      sources.push(source("mlb", started, games.length, [], response.cached, "Official MLB schedules and team identities."));
    } catch (error) {
      const message = errorText(error);
      sources.push(source("mlb", started, 0, [message], false, "MLB schedules could not be refreshed."));
      warnings.push(message);
    }
  }
  const other = query.sports.filter(s => s !== "MLB");
  if (other.length) {
    const paths: Partial<Record<Sport, string>> = { NFL: "football/nfl", NCAAF: "football/college-football", NBA: "basketball/nba", NCAAB: "basketball/mens-college-basketball" };
    const jobs = other.flatMap(sport => days(shiftDate(query.start, -1), shiftDate(query.end, 1)).map(day => ({ sport, day })));
    const results = await pooled(jobs, async ({ sport, day }) => {
      const group = sport === "NCAAF" ? "&groups=80" : sport === "NCAAB" ? "&groups=50" : "";
      const response = await json(`https://site.api.espn.com/apis/site/v2/sports/${paths[sport]}/scoreboard?dates=${day.replaceAll("-", "")}&limit=1000${group}`, 300_000);
      const found: Game[] = [];
      for (const event of list(object(response.data).events)) {
        const competition = list(event.competitions)[0] ?? {};
        const competitors = list(competition.competitors);
        const homeRaw = object(competitors.find(c => c.homeAway === "home")?.team);
        const awayRaw = object(competitors.find(c => c.homeAway === "away")?.team);
        const startsAt = iso(event.date);
        if (!startsAt || !inDateWindow(startsAt, query) || !homeRaw.id || !awayRaw.id) continue;
        const home = team(homeRaw, `espn:${sport}`);
        const away = team(awayRaw, `espn:${sport}`);
        const status = object(object(event.status).type);
        found.push({ id: `espn:${sport}:${string(event.id)}`, sport, title: string(event.name) || `${away.name} at ${home.name}`, startsAt, status: status.completed ? "final" : status.state === "in" ? "live" : /postpon|cancel/i.test(string(status.name)) ? "postponed" : status.state === "pre" ? "scheduled" : "unknown", home, away, source: "espn", url: string(list(event.links)[0]?.href) || `https://www.espn.com/${paths[sport]?.split("/")[1]}/game/_/gameId/${string(event.id)}`, fetchedAt: response.fetchedAt });
      }
      return { games: found, cached: response.cached };
    });
    const errors = results.filter(r => r.status === "rejected").map(r => errorText((r as PromiseRejectedResult).reason));
    const found = results.flatMap(r => r.status === "fulfilled" ? r.value.games : []);
    games.push(...found);
    sources.push(source("espn", started, new Set(found.map(g => g.id)).size, errors, results.every(r => r.status === "fulfilled" && r.value.cached), "Public ESPN scoreboard schedules; availability varies by league and season."));
    if (errors.length) warnings.push("Some ESPN schedule requests failed. Uniquely verified game matching may be unavailable.");
  }
  return { games: [...new Map(games.filter(g => { const d = newYorkDate(new Date(g.startsAt)); return d >= query.start && d <= query.end; }).map(g => [g.id, g])).values()], sources, warnings };
}

const MONTHS: Record<string, string> = { JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06", JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12" };
function kalshiStart(ticker: string): string | null {
  const match = ticker.match(/-(\d{2})([A-Z]{3})(\d{2})(?:(\d{2})(\d{2}))?/);
  if (!match || !MONTHS[match[2]]) return null;
  return newYorkInstant(`20${match[1]}-${MONTHS[match[2]]}-${match[3]}`, match[4] ? Number(match[4]) : 12, match[5] ? Number(match[5]) : 0);
}

async function kalshi(query: CatalogQuery, games: Game[]) {
  const started = Date.now();
  const errors: string[] = [];
  const warnings: string[] = [];
  const markets: Market[] = [];
  let missingStartTime = 0;
  let allCached = true;
  try {
    const response = await json("https://api.elections.kalshi.com/trade-api/v2/series?category=Sports", 3_600_000);
    allCached = response.cached;
    const suffixes = ["GAME", "SPREAD", "TOTAL", "TEAMTOTAL", "PTS", "REB", "AST", "3PT", "PASSYDS", "RSHYDS", "RECYDS", "REC", "TD", "KS", "SO", "HITS", "HR", "1HWINNER", "1HTOTAL", "1HSPREAD", "F5TOTAL", "F5SPREAD", "F5GAME"];
    const series = list(object(response.data).series).flatMap(raw => {
      const ticker = string(raw.ticker);
      const sport = query.sports.find(s => ticker.startsWith(`KX${s}`));
      if (!sport) return [];
      const suffix = ticker.slice(`KX${sport}`.length);
      return suffixes.includes(suffix) ? [{ ticker, sport, priority: suffixes.indexOf(suffix) }] : [];
    }).sort((a, b) => a.priority - b.priority);
    const selected = query.sports.flatMap(sport => series.filter(s => s.sport === sport).slice(0, 14));
    if (selected.length < series.length) warnings.push("Kalshi discovery is bounded to 14 supported series per sport; other specialized series are not included.");
    const from = Math.floor(Date.parse(newYorkInstant(query.start)) / 1_000);
    const dayAfterEnd = new Date(Date.parse(`${query.end}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    const to = Math.floor(Date.parse(newYorkInstant(dayAfterEnd)) / 1_000) + 3 * 86_400;
    const results = await pooled(selected, async item => {
      const found: Market[] = [];
      let cursor = "";
      for (let page = 0; page < 2; page++) {
        const url = `https://api.elections.kalshi.com/trade-api/v2/markets?status=open&limit=1000&series_ticker=${item.ticker}&min_close_ts=${from}&max_close_ts=${to}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
        const response = await json(url);
        allCached &&= response.cached;
        const body = object(response.data);
        for (const raw of list(body.markets)) {
          if (!["active", "open"].includes(string(raw.status)) || raw.mve_collection_ticker) continue;
          const eventId = string(raw.event_ticker);
          const startsAt = kalshiStart(eventId);
          if (!startsAt) continue;
          const day = newYorkDate(new Date(startsAt));
          if (day < query.start || day > query.end) continue;
          const yesBid = raw.yes_bid_dollars != null ? price(raw.yes_bid_dollars) : price((number(raw.yes_bid) ?? -100) / 100);
          const yesAsk = raw.yes_ask_dollars != null ? price(raw.yes_ask_dollars) : price((number(raw.yes_ask) ?? -100) / 100);
          const noBid = raw.no_bid_dollars != null ? price(raw.no_bid_dollars) : price((number(raw.no_bid) ?? -100) / 100);
          const noAsk = raw.no_ask_dollars != null ? price(raw.no_ask_dollars) : price((number(raw.no_ask) ?? -100) / 100);
          const rules = [raw.rules_primary, raw.rules_secondary].map(string).filter(Boolean).join("\n\n");
          const selection = string(raw.yes_sub_title) || string(raw.title);
          const candidate: Market = {
            id: string(raw.ticker), eventId, venue: "kalshi", sport: item.sport, title: string(raw.title), selection,
            noSelection: string(raw.no_sub_title) && raw.no_sub_title !== raw.yes_sub_title ? string(raw.no_sub_title) : `No — ${selection}`,
            category: category(item.ticker), startsAt, startsAtSource: "venue-ticker", yesBid, yesAsk, noBid, noAsk,
            volume: number(raw.volume_fp ?? raw.volume), liquidity: null, updatedAt: iso(raw.updated_time), fetchedAt: response.fetchedAt,
            url: `https://kalshi.com/markets/${item.ticker.toLowerCase()}/${eventId.toLowerCase()}`, ...implied(yesBid, yesAsk, noBid, noAsk), status: "open",
            settlement: { type: raw.market_type === "binary" ? "binary" : "unknown", verified: raw.market_type === "binary" && !!string(raw.rules_primary), rules, exceptionalSettlement: /tie|fair price|cancel|postpon/i.test(rules) ? "Published rules allow exceptional settlement for cancellation, postponement, or ties; inspect the contract rules." : undefined },
            matching: "venue-event-only",
          };
          const matched = withGame(candidate, `${raw.title} ${rules}`, games);
          // A date-only event ticker supplies the day, not a kickoff time. Noon is used
          // internally for date matching, but never presented as an invented start time.
          if (!matched.gameId && !/-\d{2}[A-Z]{3}\d{6}/.test(eventId)) { missingStartTime++; continue; }
          found.push(matched);
        }
        cursor = string(body.cursor);
        if (!cursor) break;
        if (page === 1) warnings.push(`${item.ticker}: market pagination capped at 2,000 contracts; catalog may be incomplete.`);
      }
      return found;
    });
    for (const result of results) {
      if (result.status === "fulfilled") markets.push(...result.value);
      else errors.push(errorText(result.reason));
    }
  } catch (error) { errors.push(errorText(error)); }
  if (missingStartTime) warnings.push(`${missingStartTime} Kalshi contracts excluded because a game start time could not be verified from the schedule or venue ticker.`);
  const mapped = markets.filter(m => m.gameId).length;
  const status = source("kalshi", started, markets.length, errors, allCached, `${markets.length} active contracts; ${mapped} matched uniquely to source schedules. Quotes are individual contracts, not combo RFQs.`);
  if (warnings.length && status.status === "connected") status.status = "partial";
  return { markets, source: status, warnings: [...warnings, ...(errors.length ? ["Some Kalshi market requests failed; results may be incomplete."] : [])] };
}

function usSide(raw: Json, fallback: string): string {
  const description = string(raw.description);
  const name = string(object(raw.team).name);
  if (name && description && !description.toLowerCase().includes(name.toLowerCase()) && !/^(yes|no)$/i.test(description)) return `${name} ${description}`;
  return description && !/^(yes|no)$/i.test(description) ? description : name || fallback;
}

async function polymarketUS(query: CatalogQuery, games: Game[]) {
  const started = Date.now();
  const slugs: Record<Sport, string> = { MLB: "mlb", NFL: "nfl", NBA: "nba", NCAAF: "cfb", NCAAB: "cbb" };
  const markets: Market[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];
  let allCached = true;
  const results = await pooled(query.sports, async sport => {
    const found: Market[] = [];
    for (let page = 0; page < 3; page++) {
      const response = await json(`https://gateway.polymarket.us/v2/leagues/${slugs[sport]}/events?type=sport&limit=50&offset=${page * 50}`);
      allCached &&= response.cached;
      const events = list(object(response.data).events);
      for (const event of events) {
        const startsAt = iso(event.startTime || event.startDate);
        if (!startsAt || event.closed === true || event.archived === true) continue;
        const day = newYorkDate(new Date(startsAt));
        if (day < query.start || day > query.end) continue;
        for (const raw of list(event.markets)) {
          if (raw.closed === true || raw.active !== true || raw.status !== "MARKET_STATUS_OPEN") continue;
          const sides = list(raw.marketSides);
          const yesSide = sides.find(s => s.long === true);
          const noSide = sides.find(s => s.long === false);
          if (!yesSide || !noSide || yesSide.tradable === false || noSide.tradable === false) continue;
          const yesBid = price(object(raw.bestBidQuote).value);
          const yesAsk = price(object(raw.bestAskQuote).value);
          // A short position in the same $1 instrument is the complementary NO contract.
          const noBid = yesAsk == null ? null : Number((1 - yesAsk).toFixed(6));
          const noAsk = yesBid == null ? null : Number((1 - yesBid).toFixed(6));
          const rules = string(raw.description);
          const candidate: Market = {
            id: string(raw.slug || raw.id), eventId: string(event.slug || event.id), venue: "polymarket-us", sport,
            title: string(raw.question || raw.title), selection: usSide(yesSide, "Yes"), noSelection: usSide(noSide, "No"),
            category: category(string(raw.marketType || raw.sportsMarketTypeV2 || raw.sportsMarketType)), startsAt, startsAtSource: "venue", yesBid, yesAsk, noBid, noAsk,
            volume: number(raw.volume), liquidity: null, updatedAt: iso(raw.updatedAt), fetchedAt: response.fetchedAt, url: `https://polymarket.us/event/${string(event.slug)}`,
            ...implied(yesBid, yesAsk, noBid, noAsk), status: "open", settlement: { type: "binary", verified: !!rules && sides.every(s => s.marketSideType === "MARKET_SIDE_TYPE_INSTRUMENT"), rules, exceptionalSettlement: /fair market|fair price|cancel|postpon|tie/i.test(rules) ? "The instrument may settle at fair market prices when games are cancelled or delayed; inspect the published rules." : undefined },
            matching: "venue-event-only", teams: [...new Set(sides.map(s => string(object(s.team).name)).filter(Boolean))], providerEventTitle: string(event.title),
          };
          found.push(withGame(candidate, `${event.title} ${raw.question} ${rules} ${candidate.teams?.join(" ")}`, games));
        }
      }
      if (events.length < 50) break;
      if (page === 2) warnings.push(`${sport}: Polymarket US pagination capped at 150 events; results may be incomplete.`);
    }
    return found;
  }, 3);
  for (const result of results) {
    if (result.status === "fulfilled") markets.push(...result.value);
    else errors.push(errorText(result.reason));
  }
  const status = source("polymarket-us", started, markets.length, errors, allCached, `${markets.length} open individual instruments from the official US public gateway. College or off-season leagues may have no listed games.`);
  if (warnings.length && status.status === "connected") status.status = "partial";
  return { markets, source: status, warnings: [...warnings, ...(errors.length ? ["Some Polymarket US requests failed; results may be incomplete."] : [])] };
}

function strings(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(string);
  try { const parsed: unknown = JSON.parse(string(value)); return Array.isArray(parsed) ? parsed.map(string) : []; }
  catch { return []; }
}

async function polymarketGlobal(query: CatalogQuery, games: Game[]) {
  const started = Date.now();
  const markets: Market[] = [];
  const errors: string[] = [];
  const warnings: string[] = ["Polymarket Global is a separate read-only venue. Its contracts and availability are not Polymarket US contracts."];
  let allCached = true;
  try {
    const sports = await json("https://gamma-api.polymarket.com/sports", 3_600_000);
    allCached = sports.cached;
    const slugs: Record<Sport, string> = { MLB: "mlb", NFL: "nfl", NBA: "nba", NCAAF: "cfb", NCAAB: "cbb" };
    const from = encodeURIComponent(newYorkInstant(query.start));
    const dayAfterEnd = new Date(Date.parse(`${query.end}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    const until = encodeURIComponent(newYorkInstant(dayAfterEnd));
    const results = await pooled(query.sports, async sport => {
      const config = list(sports.data).find(s => s.sport === slugs[sport]);
      if (!config) throw new Error(`Polymarket Global: no published ${sport} league configuration.`);
      const found: Market[] = [];
      for (let page = 0; page < 3; page++) {
        const response = await json(`https://gamma-api.polymarket.com/events?active=true&closed=false&tag_id=${config.primaryTagId}&limit=100&offset=${page * 100}&end_date_min=${from}&end_date_max=${until}&order=endDate&ascending=true`);
        allCached &&= response.cached;
        const events = list(response.data);
        for (const event of events) for (const raw of list(event.markets)) {
          const startsAt = iso(raw.gameStartTime || event.startTime);
          if (!startsAt || raw.closed === true || raw.active !== true || raw.enableOrderBook !== true || raw.acceptingOrders !== true) continue;
          const day = newYorkDate(new Date(startsAt));
          if (day < query.start || day > query.end) continue;
          const outcomes = strings(raw.outcomes);
          if (outcomes.length !== 2) continue;
          // Gamma BBO belongs to outcome index 0, which need not literally be named Yes.
          const yesBid = price(raw.bestBid);
          const yesAsk = price(raw.bestAsk);
          const noBid = yesAsk == null ? null : Number((1 - yesAsk).toFixed(6));
          const noAsk = yesBid == null ? null : Number((1 - yesBid).toFixed(6));
          const rules = string(raw.description);
          const candidate: Market = {
            id: string(raw.conditionId || raw.id), eventId: string(event.slug || event.id), venue: "polymarket-global", sport, title: string(raw.question), selection: outcomes[0], noSelection: outcomes[1],
            category: category(string(raw.sportsMarketType)), startsAt, startsAtSource: "venue", yesBid, yesAsk, noBid, noAsk,
            volume: number(raw.volumeNum ?? raw.volume), liquidity: number(raw.liquidityNum ?? raw.liquidity), updatedAt: iso(raw.updatedAt), fetchedAt: response.fetchedAt, url: `https://polymarket.com/event/${string(event.slug)}`,
            ...implied(yesBid, yesAsk, noBid, noAsk), status: "open", settlement: { type: "binary", verified: !!rules && !!raw.conditionId, rules, exceptionalSettlement: /cancel|postpon|tie|50.?50/i.test(rules) ? "Cancellation and tie provisions may change settlement; inspect the rules." : undefined }, matching: "venue-event-only", providerEventTitle: string(event.title),
          };
          found.push(withGame(candidate, `${event.title} ${raw.question} ${rules}`, games));
        }
        if (events.length < 100) break;
        if (page === 2) warnings.push(`${sport}: Global pagination capped at 300 events; results may be incomplete.`);
      }
      return found;
    }, 3);
    for (const result of results) {
      if (result.status === "fulfilled") markets.push(...result.value);
      else errors.push(errorText(result.reason));
    }
  } catch (error) { errors.push(errorText(error)); }
  const status = source("polymarket-global", started, markets.length, errors, allCached, `${markets.length} active binary Global markets. Never routed through the US adapter.`);
  if (warnings.length > 1 && status.status === "connected") status.status = "partial";
  return { markets, source: status, warnings: [...warnings, ...(errors.length ? ["Some Polymarket Global requests failed; results may be incomplete."] : [])] };
}

export async function getCatalog(query: CatalogQuery): Promise<Catalog> {
  // Validate internal consumers as well as URL callers.
  parseCatalogQuery(new URLSearchParams({ sports: query.sports.join(","), start: query.start, end: query.end, venue: query.venue }));
  const schedule = await schedules(query);
  const adapters: Record<Venue, (query: CatalogQuery, games: Game[]) => ReturnType<typeof kalshi>> = { kalshi, "polymarket-us": polymarketUS, "polymarket-global": polymarketGlobal };
  const venues: Venue[] = query.venue === "all" ? ["kalshi", "polymarket-us", "polymarket-global"] : [query.venue];
  const results = await Promise.all(venues.map(venue => adapters[venue](query, schedule.games)));
  const markets = [...new Map(results.flatMap(result => result.markets).map(m => [`${m.venue}:${m.id}`, m])).values()].sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
  const unmapped = markets.filter(m => !m.gameId).length;
  return {
    markets, games: schedule.games, sources: [...schedule.sources, ...results.map(r => r.source)], fetchedAt: new Date().toISOString(),
    warnings: [...new Set([...schedule.warnings, ...results.flatMap(r => r.warnings), ...(unmapped ? [`${unmapped} contracts have venue event identities only; schedule matching was not unique or unavailable.`] : []), "Probabilities are market-implied estimates from bid/ask midpoints. No independently calibrated predictive model is connected."])],
  };
}
