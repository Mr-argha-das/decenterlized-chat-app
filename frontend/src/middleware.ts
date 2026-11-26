import { NextRequest, NextResponse } from "next/server";

// Phase 2 runs `/` with pure client-side mock data (no backend calls required).
// `/account` or future protected endpoints continue to support cookie/token guards.
const PROTECTED_PREFIXES = ["/account"];

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  const isProtected = PROTECTED_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`)
  );
  if (!isProtected) {
    return NextResponse.next();
  }

  const hasSessionCookie =
    request.cookies.has("relaychat_refresh") || request.cookies.has("relaychat_access");
  if (!hasSessionCookie) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|ws).*)"],
};
