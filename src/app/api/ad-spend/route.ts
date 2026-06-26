import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/auth";

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const sp = req.nextUrl.searchParams;
  const where: { organizationId: string; date?: { gte?: Date; lt?: Date } } = {
    organizationId: session.oid,
  };
  const from = sp.get("from");
  const to = sp.get("to");
  if (from || to) {
    where.date = {};
    if (from) where.date.gte = new Date(from);
    if (to) where.date.lt = new Date(to);
  }
  const items = await prisma.adSpend.findMany({
    where,
    orderBy: { date: "desc" },
    include: { store: { select: { name: true } } },
    take: 500,
  });
  return NextResponse.json(items);
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const b = await req.json();
  if (!b.platform || b.spend == null || !b.date)
    return NextResponse.json(
      { error: "platform, spend and date required" },
      { status: 400 }
    );
  if (b.storeId) {
    const store = await prisma.store.findFirst({
      where: { id: b.storeId, organizationId: session.oid },
    });
    if (!store) return NextResponse.json({ error: "invalid store" }, { status: 400 });
  }
  const item = await prisma.adSpend.create({
    data: {
      organizationId: session.oid,
      storeId: b.storeId || null,
      platform: b.platform,
      date: new Date(b.date),
      campaignName: b.campaignName || null,
      spend: Number(b.spend),
      impressions: b.impressions != null ? Number(b.impressions) : 0,
      clicks: b.clicks != null ? Number(b.clicks) : 0,
      conversions: b.conversions != null ? Number(b.conversions) : 0,
      revenue: b.revenue != null ? Number(b.revenue) : 0,
      source: b.source || "MANUAL",
      note: b.note || null,
    },
  });
  return NextResponse.json(item, { status: 201 });
}
