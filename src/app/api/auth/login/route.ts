import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  verifyPassword,
  createToken,
  SESSION_COOKIE,
  sessionCookieOptions,
} from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const b = await req.json().catch(() => ({}));
  const email = String(b.email ?? "").trim().toLowerCase();
  const password = String(b.password ?? "");

  const user = await prisma.user.findUnique({
    where: { email },
    include: {
      memberships: {
        include: { organization: true },
        orderBy: { createdAt: "asc" },
      },
    },
  });

  if (!user || !verifyPassword(password, user.passwordHash))
    return NextResponse.json(
      { error: "Email hoặc mật khẩu không đúng." },
      { status: 401 }
    );

  const membership = user.memberships[0];
  if (!membership)
    return NextResponse.json(
      { error: "Tài khoản chưa thuộc workspace nào." },
      { status: 403 }
    );

  const token = createToken({
    uid: user.id,
    oid: membership.organizationId,
    email: user.email,
    name: user.name,
    role: membership.role,
  });

  const res = NextResponse.json({
    user: { email: user.email, name: user.name },
    org: { id: membership.organization.id, name: membership.organization.name },
    role: membership.role,
  });
  res.cookies.set(SESSION_COOKIE, token, sessionCookieOptions);
  return res;
}
