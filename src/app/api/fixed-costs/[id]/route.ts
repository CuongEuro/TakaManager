import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/auth";

type Ctx = { params: Promise<{ id: string }> };

export async function PUT(req: NextRequest, { params }: Ctx) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const b = await req.json();
  const result = await prisma.fixedCost.updateMany({
    where: { id, organizationId: session.oid },
    data: {
      storeId: b.storeId !== undefined ? b.storeId || null : undefined,
      category: b.category ?? undefined,
      name: b.name != null ? String(b.name) : undefined,
      amount: b.amount != null ? Number(b.amount) : undefined,
      billingCycle: b.billingCycle ?? undefined,
      startDate: b.startDate ? new Date(b.startDate) : undefined,
      endDate: b.endDate !== undefined ? (b.endDate ? new Date(b.endDate) : null) : undefined,
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
  const result = await prisma.fixedCost.deleteMany({
    where: { id, organizationId: session.oid },
  });
  if (result.count === 0)
    return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
