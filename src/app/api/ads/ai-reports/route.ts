import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

// Latest saved AI strategy reports (metadata only — fetch one by id for body).
export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const reports = await prisma.aiReport.findMany({
    where: { organizationId: session.oid },
    orderBy: { createdAt: "desc" },
    take: 20,
    select: {
      id: true,
      createdAt: true,
      preset: true,
      storeId: true,
      platform: true,
      model: true,
    },
  });
  return NextResponse.json({ reports });
}
