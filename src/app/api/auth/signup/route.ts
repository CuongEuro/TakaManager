import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { prisma } from "@/lib/prisma";
import {
  hashPassword,
  createToken,
  SESSION_COOKIE,
  sessionCookieOptions,
} from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const b = await req.json().catch(() => ({}));
  const email = String(b.email ?? "").trim().toLowerCase();
  const password = String(b.password ?? "");
  const name = b.name ? String(b.name).trim() : null;
  const inviteCode = b.inviteCode ? String(b.inviteCode).trim() : "";

  if (!email || !email.includes("@"))
    return NextResponse.json({ error: "Email không hợp lệ." }, { status: 400 });
  if (password.length < 8)
    return NextResponse.json(
      { error: "Mật khẩu tối thiểu 8 ký tự." },
      { status: 400 }
    );

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing)
    return NextResponse.json({ error: "Email đã được đăng ký." }, { status: 409 });

  // Resolve target org: join via invite code, or create a new workspace.
  let org: { id: string; name: string };
  let role: string;
  if (inviteCode) {
    const found = await prisma.organization.findUnique({
      where: { inviteCode },
    });
    if (!found)
      return NextResponse.json(
        { error: "Mã mời không đúng." },
        { status: 400 }
      );
    org = { id: found.id, name: found.name };
    role = "MEMBER";
  } else {
    const orgName =
      (b.orgName && String(b.orgName).trim()) ||
      `${name || email.split("@")[0]}'s Workspace`;
    const created = await prisma.organization.create({
      data: { name: orgName, inviteCode: randomBytes(6).toString("hex") },
    });
    org = { id: created.id, name: created.name };
    role = "OWNER";
  }

  const user = await prisma.user.create({
    data: {
      email,
      name,
      passwordHash: hashPassword(password),
      memberships: { create: { organizationId: org.id, role } },
    },
  });

  const token = createToken({
    uid: user.id,
    oid: org.id,
    email: user.email,
    name: user.name,
    role,
  });

  const res = NextResponse.json(
    { user: { email: user.email, name: user.name }, org, role },
    { status: 201 }
  );
  res.cookies.set(SESSION_COOKIE, token, sessionCookieOptions);
  return res;
}
