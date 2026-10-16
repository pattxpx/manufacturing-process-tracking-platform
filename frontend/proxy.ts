import { NextRequest, NextResponse } from "next/server";

// Runs before every page request (Next.js 16 "proxy", formerly "middleware"). It does two things:
//  1. Adds a Content-Security-Policy with a fresh random nonce, so only our own scripts can run (XSS defence).
//  2. Sends visitors without a session cookie to the sign-in page. This is only a convenience: the cookie is
//     NOT checked here, and the backend verifies the real session on every API call.

const isDev = process.env.NODE_ENV === "development";

function websocketOrigin(): string {
  try {
    return new URL(process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:8000/ws/production/").origin;
  } catch {
    return "";
  }
}

export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const hasSessionCookie = request.cookies.has("session") || request.cookies.has("__Host-session");
  if (!hasSessionCookie && pathname !== "/login") {
    const login = new URL("/login", request.url);
    if (pathname !== "/") login.searchParams.set("next", pathname + search);
    return NextResponse.redirect(login);
  }

  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const csp = [
    "default-src 'self'",
    // Only scripts that carry this request's nonce may run. 'unsafe-eval' is needed by React's dev tools only.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ""}`,
    // Styles: inline style attributes are used by the component library and the charts.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "font-src 'self'",
    `connect-src 'self' ${websocketOrigin()}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(isDev ? [] : ["upgrade-insecure-requests"]),
  ].join("; ");

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

export const config = {
  matcher: [{
    source: "/((?!api|_next/static|_next/image|favicon.ico|robots.txt).*)",
    missing: [
      { type: "header", key: "next-router-prefetch" },
      { type: "header", key: "purpose", value: "prefetch" },
    ],
  }],
};
