import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/auth";

type Ctx = { params: Promise<{ id: string }> };

export async function PUT(req: NextRequest, { params }: Ctx) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const b = await req.json();

  // scoped update: only rows belonging to the caller's org are touched
  const result = await prisma.store.updateMany({
    where: { id, organizationId: session.oid },
    data: {
      name: b.name != null ? String(b.name) : undefined,
      shopifyDomain: b.shopifyDomain !== undefined ? b.shopifyDomain || null : undefined,
      shopifyClientId: b.shopifyClientId !== undefined ? b.shopifyClientId || null : undefined,
      shopifyClientSecret: b.shopifyClientSecret ? String(b.shopifyClientSecret) : undefined,
      shopifyToken: b.shopifyToken ? String(b.shopifyToken) : undefined,
      shopifyApiVersion: b.shopifyApiVersion || undefined,
      currency: b.currency ?? undefined,
      taxRate: b.taxRate != null ? Number(b.taxRate) : undefined,
      active: b.active ?? undefined,
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
  const result = await prisma.store.deleteMany({
    where: { id, organizationId: session.oid },
  });
  if (result.count === 0)
    return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
