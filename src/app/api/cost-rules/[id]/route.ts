import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/auth";

type Ctx = { params: Promise<{ id: string }> };

export async function PUT(req: NextRequest, { params }: Ctx) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const b = await req.json();
  const result = await prisma.costRule.updateMany({
    where: { id, organizationId: session.oid },
    data: {
      storeId: b.storeId !== undefined ? b.storeId || null : undefined,
      productId: b.productId !== undefined ? b.productId || null : undefined,
      type: b.type ?? undefined,
      calcMethod: b.calcMethod ?? undefined,
      amount: b.amount != null ? Number(b.amount) : undefined,
      active: b.active ?? undefined,
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
  const result = await prisma.costRule.deleteMany({
    where: { id, organizationId: session.oid },
  });
  if (result.count === 0)
    return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
