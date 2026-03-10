import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { jwtVerify, errors } from "jose";

interface RequestCookie {
  name: string;
  value: string;
}

const SECRET = process.env.JWT_SECRET as string;

export async function middleware(req: NextRequest) {
  const token = (req.cookies.get("verified") as RequestCookie)?.value;

  // Public routes (don't require auth)
  const publicPaths = ["/", "/health", "/ready"];
  const isPublic = publicPaths.some((path) => req.nextUrl.pathname === path);

  if (isPublic) {
    // If already logged in and trying to access login page, redirect to battle
    if (token && req.nextUrl.pathname === "/") {
      return NextResponse.redirect(new URL("/battle", req.url));
    }
    return NextResponse.next();
  }

  // If not authenticated and trying to access protected route, redirect to login
  if (!token && !isPublic) {
    return NextResponse.redirect(new URL("/", req.url));
  }

  // Verify JWT token
  const secret = new TextEncoder().encode(SECRET);

  try {
    await jwtVerify(token, secret);
  } catch (error) {
    const res = NextResponse.redirect(new URL("/", req.url));

    // Delete cookie on any JWT error
    if (
      error instanceof errors.JWTExpired ||
      error instanceof errors.JWTInvalid ||
      error instanceof errors.JWSSignatureVerificationFailed
    ) {
      res.cookies.delete("verified");
    }

    console.error("JWT verification error:", error);
    return res;
  }

  return NextResponse.next();
}

// Match all routes except static files, api routes, etc.
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|api).*)"],
};
