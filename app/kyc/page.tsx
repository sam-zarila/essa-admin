"use client";

import useSWR from "swr";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { auth } from "@/app/lib/firebase";

async function authedFetcher(url: string) {
  const token = await auth.currentUser?.getIdToken(false);
  const r = await fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

type KycResp = {
  items: Array<{
    id: string;
    title?: string;
    firstName?: string;
    lastName?: string;
    idNumber?: string;
    gender?: string;
    maritalStatus?: string;
    physicalCity?: string;
    mobile?: string;
    email?: string;
    createdAt?: number | null;
  }>;
  latestCreatedAt: number;
  updatedAt: number;
  count: number;
};

export default function KycListPage() {
  const { data, isLoading, error, mutate } = useSWR<KycResp>(
    "/api/admin/kyc?limit=100",
    authedFetcher,
    { refreshInterval: 15000 }
  );

  const items = data?.items || [];
  const latestTs = data?.latestCreatedAt ?? 0;

  // --- unseen badge logic (localStorage) ---
  const [unseen, setUnseen] = useState(0);
  const initRef = useRef(false);

  // On first load, if there's no stored marker, initialize it to current latest to avoid false spike
  useEffect(() => {
    if (!initRef.current && latestTs) {
      initRef.current = true;
      const stored = Number(localStorage.getItem("kycLastSeen") || "0");
      if (!stored) {
        localStorage.setItem("kycLastSeen", String(latestTs));
      }
    }
  }, [latestTs]);

  // Recompute unseen whenever data changes
  useEffect(() => {
    if (!items.length) {
      setUnseen(0);
      return;
    }
    const lastSeen = Number(localStorage.getItem("kycLastSeen") || "0");
    const count = items.filter((k) => (k.createdAt ?? 0) > lastSeen).length;
    setUnseen(count);
  }, [items]);

  function markAllSeen() {
    const ts = latestTs || Date.now();
    localStorage.setItem("kycLastSeen", String(ts));
    setUnseen(0);
  }
type Nameish = { title?: string; firstName?: string; lastName?: string };
  // Pretty name + fallbacks
 const displayName = (k: Partial<Nameish> | null | undefined) =>
  [k?.title, k?.firstName, k?.lastName].filter(Boolean).join(" ") || "—";

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h1 className="text-xl sm:text-2xl font-semibold text-slate-900 relative">
            KYC — Review
            {unseen > 0 && (
              <span className="ml-2 align-middle rounded-full bg-red-600 text-white text-xs px-2 py-0.5">
                {unseen}
              </span>
            )}
          </h1>
          {unseen > 0 && (
            <button
              onClick={markAllSeen}
              className="text-xs text-blue-700 hover:underline"
              title="Mark current KYC as seen"
            >
              mark seen
            </button>
          )}
        </div>
        <button
          onClick={() => mutate()}
          className="rounded-lg border px-3 py-1.5 text-sm hover:bg-slate-50"
        >
          Refresh
        </button>
      </div>

      <div className="mt-4 rounded-2xl border bg-white overflow-hidden">
        {/* Desktop table */}
        <div className="hidden md:block overflow-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-600">
              <tr>
                {["Name", "Gender", "Marital", "City", "Mobile", "Email", ""].map((h) => (
                  <th key={h} className="text-left font-medium p-3">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {isLoading && (
                <tr><td className="p-6 text-center text-slate-500" colSpan={7}>Loading…</td></tr>
              )}
              {error && (
                <tr><td className="p-6 text-center text-rose-600" colSpan={7}>{String((error).message || "Error")}</td></tr>
              )}
              {!isLoading && !error && items.length === 0 && (
                <tr><td className="p-6 text-center text-slate-500" colSpan={7}>No KYC records.</td></tr>
              )}
              {items.map((k) => (
                <tr key={k.id} className="border-t">
                  <td className="p-3">
                    <div className="font-medium text-slate-900">{displayName(k)}</div>
                    <div className="text-xs text-slate-500">{k.idNumber || "—"}</div>
                  </td>
                  <td className="p-3">{k.gender || "—"}</td>
                  <td className="p-3">{k.maritalStatus || "—"}</td>
                  <td className="p-3">{k.physicalCity || "—"}</td>
                  <td className="p-3">{k.mobile || "—"}</td>
                  <td className="p-3">{k.email || "—"}</td>
                  <td className="p-3">
                    <Link href={`/admin/kyc/${k.id}`} className="text-blue-700 hover:underline">
                      View
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Mobile list */}
        <div className="md:hidden divide-y">
          {isLoading && <div className="p-4 text-center text-slate-500">Loading…</div>}
          {error && <div className="p-4 text-center text-rose-600">{String((error).message || "Error")}</div>}
          {!isLoading && !error && items.length === 0 && (
            <div className="p-4 text-center text-slate-500">No KYC records.</div>
          )}
          {items.map((k) => (
            <Link key={k.id} href={`/admin/kyc/${k.id}`} className="block p-4">
              <div className="font-medium text-slate-900">{displayName(k)}</div>
              <div className="text-xs text-slate-500">
                {k.gender || "—"} · {k.maritalStatus || "—"} · {k.physicalCity || "—"}
              </div>
              <div className="text-xs text-slate-500 mt-1">
                {k.mobile || "—"} · {k.email || "—"}
              </div>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
