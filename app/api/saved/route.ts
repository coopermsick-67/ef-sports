import { NextRequest, NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { getDb } from "../../../db";
import { savedCombos } from "../../../db/schema";
import { getChatGPTUser } from "../../chatgpt-auth";

export const dynamic = "force-dynamic";
export const runtime = "edge";
const statuses = new Set(["research", "paper-open", "paper-won", "paper-lost"]);
function rowToItem(row: typeof savedCombos.$inferSelect) {
  return { id: row.comboId, combo: JSON.parse(row.comboJson), status: row.status, stake: row.stake, entryCost: row.entryCost, savedAt: row.savedAt, updatedAt: row.updatedAt };
}

export async function GET() {
  const user = await getChatGPTUser();
  if (!user) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  try {
    const rows = await getDb().select().from(savedCombos).where(eq(savedCombos.ownerId, user.userId)).orderBy(desc(savedCombos.savedAt)).limit(200);
    return NextResponse.json({ items: rows.map(rowToItem) });
  } catch { return NextResponse.json({ error: "Saved research is temporarily unavailable." }, { status: 503 }); }
}

export async function POST(request: NextRequest) {
  const user = await getChatGPTUser();
  if (!user) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  const raw = await request.text();
  if (raw.length > 100_000) return NextResponse.json({ error: "Saved combo is too large." }, { status: 413 });
  let body: Record<string, unknown>;
  try { body = JSON.parse(raw); } catch { return NextResponse.json({ error: "Invalid JSON." }, { status: 400 }); }
  const combo = body.combo;
  const id = body.id;
  const status = body.status ?? "research";
  const stake = Number(body.stake ?? 0);
  const entryCost = body.entryCost == null ? null : Number(body.entryCost);
  if (typeof id !== "string" || !id || id.length > 300 || !combo || typeof combo !== "object" ||
      !Array.isArray((combo as { legs?: unknown }).legs) || (combo as { legs: unknown[] }).legs.length < 1 ||
      (combo as { legs: unknown[] }).legs.length > 10 || typeof status !== "string" || !statuses.has(status) ||
      !Number.isFinite(stake) || stake < 0 || (entryCost !== null && (!Number.isFinite(entryCost) || entryCost < 0))) {
    return NextResponse.json({ error: "Invalid saved combo." }, { status: 400 });
  }
  const now = new Date().toISOString();
  const key = `${user.userId}:${id}`;
  try {
    await getDb().insert(savedCombos).values({ key, ownerId: user.userId, comboId: id, comboJson: JSON.stringify(combo), status, stake, entryCost, savedAt: now, updatedAt: now }).onConflictDoUpdate({ target: savedCombos.key, set: { comboJson: JSON.stringify(combo), status, stake, entryCost, updatedAt: now } });
    return NextResponse.json({ item: { id, combo, status, stake, entryCost, savedAt: now, updatedAt: now } }, { status: 201 });
  } catch { return NextResponse.json({ error: "Could not save research." }, { status: 503 }); }
}
