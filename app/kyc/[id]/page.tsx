// app/admin/kyc/[id]/page.tsx
"use client";

import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { doc, getDoc, Timestamp } from "firebase/firestore";
import { db } from "@/app/lib/firebase"; // from app/admin/kyc/[id]/ to app/lib/firebase

/* ---------------- Types ---------------- */
type FireTimestamp = { seconds: number; nanoseconds?: number };
type TsLike = Timestamp | FireTimestamp | number | string | Date | null | undefined;
type JsonObject = Record<string, unknown>; // <-- added

type KycDoc = {
  title?: unknown;
  firstName?: unknown;
  lastName?: unknown;
  surname?: unknown;

  idNumber?: unknown;
  gender?: unknown;
  dateOfBirth?: unknown;

  email1?: unknown;
  email?: unknown;

  mobileTel1?: unknown;
  mobile?: unknown;

  physicalAddress?: unknown;
  physicalCity?: unknown;
  areaName?: unknown;

  employer?: unknown;
  dependants?: unknown;

  familyName?: unknown;
  familyRelation?: unknown;
  familyMobile?: unknown;

  createdAt?: unknown;
  timestamp?: unknown;

  // alt field names sometimes used on intake
  applicantFirstName?: unknown;
  applicantLastName?: unknown;
};


/* ------------- Helpers (no any) ------------- */
function isFirestoreTs(v: unknown): v is Timestamp {
  return !!v && typeof (v as { toDate?: unknown }).toDate === "function";
}

function toMillis(v: TsLike): number | null {
  try {
    if (!v) return null;
    if (v instanceof Date) return v.getTime();
    if (typeof v === "number") return Number.isFinite(v) ? v : null;
    if (typeof v === "string") {
      const n = Date.parse(v);
      return Number.isFinite(n) ? n : null;
    }
    if (isFirestoreTs(v)) return v.toDate().getTime();
    if (typeof v === "object" && v !== null && "seconds" in v) {
      const s = (v as FireTimestamp).seconds;
      return typeof s === "number" ? Math.round(s * 1000) : null;
    }
  } catch {}
  return null;
}

function fmtMaybeDate(v: TsLike) {
  const ms = toMillis(v);
  return ms ? new Date(ms).toLocaleDateString() : "—";
}

/* ------------- Presentational ------------- */
function fullName(r: { title?: string; firstName?: string; lastName?: string; surname?: string }) {
  const last = r.lastName ?? r.surname;
  return [r.title, r.firstName, last].filter(Boolean).join(" ") || "—";
}

function KV({ label, value }: { label: string; value: ReactNode }) {
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

/* ---------------- Page ---------------- */
export default function KycFullPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();

  const [data, setData] = useState<JsonObject | null>(null); // <-- changed here
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
          setData({ id: snap.id, ...(snap.data() as JsonObject) }); // <-- and here
        }
      } catch (e) {
        if (!alive) return;
        setErr(e ? "Failed to load KYC" : null);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [id]);

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="sticky top-0 z-10 border-b bg-white">
        <div className="max-w-5xl mx-auto h-14 px-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Link href="/admin" className="text-sm text-blue-700 hover:underline">
              ← Back to dashboard
            </Link>
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
                <KV
                  label="Name"
                  value={fullName({
                    title: data?.title as string | undefined,
                    firstName:
                      (data?.firstName as string | undefined) ??
                      (data?.applicantFirstName as string | undefined),
                    lastName:
                      (data?.lastName as string | undefined) ??
                      (data?.surname as string | undefined) ??
                      (data?.applicantLastName as string | undefined),
                  })}
                />
                <KV label="ID Number" value={(data?.idNumber as string) || "—"} />
                <KV label="Gender" value={(data?.gender as string) || "—"} />
                <KV label="Date of Birth" value={fmtMaybeDate(data?.dateOfBirth as TsLike)} />
                <KV
                  label="Email"
                  value={(data?.email1 as string) || (data?.email as string) || "—"}
                />
                <KV
                  label="Mobile"
                  value={(data?.mobileTel1 as string) || (data?.mobile as string) || "—"}
                />
                <KV
                  label="Address / City"
                  value={
                    (data?.physicalAddress as string) ||
                    (data?.physicalCity as string) ||
                    (data?.areaName as string) ||
                    "—"
                  }
                />
                <KV label="Employer" value={(data?.employer as string) || "—"} />
                <KV
                  label="Dependants"
                  value={
                    data?.dependants !== undefined
                      ? String(data.dependants)
                      : "—"
                  }
                />
                <KV
  label="Next of Kin"
  value={`${((data?.familyName as string) || "—")} (${((data?.familyRelation as string) || "—")})${
    (data?.familyMobile as string) ? " · " + (data?.familyMobile as string) : ""
  }`}
/>

                <KV
                  label="Created"
                  value={
                    fmtMaybeDate(data?.createdAt as TsLike) ||
                    fmtMaybeDate(data?.timestamp as TsLike)
                  }
                />
              </div>
            )}
          </div>

          <div className="mt-6 flex items-center gap-2">
            <button
              onClick={() => router.back()}
              className="rounded-lg border px-3 py-1.5 text-sm hover:bg-slate-50"
            >
              Back
            </button>
            <Link
              href="/admin"
              className="rounded-lg bg-blue-600 text-white px-3 py-1.5 text-sm hover:bg-blue-700"
            >
              Go to Dashboard
            </Link>
          </div>
        </div>
      </main>
    </div>
  );
}
