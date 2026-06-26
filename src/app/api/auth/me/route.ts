import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getSession();
  if (!session)
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const org = await prisma.organization.findUnique({
    where: { id: session.oid },
    select: { id: true, name: true, inviteCode: true },
  });
  if (!org)
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  return NextResponse.json({
    user: { email: session.email, name: session.name },
    org: {
      id: org.id,
      name: org.name,
      // only reveal invite code to owners/admins
      inviteCode:
        session.role === "OWNER" || session.role === "ADMIN"
          ? org.inviteCode
          : null,
    },
    role: session.role,
  });
}
