import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { syncAllAdAccounts } from "@/lib/adsync";

export const dynamic = "force-dynamic";
export const maxDuration = 300; // Hobby caps at 60s; light 7-day window keeps it short

// Daily Vercel Cron entry point. Pulls a LIGHT recent window (7 days) of ad spend
// for every organization's accounts. Secured by CRON_SECRET: Vercel automatically
// sends `Authorization: Bearer <CRON_SECRET>` when that env var is set.
async function handle(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret)
    return NextResponse.json(
      { ok: false, error: "CRON_SECRET chưa được cấu hình." },
      { status: 503 }
    );
  if (req.headers.get("authorization") !== `Bearer ${secret}`)
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const orgs = await prisma.organization.findMany({ select: { id: true } });
  let accounts = 0;
  let ok = 0;
  for (const org of orgs) {
    const results = await syncAllAdAccounts(org.id, { sinceDays: 7 });
    accounts += results.length;
    ok += results.filter((r) => r.ok).length;
  }
  return NextResponse.json({ ok: true, orgs: orgs.length, accounts, synced: ok });
}

// Vercel Cron uses GET; allow POST too for manual triggering with the secret.
export const GET = handle;
export const POST = handle;
