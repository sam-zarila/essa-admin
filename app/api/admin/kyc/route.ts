// app/api/admin/kyc/route.ts
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { adminDb } from "@/app/lib/firebase-admin";

export async function GET(req: Request) {
  try {
    const db = adminDb();

    const { searchParams } = new URL(req.url);
    const id = searchParams.get("id");
    const limit = Number(searchParams.get("limit") || 50);

    // ----- Single KYC doc (for the modal) -----
    if (id) {
      const doc = await db.collection("kyc_data").doc(id).get();
      if (!doc.exists) {
        return NextResponse.json({ error: "not-found" }, { status: 404 });
      }
      return NextResponse.json({ id: doc.id, ...doc.data() });
    }

    // ----- List KYC docs -----
    let q = db.collection("kyc_data");
    // Try to order by createdAt/timestamp if they exist; otherwise, just limit
    try {
      q = q.orderBy("createdAt", "desc");
    } catch {}
    try {
      q = q.orderBy("timestamp", "desc");
    } catch {}

    let snap;
    try {
      snap = await q.limit(limit).get();
    } catch (e) {
      console.warn("[/api/admin/kyc] orderBy failed, fallback to simple .limit():", e);
      snap = await db.collection("kyc_data").limit(limit).get();
    }

    const items = snap.docs.map((d) => {
      const v = d.data() as any;
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
      } as const;
    });

    return NextResponse.json({ items, updatedAt: Date.now() });
  } catch (err: any) {
    console.error("[/api/admin/kyc] fatal:", err);
    return NextResponse.json(
      { error: err?.message || "internal-error" },
      { status: 500 }
    );
  }
}
