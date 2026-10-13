import { z } from "zod";
import { getCatalog, getPremadeCatalog } from "@/lib/providers";
import { optimizeCombos } from "@/lib/optimizer";
import { SPORTS } from "@/lib/types";
import type { PremadeGameResult } from "@/lib/optimizer";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD dates.").refine((value) => {
  const parsed = Date.parse(`${value}T12:00:00Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}, "Choose a real calendar date.");

const schema = z.object({
  sports: z.array(z.enum(SPORTS)).max(5).transform((sports) => {
    const selected = [...new Set(sports)];
    return selected.length ? selected : [...SPORTS];
  }),
  start: date,
  end: date,
  venue: z.enum(["all", "kalshi", "polymarket-us", "polymarket-global"]).default("kalshi"),
  legs: z.number().int().min(1, "Choose at least one leg.").max(10, "The maximum is 10 legs."),
  stake: z.number().finite().min(0).max(1_000_000).default(10),
  marketCategories: z.array(z.enum(["moneyline", "spread", "total", "team-total", "player-prop", "period", "other"])).max(7).optional(),
  minLiquidity: z.number().finite().min(0).max(1e12).optional(),
  maxSpread: z.number().finite().min(0).max(1).optional(),
  excluded: z.array(z.string().min(1).max(500)).max(500).optional(),
  gameIds: z.array(z.string().min(1).max(500)).max(500).optional(),
  requireEachSport: z.boolean().optional(),
  anchorGameId: z.string().min(1).max(500).optional(),
  anchorGameIds: z.array(z.string().min(1).max(500)).min(1).max(48).transform((ids) => [...new Set(ids)]).optional(),
  anchorSport: z.enum(SPORTS).optional(),
  tiered: z.boolean().optional(),
}).strict().refine((value) => {
  const duration = (Date.parse(value.end) - Date.parse(value.start)) / 86_400_000;
  return duration >= 0 && duration <= 30;
}, { message: "Select an inclusive date range of 1 to 31 days.", path: ["end"] }).refine(
  (value) => !(value.anchorGameId && value.anchorGameIds),
  { message: "Use either one anchor game or a batch of anchor games.", path: ["anchorGameIds"] },
);

export async function POST(request: Request) {
  const headers = { "Cache-Control": "no-store", "X-Data-Timezone": "America/New_York" };
  let body: unknown;
  try {
    const text = await request.text();
    if (text.length > 65_536) return Response.json({ error: "Request is too large." }, { status: 413, headers });
    body = JSON.parse(text);
  } catch {
    return Response.json({ error: "Provide a valid JSON request." }, { status: 400, headers });
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return Response.json({
      error: parsed.error.issues.map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`).join(" "),
      combos: [],
    }, { status: 400, headers });
  }
  try {
    const catalog = parsed.data.anchorGameIds && parsed.data.anchorSport
      ? await getPremadeCatalog(parsed.data, parsed.data.anchorSport)
      : await getCatalog(parsed.data);
    if (parsed.data.anchorGameIds) {
      const { anchorGameIds, tiered, ...comboRequest } = parsed.data;
      delete comboRequest.anchorSport;
      if (tiered) {
        const definitions = [
          { id: "short" as const, label: "Short shot", minLegs: 2, maxLegs: 3, minEntryPrice: 0.20, maxEntryPrice: 0.50 },
          { id: "medium" as const, label: "Mid-range", minLegs: 4, maxLegs: 6, minEntryPrice: 0.25, maxEntryPrice: 0.55 },
          { id: "long" as const, label: "Long shot", minLegs: 7, maxLegs: 10, minEntryPrice: 0.30, maxEntryPrice: 0.60 },
        ];
        const gameCombos: Record<string, PremadeGameResult> = Object.fromEntries(anchorGameIds.map((anchorGameId) => {
          const anchoredRequest = { ...comboRequest, anchorGameId };
          const anchorHasMarket = catalog.markets.some((market) => market.gameId === anchorGameId && market.status === "open");
          const tiers = definitions.map((definition) => {
            const result = optimizeCombos(catalog, { ...anchoredRequest, legs: definition.maxLegs }, {
              limit: 1, ranking: "winning-probability", minEntryPrice: definition.minEntryPrice, maxEntryPrice: definition.maxEntryPrice,
            });
            const combo = result.combos[0] ?? null;
            const legs = combo?.legs.length ?? 0;
            if (!combo || legs < definition.minLegs) {
              return {
                ...definition,
                legs,
                combo: null,
                reason: legs
                  ? `${legs} verified games fit this tier's ${Math.round(definition.minEntryPrice * 100)}¢–${Math.round(definition.maxEntryPrice * 100)}¢ ask range; it needs ${definition.minLegs}–${definition.maxLegs}.`
                  : anchorHasMarket
                    ? `No current standalone ask for this matchup fits this tier's ${Math.round(definition.minEntryPrice * 100)}¢–${Math.round(definition.maxEntryPrice * 100)}¢ range.`
                    : "No current schedule-verified market is available for this matchup.",
              };
            }
            return {
              ...definition,
              legs,
              combo,
            };
          });
          return [anchorGameId, { tiers } satisfies PremadeGameResult];
        }));
        return Response.json({ gameCombos, fetchedAt: catalog.fetchedAt }, { headers });
      }
      const gameCombos = Object.fromEntries(anchorGameIds.map((anchorGameId) => [
        anchorGameId,
        optimizeCombos(catalog, { ...comboRequest, anchorGameId }, { limit: 1 }),
      ]));
      return Response.json({ gameCombos, fetchedAt: catalog.fetchedAt }, { headers });
    }
    const result = optimizeCombos(catalog, parsed.data);
    return Response.json({ ...result, fetchedAt: catalog.fetchedAt }, { headers });
  } catch {
    return Response.json({
      error: "The market catalog could not be loaded. Retry after the provider recovers.",
      combos: [],
      warnings: ["No stale or simulated selections were substituted for the unavailable data."],
    }, { status: 503, headers });
  }
}
