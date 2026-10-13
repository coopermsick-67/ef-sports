import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { savedCombos } from "../../../../db/schema";
import { getChatGPTUser } from "../../../chatgpt-auth";

export const dynamic = "force-dynamic";
export const runtime = "edge";
type RouteContext = { params: Promise<{ id: string }> };
const statuses = new Set(["research", "paper-open", "paper-won", "paper-lost"]);

export async function PATCH(request: NextRequest, context: RouteContext) {
  const user = await getChatGPTUser();
  if (!user) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  const { id } = await context.params;
  if (!id || id.length > 300) return NextResponse.json({ error: "Invalid combo ID." }, { status: 400 });
  let body: Record<string, unknown>;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON." }, { status: 400 }); }
  const changes: { status?: string; stake?: number; entryCost?: number | null; updatedAt: string } = { updatedAt: new Date().toISOString() };
  if (body.status !== undefined) { if (typeof body.status !== "string" || !statuses.has(body.status)) return NextResponse.json({ error: "Invalid status." }, { status: 400 }); changes.status = body.status; }
  if (body.stake !== undefined) { const n = Number(body.stake); if (!Number.isFinite(n) || n < 0) return NextResponse.json({ error: "Invalid stake." }, { status: 400 }); changes.stake = n; }
  if (body.entryCost !== undefined) { const n = body.entryCost === null ? null : Number(body.entryCost); if (n !== null && (!Number.isFinite(n) || n < 0)) return NextResponse.json({ error: "Invalid entry cost." }, { status: 400 }); changes.entryCost = n; }
  try {
    const rows = await getDb().update(savedCombos).set(changes).where(and(eq(savedCombos.key, `${user.userId}:${id}`), eq(savedCombos.ownerId, user.userId))).returning();
    if (!rows.length) return NextResponse.json({ error: "Saved combo not found." }, { status: 404 });
    return NextResponse.json({ item: { id, status: rows[0].status, stake: rows[0].stake, entryCost: rows[0].entryCost, updatedAt: rows[0].updatedAt } });
  } catch { return NextResponse.json({ error: "Could not update saved combo." }, { status: 503 }); }
}

export async function DELETE(_request: NextRequest, context: RouteContext) {
  const user = await getChatGPTUser();
  if (!user) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  const { id } = await context.params;
  if (!id || id.length > 300) return NextResponse.json({ error: "Invalid combo ID." }, { status: 400 });
  try {
    await getDb().delete(savedCombos).where(and(eq(savedCombos.key, `${user.userId}:${id}`), eq(savedCombos.ownerId, user.userId)));
    return NextResponse.json({ deleted: true });
  } catch { return NextResponse.json({ error: "Could not remove saved combo." }, { status: 503 }); }
}
