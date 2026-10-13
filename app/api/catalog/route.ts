import { getCatalog, parseCatalogQuery } from "@/lib/providers";

export async function GET(request: Request) {
  try {
    const query = parseCatalogQuery(new URL(request.url).searchParams);
    const catalog = await getCatalog(query);
    return Response.json(catalog, { headers: { "Cache-Control": "private, max-age=20", "X-Data-Timezone": "America/New_York" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Unable to load catalog.", markets: [], games: [], sources: [], fetchedAt: new Date().toISOString(), warnings: [] }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
}
