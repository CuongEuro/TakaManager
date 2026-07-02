import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/auth";
import { syncAdAccount } from "@/lib/adsync";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Lightweight, THROTTLED refresh of recent ad spend so the dashboard's "today"
// reflects near-real-time spend (orders/revenue are already realtime via
// webhooks). Pulls only today+yesterday, campaign-level (deep=false), and skips
// accounts synced within `staleMinutes` so repeated dashboard loads don't hammer
// the ad APIs.
function configured(a: {
  platform: string;
  accessToken: string | null;
  accessSecret: string | null;
  apiKey: string | null;
  apiSecret: string | null;
  refreshToken: string | null;
  clientId: string | null;
  clientSecret: string | null;
  developerToken: string | null;
}): boolean {
  if (a.platform === "FACEBOOK") return !!a.accessToken;
  if (a.platform === "GOOGLE")
    return !!(a.clientId && a.clientSecret && a.refreshToken && a.developerToken);
  if (a.platform === "TWITTER")
    return !!(a.apiKey && a.apiSecret && a.accessToken && a.accessSecret);
  return false;
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const staleMinutes = body.staleMinutes != null ? Number(body.staleMinutes) : 60;
  const force = !!body.force;
  const cutoff = Date.now() - staleMinutes * 60000;

  const accounts = await prisma.adAccount.findMany({
    where: { organizationId: session.oid, active: true },
  });

  let refreshed = 0;
  let ok = 0;
  let skipped = 0;
  for (const a of accounts) {
    if (!configured(a)) {
      skipped++;
      continue;
    }
    // Throttle: skip accounts refreshed recently (unless forced).
    if (!force && a.lastSyncedAt && a.lastSyncedAt.getTime() > cutoff) {
      skipped++;
      continue;
    }
    const res = await syncAdAccount(a.id, session.oid, { sinceDays: 1, deep: false });
    refreshed++;
    if (res.ok) ok++;
  }
  return NextResponse.json({ refreshed, ok, skipped });
}
