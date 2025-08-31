export const runtime = "nodejs";
import { requireAdmin } from "@/app/lib/auth-server";
import { adminDb } from "@/app/lib/firebase-admin";
import { NextResponse } from "next/server";


type Params = { params: { id: string } };

export async function GET(_req: Request, { params }: Params) {
  const gate = await requireAdmin();
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status });

  const doc = await adminDb.collection("kyc_data").doc(params.id).get();
  if (!doc.exists) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return NextResponse.json({ id: doc.id, ...doc.data() });
}
