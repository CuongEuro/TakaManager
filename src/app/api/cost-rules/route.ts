import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/auth";

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const items = await prisma.costRule.findMany({
    where: { organizationId: session.oid },
    orderBy: { createdAt: "desc" },
    include: {
      store: { select: { name: true } },
      product: { select: { title: true } },
    },
  });
  return NextResponse.json(items);
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const b = await req.json();
  if (!b.type || b.amount == null)
    return NextResponse.json({ error: "type and amount required" }, { status: 400 });
  if (b.storeId) {
    const store = await prisma.store.findFirst({
      where: { id: b.storeId, organizationId: session.oid },
    });
    if (!store) return NextResponse.json({ error: "invalid store" }, { status: 400 });
  }
  if (b.productId) {
    const product = await prisma.product.findFirst({
      where: { id: b.productId, organizationId: session.oid },
    });
    if (!product) return NextResponse.json({ error: "invalid product" }, { status: 400 });
  }
  const item = await prisma.costRule.create({
    data: {
      organizationId: session.oid,
      storeId: b.storeId || null,
      productId: b.productId || null,
      type: b.type,
      calcMethod: b.calcMethod || "PER_UNIT",
      amount: Number(b.amount),
      active: b.active ?? true,
      note: b.note || null,
    },
  });
  return NextResponse.json(item, { status: 201 });
}
