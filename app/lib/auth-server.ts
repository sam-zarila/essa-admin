import { NextResponse } from "next/server";

/**
 * Middleware-style helper to check if a user is an admin
 * Call this before running admin-only logic in your API routes.
 */
export function requireAdmin(user: { isAdmin?: boolean }) {
  if (!user || !user.isAdmin) {
    return NextResponse.json(
      { error: "Unauthorized: Admins only" },
      { status: 403 }
    );
  }

  return true;
}
