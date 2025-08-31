// app/api/admin/kyc/route.ts
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { adminDb } from "@/app/lib/firebase-admin";

function toMillis(v: any): number | null {
  try {
    if (v?.toMillis) return v.toMillis();
    return null;
  } catch {
    return null;
  }
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id");
  const limit = Number(searchParams.get("limit") || 100);

  const db = adminDb();

  // Single doc for modal
  if (id) {
    const doc = await db.collection("kyc_data").doc(id).get();
    if (!doc.exists) return NextResponse.json({ error: "not-found" }, { status: 404 });
    const v = doc.data() || {};
    return NextResponse.json({
      id: doc.id,
      ...v,
      _createdAt: toMillis(v.createdAt) ?? toMillis(v.timestamp) ?? null,
    });
  }

  // List (order by createdAt/timestamp if available)
  let q: FirebaseFirestore.Query = db.collection("kyc_data");
  try { q = q.orderBy("createdAt", "desc"); } catch {}
  try { q = q.orderBy("timestamp", "desc"); } catch {}

  const snap = await q.limit(limit).get();

  const items = snap.docs.map((d) => {
    const v = d.data() as any;
    return {
      id: d.id,
      title: v.title ?? "",
      firstName: v.firstName ?? v.applicantFirstName ?? "",
      lastName: v.lastName ?? v.applicantLastName ?? "",
      gender: v.gender ?? "",
      maritalStatus: v.maritalStatus ?? "",
      physicalCity: v.physicalCity ?? v.areaName ?? "",
      mobile: v.mobileTel1 ?? v.mobile ?? "",
      email: v.email1 ?? v.email ?? "",
      createdAt: toMillis(v.createdAt) ?? toMillis(v.timestamp) ?? null,
    };
  });

  return NextResponse.json({ items, count: items.length, updatedAt: Date.now() });
}
