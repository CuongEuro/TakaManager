import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

// In-app ad-alert inbox: latest alerts + unread count. `?count=1` returns only
// the unread count (sidebar badge polling).
export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  if (req.nextUrl.searchParams.get("count")) {
    const unreadCount = await prisma.adAlert.count({
      where: { organizationId: session.oid, readAt: null },
    });
    return NextResponse.json({ unreadCount });
  }

  const [alerts, unreadCount] = await Promise.all([
    prisma.adAlert.findMany({
      where: { organizationId: session.oid },
      orderBy: { createdAt: "desc" },
      take: 50,
    }),
    prisma.adAlert.count({
      where: { organizationId: session.oid, readAt: null },
    }),
  ]);
  return NextResponse.json({ alerts, unreadCount });
}

// Mark alerts read: { ids: string[] } or { all: true }.
export async function PUT(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const b = await req.json().catch(() => ({} as Record<string, unknown>));
  const where = b.all
    ? { organizationId: session.oid, readAt: null }
    : {
        organizationId: session.oid,
        id: { in: Array.isArray(b.ids) ? (b.ids as string[]) : [] },
      };
  const r = await prisma.adAlert.updateMany({
    where,
    data: { readAt: new Date() },
  });
  return NextResponse.json({ updated: r.count });
}
