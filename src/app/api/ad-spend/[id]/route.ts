import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/auth";

type Ctx = { params: Promise<{ id: string }> };

export async function PUT(req: NextRequest, { params }: Ctx) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const b = await req.json();
  const result = await prisma.adSpend.updateMany({
    where: { id, organizationId: session.oid },
    data: {
      storeId: b.storeId !== undefined ? b.storeId || null : undefined,
      platform: b.platform ?? undefined,
      date: b.date ? new Date(b.date) : undefined,
      campaignName: b.campaignName !== undefined ? b.campaignName || null : undefined,
      spend: b.spend != null ? Number(b.spend) : undefined,
      impressions: b.impressions != null ? Number(b.impressions) : undefined,
      clicks: b.clicks != null ? Number(b.clicks) : undefined,
      conversions: b.conversions != null ? Number(b.conversions) : undefined,
      revenue: b.revenue != null ? Number(b.revenue) : undefined,
      note: b.note !== undefined ? b.note || null : undefined,
    },
  });
  if (result.count === 0)
    return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: NextRequest, { params }: Ctx) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const result = await prisma.adSpend.deleteMany({
    where: { id, organizationId: session.oid },
  });
  if (result.count === 0)
    return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
