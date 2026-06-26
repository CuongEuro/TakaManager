import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/auth";

type Ctx = { params: Promise<{ id: string }> };

// Only overwrite a secret when a non-empty value is provided (keeps existing).
function secret(v: unknown): string | undefined {
  return v ? String(v) : undefined;
}

export async function PUT(req: NextRequest, { params }: Ctx) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const b = await req.json();
  const result = await prisma.adAccount.updateMany({
    where: { id, organizationId: session.oid },
    data: {
      storeId: b.storeId !== undefined ? b.storeId || null : undefined,
      name: b.name != null ? String(b.name) : undefined,
      externalId: b.externalId != null ? String(b.externalId) : undefined,
      active: b.active ?? undefined,
      accessToken: secret(b.accessToken),
      accessSecret: secret(b.accessSecret),
      apiKey: secret(b.apiKey),
      apiSecret: secret(b.apiSecret),
      refreshToken: secret(b.refreshToken),
      clientId: secret(b.clientId),
      clientSecret: secret(b.clientSecret),
      developerToken: secret(b.developerToken),
      loginCustomerId: secret(b.loginCustomerId),
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
  const result = await prisma.adAccount.deleteMany({
    where: { id, organizationId: session.oid },
  });
  if (result.count === 0)
    return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
