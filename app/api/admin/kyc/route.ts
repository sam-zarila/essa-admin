// app/api/admin/kyc/route.ts
export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/app/lib/firebase-admin";

export async function GET(req: NextRequest) {
  function getErrorMessage(error: unknown): string | undefined {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) {
    return String(error.message);
  }
  return undefined;
}
  try {
    const db = adminDb();

    const { searchParams } = new URL(req.url);
    const id = searchParams.get("id");
    const limit = Math.max(1, Math.min(200, Number(searchParams.get("limit") || 50)));

    // ----- Single KYC doc (for the modal) -----
    if (id) {
      const doc = await db.collection("kyc_data").doc(id).get();
      if (!doc.exists) {
        return NextResponse.json({ error: "not-found" }, { status: 404 });
      }
      return NextResponse.json({ id: doc.id, ...doc.data() });
    }

    // ----- List KYC docs -----
    const col = db.collection("kyc_data");

    // Decide which field to sort on (fallback from createdAt -> timestamp)
    const probe = await col.limit(1).get();
    const hasCreatedAt = probe.docs[0]?.get("createdAt") !== undefined;
    const sortField = hasCreatedAt ? "createdAt" : "timestamp";

    // IMPORTANT: type q as a Query so .orderBy() reassignment is valid
    const q: FirebaseFirestore.Query<FirebaseFirestore.DocumentData> = col.orderBy(
      sortField as string,
      "desc"
    );

    const snap = await q.limit(limit).get();

    const items = snap.docs.map((d) => {
      const v = d.data() ;
      const createdAt =
        v?.createdAt?.toMillis?.() ??
        v?.timestamp?.toMillis?.() ??
        null;

      return {
        id: d.id,
        firstName: v.firstName ?? v.applicantFirstName ?? "",
        lastName: v.lastName ?? v.applicantLastName ?? "",
        mobile: v.mobileTel1 ?? v.mobile ?? "",
        email: v.email1 ?? v.email ?? "",
        gender: v.gender ?? "",
        physicalCity: v.physicalCity ?? v.areaName ?? "",
        createdAt,
      };
    });

    return NextResponse.json({ items, updatedAt: Date.now() });
 } catch (err: unknown) {
  console.error("[/api/admin/kyc] fatal:", err);
  const message = getErrorMessage(err) || "internal-error";
  return NextResponse.json(
    { error: message },
    { status: 500 }
  );
}
}
