import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/auth";

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const items = await prisma.fixedCost.findMany({
    where: { organizationId: session.oid },
    orderBy: { createdAt: "desc" },
    include: { store: { select: { name: true } } },
  });
  return NextResponse.json(items);
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const b = await req.json();
  if (!b.name || b.amount == null)
    return NextResponse.json({ error: "name and amount required" }, { status: 400 });
  if (b.storeId) {
    const store = await prisma.store.findFirst({
      where: { id: b.storeId, organizationId: session.oid },
    });
    if (!store) return NextResponse.json({ error: "invalid store" }, { status: 400 });
  }
  const item = await prisma.fixedCost.create({
    data: {
      organizationId: session.oid,
      storeId: b.storeId || null,
      category: b.category || "OTHER",
      name: String(b.name),
      amount: Number(b.amount),
      billingCycle: b.billingCycle || "MONTHLY",
      startDate: b.startDate ? new Date(b.startDate) : new Date(),
      endDate: b.endDate ? new Date(b.endDate) : null,
      note: b.note || null,
    },
  });
  return NextResponse.json(item, { status: 201 });
}
