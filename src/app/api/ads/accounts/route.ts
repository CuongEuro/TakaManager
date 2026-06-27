import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/auth";

function isConfigured(a: {
  platform: string;
  accessToken: string | null;
  accessSecret: string | null;
  apiKey: string | null;
  apiSecret: string | null;
  refreshToken: string | null;
  clientId: string | null;
  clientSecret: string | null;
  developerToken: string | null;
}): boolean {
  if (a.platform === "FACEBOOK") return !!a.accessToken;
  if (a.platform === "GOOGLE")
    return !!(a.clientId && a.clientSecret && a.refreshToken && a.developerToken);
  if (a.platform === "TWITTER")
    return !!(a.apiKey && a.apiSecret && a.accessToken && a.accessSecret);
  return false;
}

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const [accounts, campTotal, campMapped] = await Promise.all([
    prisma.adAccount.findMany({
      where: { organizationId: session.oid },
      orderBy: { createdAt: "desc" },
      include: { store: { select: { name: true } } },
    }),
    prisma.adEntity.groupBy({
      by: ["accountId"],
      where: { organizationId: session.oid, level: "CAMPAIGN" },
      _count: { _all: true },
    }),
    prisma.adEntity.groupBy({
      by: ["accountId"],
      where: { organizationId: session.oid, level: "CAMPAIGN", storeId: { not: null } },
      _count: { _all: true },
    }),
  ]);
  const totalBy = new Map(campTotal.map((c) => [c.accountId, c._count._all]));
  const mappedBy = new Map(campMapped.map((c) => [c.accountId, c._count._all]));
  // strip secrets — only expose a "configured" flag + campaign mapping counts
  const safe = accounts.map((a) => ({
    id: a.id,
    storeId: a.storeId,
    storeName: a.store?.name ?? null,
    platform: a.platform,
    name: a.name,
    externalId: a.externalId,
    active: a.active,
    lastSyncedAt: a.lastSyncedAt,
    configured: isConfigured(a),
    campaignCount: totalBy.get(a.id) ?? 0,
    mappedCount: mappedBy.get(a.id) ?? 0,
  }));
  return NextResponse.json(safe);
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const b = await req.json();
  if (!b.platform || !b.name || !b.externalId)
    return NextResponse.json(
      { error: "platform, name, externalId required" },
      { status: 400 }
    );
  if (b.storeId) {
    const store = await prisma.store.findFirst({
      where: { id: b.storeId, organizationId: session.oid },
    });
    if (!store) return NextResponse.json({ error: "invalid store" }, { status: 400 });
  }
  const account = await prisma.adAccount.create({
    data: {
      organizationId: session.oid,
      storeId: b.storeId || null,
      platform: b.platform,
      name: String(b.name),
      externalId: String(b.externalId),
      accessToken: b.accessToken || null,
      accessSecret: b.accessSecret || null,
      apiKey: b.apiKey || null,
      apiSecret: b.apiSecret || null,
      refreshToken: b.refreshToken || null,
      clientId: b.clientId || null,
      clientSecret: b.clientSecret || null,
      developerToken: b.developerToken || null,
      loginCustomerId: b.loginCustomerId || null,
    },
  });
  return NextResponse.json({ id: account.id }, { status: 201 });
}
