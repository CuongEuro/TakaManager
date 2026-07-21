import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/auth";
import { syncAdAccount } from "@/lib/adsync";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

type Ctx = { params: Promise<{ id: string }> };

// List this account's campaigns + their current store mapping.
export async function GET(_req: NextRequest, { params }: Ctx) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;

  const account = await prisma.adAccount.findFirst({
    where: { id, organizationId: session.oid },
    select: { id: true, name: true, platform: true, storeId: true },
  });
  if (!account) return NextResponse.json({ error: "not found" }, { status: 404 });

  const campaigns = await prisma.adEntity.findMany({
    where: { accountId: id, organizationId: session.oid, level: "CAMPAIGN" },
    select: { id: true, externalId: true, name: true, storeId: true, status: true },
    orderBy: { name: "asc" },
  });
  return NextResponse.json({ account, campaigns });
}

// Save campaign→store mappings, then re-attribute spend (re-sync the account).
export async function PUT(req: NextRequest, { params }: Ctx) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;

  const account = await prisma.adAccount.findFirst({
    where: { id, organizationId: session.oid },
    select: { id: true },
  });
  if (!account) return NextResponse.json({ error: "not found" }, { status: 404 });

  const b = await req.json().catch(() => ({} as Record<string, unknown>));
  const mappings = Array.isArray(b.mappings)
    ? (b.mappings as { id: string; storeId: string | null }[])
    : [];

  // Validate referenced stores belong to the org.
  const storeIds = [...new Set(mappings.map((m) => m.storeId).filter(Boolean))] as string[];
  if (storeIds.length) {
    const found = await prisma.store.count({
      where: { id: { in: storeIds }, organizationId: session.oid },
    });
    if (found !== storeIds.length)
      return NextResponse.json({ error: "invalid store" }, { status: 400 });
  }

  // Apply mappings (scoped to this account + org).
  for (const m of mappings) {
    await prisma.adEntity.updateMany({
      where: { id: m.id, accountId: id, organizationId: session.oid, level: "CAMPAIGN" },
      data: { storeId: m.storeId || null },
    });
  }

  // Re-attribute spend with the new mapping (best-effort; mapping is already saved).
  // Keep the window light (30d) to avoid pulling heavy old campaign history.
  let resync: { ok: boolean; error?: string } = { ok: true };
  try {
    const r = await syncAdAccount(id, session.oid, {
      sinceDays: 30,
      deep: false,
    });
    resync = { ok: r.ok, error: r.error };
  } catch (e) {
    resync = { ok: false, error: e instanceof Error ? e.message : String(e) };
  }

  return NextResponse.json({ ok: true, resync });
}
