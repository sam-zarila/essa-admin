"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { doc, getDoc, Timestamp } from "firebase/firestore";
import Link from "next/link";
import { db } from "@/app/lib/firebase";
 // from app/admin/kyc/[id]/ to app/lib/firebase

type FireTimestamp = { seconds: number; nanoseconds?: number };

function toMillis(v: any): number | null {
  try {
    if (!v) return null;
    if (v instanceof Date) return v.getTime();
    if (typeof v === "number") return isFinite(v) ? v : null;
    if (typeof v === "string") { const n = Date.parse(v); return isFinite(n) ? n : null; }
    if (typeof v?.toDate === "function") return (v as Timestamp).toDate().getTime();
    if (typeof v === "object" && "seconds" in v) return Math.round((v as FireTimestamp).seconds * 1000);
  } catch {}
  return null;
}
function fmtMaybeDate(v: any) { const ms = toMillis(v); return ms ? new Date(ms).toLocaleDateString() : "—"; }
function fullName(r: { title?: string; firstName?: string; lastName?: string; surname?: string }) {
  const last = r.lastName ?? r.surname;
  return [r.title, r.firstName, last].filter(Boolean).join(" ") || "—";
}
function KV({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <div className="w-40 shrink-0 text-slate-500">{label}</div>
      <div className="text-slate-900">{value}</div>
    </div>
  );
}
function SkeletonLine({ count = 6 }: { count?: number }) {
  return (
    <div className="grid gap-2">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="h-4 w-full rounded bg-slate-200 animate-pulse" />
      ))}
    </div>
  );
}

export default function KycFullPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const snap = await getDoc(doc(db, "kyc_data", String(id)));
        if (!alive) return;
        if (!snap.exists()) {
          setErr("KYC record not found");
        } else {
          setData({ id: snap.id, ...snap.data() });
        }
      } catch (e: any) {
        if (!alive) return;
        setErr(e?.message || "Failed to load KYC");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [id]);

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="sticky top-0 z-10 border-b bg-white">
        <div className="max-w-5xl mx-auto h-14 px-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Link href="/admin" className="text-sm text-blue-700 hover:underline">← Back to dashboard</Link>
            <span className="text-sm text-slate-400">/</span>
            <span className="text-sm text-slate-700">KYC</span>
          </div>
          <div className="text-sm text-slate-500">ID: {id}</div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 py-6">
        <div className="rounded-2xl border bg-white p-4 sm:p-6">
          <h1 className="text-lg font-semibold text-slate-900">Full KYC</h1>

          <div className="mt-4">
            {loading && <SkeletonLine />}
            {err && <div className="text-sm text-rose-600">{err}</div>}
            {!loading && !err && (
              <div className="grid gap-3 text-sm">
                <KV label="Name" value={fullName({
                  title: data?.title,
                  firstName: data?.firstName ?? data?.applicantFirstName,
                  lastName: data?.lastName ?? data?.surname ?? data?.applicantLastName,
                })} />
                <KV label="ID Number" value={data?.idNumber || "—"} />
                <KV label="Gender" value={data?.gender || "—"} />
                <KV label="Date of Birth" value={fmtMaybeDate(data?.dateOfBirth)} />
                <KV label="Email" value={data?.email1 || data?.email || "—"} />
                <KV label="Mobile" value={data?.mobileTel1 || data?.mobile || "—"} />
                <KV label="Address / City" value={data?.physicalAddress || data?.physicalCity || data?.areaName || "—"} />
                <KV label="Employer" value={data?.employer || "—"} />
                <KV label="Dependants" value={String(data?.dependants ?? "—")} />
                <KV label="Next of Kin" value={`${data?.familyName || "—"} (${data?.familyRelation || "—"})${data?.familyMobile ? " · " + data?.familyMobile : ""}`} />
                <KV label="Created" value={fmtMaybeDate(data?.createdAt) || fmtMaybeDate(data?.timestamp)} />
              </div>
            )}
          </div>

          <div className="mt-6 flex items-center gap-2">
            <button onClick={() => router.back()} className="rounded-lg border px-3 py-1.5 text-sm hover:bg-slate-50">
              Back
            </button>
            <Link href="/admin" className="rounded-lg bg-blue-600 text-white px-3 py-1.5 text-sm hover:bg-blue-700">
              Go to Dashboard
            </Link>
          </div>
        </div>
      </main>
    </div>
  );
}
