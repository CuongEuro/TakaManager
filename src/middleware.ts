import { NextRequest, NextResponse } from "next/server";

// Cookie name must match SESSION_COOKIE in lib/auth.ts. Hardcoded here because
// middleware runs on the edge runtime and must not import the Node-crypto auth lib.
const SESSION_COOKIE = "taka_session";
const PUBLIC_PAGES = ["/login", "/signup"];

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Always allow auth endpoints, the Shopify webhook receiver (verified by HMAC),
  // the cron endpoint (verified by CRON_SECRET), and the login/signup pages —
  // none of these carry a session cookie.
  if (
    pathname.startsWith("/api/auth") ||
    pathname === "/api/shopify/webhook" ||
    pathname.startsWith("/api/cron/") ||
    PUBLIC_PAGES.includes(pathname)
  ) {
    return NextResponse.next();
  }

  // Presence check only — full HMAC verification happens server-side in each
  // API route / getSession(). This is the UX/defense gate.
  if (!req.cookies.has(SESSION_COOKIE)) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
