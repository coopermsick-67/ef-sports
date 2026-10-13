import { z } from "zod";
import { getCatalog } from "@/lib/providers";
import { optimizeCombos } from "@/lib/optimizer";
import { SPORTS } from "@/lib/types";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD dates.").refine((value) => {
  const parsed = Date.parse(`${value}T12:00:00Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}, "Choose a real calendar date.");

const schema = z.object({
  sports: z.array(z.enum(SPORTS)).min(1, "Select at least one sport.").max(5).transform((sports) => [...new Set(sports)]),
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
}).strict().refine((value) => {
  const duration = (Date.parse(value.end) - Date.parse(value.start)) / 86_400_000;
  return duration >= 0 && duration <= 30;
}, { message: "Select an inclusive date range of 1 to 31 days.", path: ["end"] });

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
    const catalog = await getCatalog(parsed.data);
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
