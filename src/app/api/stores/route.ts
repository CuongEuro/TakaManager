import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/auth";

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const stores = await prisma.store.findMany({
    where: { organizationId: session.oid },
    orderBy: { name: "asc" },
  });
  // Never expose the raw access token to the client; send a boolean flag instead.
  const safe = stores.map(({ shopifyToken, ...s }) => ({
    ...s,
    hasToken: !!shopifyToken,
  }));
  return NextResponse.json(safe);
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const b = await req.json();
  if (!b.name) return NextResponse.json({ error: "name required" }, { status: 400 });
  const store = await prisma.store.create({
    data: {
      organizationId: session.oid,
      name: String(b.name),
      shopifyDomain: b.shopifyDomain || null,
      shopifyToken: b.shopifyToken || null,
      shopifyApiVersion: b.shopifyApiVersion || undefined,
      currency: b.currency || "JPY",
      taxRate: b.taxRate != null ? Number(b.taxRate) : 0.1,
      active: b.active ?? true,
    },
  });
  return NextResponse.json(store, { status: 201 });
}
