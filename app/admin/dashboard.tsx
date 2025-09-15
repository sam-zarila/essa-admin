// app/admin/dashboard.tsx
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type React from "react";
import Link from "next/link";
import {
  collection,
  doc as fsDoc,
  getDoc,
  limit as fsLimit,
  onSnapshot,
  orderBy,
  query,
  Timestamp,
  getDocs,
  updateDoc,
  setDoc,
  deleteDoc,
} from "firebase/firestore";
import emailjs from "@emailjs/browser";
import { db } from "../lib/firebase";

/* EmailJS config (env or replace placeholders) */
const EMAILJS_SERVICE_ID = process.env.NEXT_PUBLIC_EMAILJS_SERVICE_ID || "YOUR_SERVICE_ID";
const EMAILJS_TEMPLATE_ID = process.env.NEXT_PUBLIC_EMAILJS_TEMPLATE_ID || "YOUR_TEMPLATE_ID";
const EMAILJS_PUBLIC_KEY  = process.env.NEXT_PUBLIC_EMAILJS_PUBLIC_KEY  || "YOUR_PUBLIC_KEY";

/* =========================================================
   Types
   ========================================================= */
type FireTimestamp = { seconds: number; nanoseconds?: number };

type Loan = {
  id: string;
  title?: string;
  firstName?: string;
  surname?: string;
  mobile?: string;
  areaName?: string;
  loanAmount?: number;
  loanPeriod?: number;
  paymentFrequency?: "weekly" | "monthly";
  currentBalance?: number;
  endDate?: string | number | Date | null;
  status?: "pending" | "approved" | "active" | "overdue" | "closed" | "declined" | string;
  collateralItems?: unknown[];
  loanType?: string;
  timestamp?: Timestamp | FireTimestamp | number | string | Date | null;
};

type ProcessedLoan = {
  id: string;
  applicantFull?: string;
  mobile?: string;
  email?: string;
  area?: string;
  processedStatus: "approved" | "declined";
  processedAt: number | FireTimestamp;
  loanAmount?: number;
  currentBalance?: number;
  period?: number;
  frequency?: "weekly" | "monthly" | string;
  startMs?: number | null;
  endMs?: number | null;
  /** NEW: used for restore + hide */
  original?: any;
  cleared?: boolean;
};

type Totals = {
  outstandingCount?: number;
  outstandingBalanceSum?: number;
  collateralCount?: number;
  finishedCount?: number;
  overdueCount?: number;
};

type Breakdown = {
  status?: Record<string, number>;
  type?: Record<string, number>;
  frequency?: Record<string, number>;
};

type KycRow = {
  id: string;
  firstName?: string;
  lastName?: string;
  mobile?: string;
  createdAt?: number | null;
  email?: string;
  gender?: string;
  physicalCity?: string;
};

/* =========================================================
   Helpers
   ========================================================= */
function isFirestoreTs(v: any): v is Timestamp { return !!v && typeof v.toDate === "function"; }
function toMillis(v: any): number | null {
  try {
    if (!v) return null;
    if (v instanceof Date) return v.getTime();
    if (typeof v === "number") return isFinite(v) ? v : null;
    if (typeof v === "string") { const n = Date.parse(v); return isFinite(n) ? n : null; }
    if (isFirestoreTs(v)) return v.toDate().getTime();
    if (typeof v === "object" && "seconds" in v && typeof v.seconds === "number") return Math.round(v.seconds * 1000);
  } catch {}
  return null;
}
function g(obj: any, path: string) { return path.split(".").reduce((v, k) => (v == null ? v : v[k]), obj); }
function firstDefined<T = any>(...vals: T[]) { for (const v of vals) if (v !== undefined && v !== null && v !== "") return v; }
function extractNameArea(v: any): { first?: string; last?: string; area?: string } {
  const first = firstDefined(v.firstName, v.applicantFirstName, v.givenName, g(v,"name.first"), g(v,"applicant.name.first"))
    || (typeof v?.name === "string" && v.name.trim() ? v.name.trim().split(/\s+/).slice(0, -1).join(" ") : undefined);
  const last  = firstDefined(v.surname, v.lastName, v.applicantLastName, v.familyName, g(v,"name.last"), g(v,"applicant.name.last"))
    || (typeof v?.name === "string" && v.name.trim() ? v.name.trim().split(/\s+/).slice(-1)[0] : undefined);
  const area  = firstDefined(v.areaName, v.physicalCity, v.city, v.addressCity, g(v,"address.city"), g(v,"location.city"), v.town, v.village, v.area, v.district) as string | undefined;
  return { first, last, area };
}
function computeEndDate(ts: any, period?: number, freq?: "weekly" | "monthly"): Date | null {
  const startMs = toMillis(ts);
  if (!startMs || !period || period <= 0) return null;
  const end = new Date(startMs);
  if (freq === "weekly") end.setDate(end.getDate() + period * 7);
  else end.setMonth(end.getMonth() + period);
  return end;
}
function fullName(r: { title?: string; firstName?: string; surname?: string; lastName?: string }) {
  const last = r.surname ?? r.lastName;
  return [r.title, r.firstName, last].filter(Boolean).join(" ") || "—";
}
function fmtDate(d?: string | number | Date | null) { if (!d) return "—"; const date = typeof d === "string"||typeof d === "number"? new Date(d) : d; return isNaN(+date!) ? "—" : date!.toLocaleDateString(); }
function fmtMaybeDate(v: any) { const ms = toMillis(v); return ms ? new Date(ms).toLocaleDateString() : "—"; }
function money(n?: number) { const v = typeof n === "number" && isFinite(n) ? Math.round(n) : 0; try { return new Intl.NumberFormat().format(v); } catch { return String(v); } }
function num(n?: number) { const v = typeof n === "number" && isFinite(n) ? n : 0; try { return new Intl.NumberFormat().format(v); } catch { return String(v); } }
function timeAgo(d: Date) { const s = Math.floor((Date.now()-d.getTime())/1000); if (s<60) return `${s}s ago`; const m=Math.floor(s/60); if(m<60)return`${m}m ago`; const h=Math.floor(m/60); if(h<24)return`${h}h ago`; const days=Math.floor(h/24); return `${days}d ago`; }
function add(obj: Record<string, number>, key: string, inc = 1) { obj[key] = (obj[key] || 0) + inc; }
function sumVals(obj: Record<string, number>) { return Object.values(obj).reduce((s, v) => s + v, 0); }
function normalizeStatus(s?: string) { const k = String(s || "pending").toLowerCase(); if (k==="finished"||k==="complete"||k==="completed") return "closed"; return k; }
function toSegments(map: Record<string, number>, palette: Record<string, string>) { return Object.entries(map).map(([label, value]) => ({ label, value, color: palette[label] || pickColor(label) })); }
function pickColor(seed: string) { const colors=["#0ea5e9","#6366f1","#a855f7","#22c55e","#f59e0b","#ef4444","#14b8a6"]; let h=0; for(let i=0;i<(seed||"").length;i++) h=(h*31+seed.charCodeAt(i))>>>0; return colors[h%colors.length]; }
function conicCSS(data: Array<{ value: number; color: string }>) { const total=Math.max(1,data.reduce((s,d)=>s+d.value,0)); let acc=0; const stops=data.map(d=>{const start=(acc/total)*360; acc+=d.value; const end=(acc/total)*360; return `${d.color} ${start}deg ${end}deg`;}); return `conic-gradient(${stops.join(",")})`; }
function onlyDigits(s?: string) { return (s || "").replace(/\D+/g, ""); }
function phoneKeys(s?: string) { const d=onlyDigits(s); if(!d) return []; const keys=new Set([d]); if(d.startsWith("265")) keys.add(d.slice(3)); if(d.startsWith("0")) keys.add(d.slice(1)); return [...keys]; }
function nameKey(first?: string, last?: string) { const f=(first||"").trim().toLowerCase(); const l=(last||"").trim().toLowerCase(); return f&&l?`${f}|${l}`:""; }
function detectKycId(loan: any): string | undefined {
  const id = firstDefined(loan.kycId, loan.kyc_id, loan.kycID, loan.applicantId, loan.applicant_id, loan.applicantID, loan.userId, loan.uid, loan.customerId, loan.customer_id, g(loan,"customer.id"), g(loan,"applicant.id")) || undefined;
  const ref = firstDefined(g(loan,"kycRef"), g(loan,"applicantRef"));
  if (!id && ref && typeof ref.id === "string") return ref.id;
  return id ? String(id) : undefined;
}
const STATUS_PALETTE: Record<string, string> = { pending:"#f59e0b", approved:"#0ea5e9", active:"#22c55e", overdue:"#ef4444", closed:"#6b7280", declined:"#ef4444", unknown:"#94a3b8" };
const TYPE_PALETTE: Record<string, string> = { business:"#0ea5e9", payroll:"#a855f7", salary:"#6366f1", agriculture:"#22c55e", school:"#f59e0b", unknown:"#94a3b8" };

/* =========================================================
   Page
   ========================================================= */
export default function AdminDashboardPage() {
  /* Loans (active) */
  const [loansRaw, setLoansRaw] = useState<Loan[]>([]);
  const [loansLoading, setLoansLoading] = useState(true);

  const [loansError, setLoansError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);

  useEffect(() => {
    setLoansLoading(true);
    setLoansError(null);
    const loansRef = collection(db, "loan_applications");
    const qy = query(loansRef, orderBy("timestamp", "desc"), fsLimit(200));
    const unsub = onSnapshot(
      qy,
      (snap) => {
        const rows: Loan[] = snap.docs.map((d) => {
          const v = d.data() as any;
          const { first, last, area } = extractNameArea(v);
          const status = normalizeStatus(v.status);
          const paymentFrequency = (v.paymentFrequency ?? v.frequency ?? "monthly") as "weekly" | "monthly";
          const loanPeriod = Number(firstDefined(v.loanPeriod, v.period, v.term, v.tenorMonths, v.tenorWeeks) || 0);
          const startRaw = firstDefined(v.timestamp, v.startDate, v.start_date, v.createdAt, v.created_at, v.loanStartDate);
          const explicitEnd = firstDefined(v.endDate, v.loanEndDate, v.expectedEndDate, v.maturityDate, v.end_date);
          const explicitEndMs = toMillis(explicitEnd);
          const computedEnd = computeEndDate(startRaw, loanPeriod, paymentFrequency);
          return {
            id: d.id,
            firstName: (first ?? "") as string,
            surname: (last ?? "") as string,
            title: v.title ?? "",
            mobile: v.mobileTel ?? v.mobile ?? v.mobileTel1 ?? "",
            loanAmount: Number(v.loanAmount ?? 0),
            currentBalance: Number(v.currentBalance ?? v.loanAmount ?? 0),
            loanPeriod,
            paymentFrequency,
            status,
            timestamp: startRaw ?? null,
            endDate: explicitEndMs ? new Date(explicitEndMs) : computedEnd,
            areaName: (area ?? "") as string,
            collateralItems: Array.isArray(v.collateralItems) ? v.collateralItems : [],
            loanType: String(v.loanType || "unknown").toLowerCase(),
          };
        });
        setLoansRaw(rows);
        setUpdatedAt(Date.now());
        setLoansLoading(false);
      },
      async (err) => {
        console.warn("[loans:onSnapshot] fallback", err);
        try {
          const snap = await getDocs(query(collection(db, "loan_applications"), fsLimit(200)));
          const rows: Loan[] = snap.docs.map((d) => {
            const v = d.data() as any;
            const { first, last, area } = extractNameArea(v);
            const status = normalizeStatus(v.status);
            const paymentFrequency = (v.paymentFrequency ?? v.frequency ?? "monthly") as "weekly" | "monthly";
            const loanPeriod = Number(firstDefined(v.loanPeriod, v.period, v.term, v.tenorMonths, v.tenorWeeks) || 0);
            const startRaw = firstDefined(v.timestamp, v.startDate, v.start_date, v.createdAt, v.created_at, v.loanStartDate);
            const explicitEnd = firstDefined(v.endDate, v.loanEndDate, v.expectedEndDate, v.maturityDate, v.end_date);
            const explicitEndMs = toMillis(explicitEnd);
            const computedEnd = computeEndDate(startRaw, loanPeriod, paymentFrequency);
            return {
              id: d.id,
              firstName: (first ?? "") as string,
              surname: (last ?? "") as string,
              title: v.title ?? "",
              mobile: v.mobileTel ?? v.mobile ?? v.mobileTel1 ?? "",
              loanAmount: Number(v.loanAmount ?? 0),
              currentBalance: Number(v.currentBalance ?? v.loanAmount ?? 0),
              loanPeriod,
              paymentFrequency,
              status,
              timestamp: startRaw ?? null,
              endDate: explicitEndMs ? new Date(explicitEndMs) : computedEnd,
              areaName: (area ?? "") as string,
              collateralItems: Array.isArray(v.collateralItems) ? v.collateralItems : [],
              loanType: String(v.loanType || "unknown").toLowerCase(),
            };
          });
          setLoansRaw(rows);
          setUpdatedAt(Date.now());
          setLoansLoading(false);
        } catch (e: any) {
          setLoansError(e?.message || "Failed to load loans");
          setLoansLoading(false);
        }
      }
    );
    return () => unsub();
  }, []);

  /* KYC (PERMISSIVE: no orderBy so you'll always see docs) */
  const [kycPending, setKycPending] = useState<KycRow[]>([]);
  const [kycLoading, setKycLoading] = useState(true);
  const [kycError, setKycError] = useState<string | null>(null);

  useEffect(() => {
    setKycLoading(true);
    setKycError(null);
    const base = collection(db, "kyc_data");
    // permissive: do not orderBy so we never filter docs out
    const q1 = query(base, fsLimit(500));
    const unsub = onSnapshot(
      q1,
      (snap) => {
        const rows = snap.docs.map((d) => {
          const v = d.data() as any;
          return {
            id: d.id,
            firstName: v.firstName ?? v.applicantFirstName ?? v.givenName ?? "",
            lastName:  v.lastName  ?? v.applicantLastName  ?? v.surname   ?? "",
            mobile:    v.mobileTel1 ?? v.mobile ?? v.phone ?? "",
            email:     v.email1 ?? v.email ?? "",
            gender:    v.gender ?? "",
            physicalCity: v.physicalCity ?? v.areaName ?? v.city ?? "",
            createdAt: toMillis(v.createdAt) ?? toMillis(v.timestamp) ?? toMillis(v.created_at) ?? null,
          } as KycRow;
        });
        rows.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
        setKycPending(rows);
        setKycLoading(false);
      },
      (e) => {
        console.error("[kyc:onSnapshot] error", e);
        setKycError(e?.message || "Failed to load KYC");
        setKycLoading(false);
      }
    );
    return () => unsub();
  }, []);

  /* Enrich loans with KYC */
  const kycIndex = useMemo(() => {
    const byPhone = new Map<string, KycRow>();
    const byName = new Map<string, KycRow>();
    for (const k of kycPending) {
      for (const key of phoneKeys(k.mobile)) byPhone.set(key, k);
      const nk = nameKey(k.firstName, k.lastName);
      if (nk) byName.set(nk, k);
    }
    return { byPhone, byName };
  }, [kycPending]);

  const loans: Loan[] = useMemo(() => {
    return loansRaw.map((l) => {
      const out = { ...l };
      if (!out.firstName || !out.surname || !out.areaName) {
        for (const key of phoneKeys(out.mobile)) {
          const k = kycIndex.byPhone.get(key);
          if (k) {
            out.firstName ||= k.firstName || "";
            out.surname   ||= k.lastName  || "";
            out.areaName  ||= k.physicalCity || "";
            break;
          }
        }
        if (!out.firstName || !out.surname) {
          const k = kycIndex.byName.get(nameKey(out.firstName, out.surname));
          if (k) {
            out.firstName ||= k.firstName || "";
            out.surname   ||= k.lastName  || "";
            out.areaName  ||= k.physicalCity || "";
          }
        }
      }
      if (!out.endDate) out.endDate = computeEndDate(out.timestamp, out.loanPeriod, out.paymentFrequency);
      return out;
    });
  }, [loansRaw, kycIndex]);

  /* ========= Processed collection ========= */
  const [processed, setProcessed] = useState<ProcessedLoan[]>([]);
  const [processedLoading, setProcessedLoading] = useState(true);
  const [processedError, setProcessedError] = useState<string | null>(null);

  useEffect(() => {
    setProcessedLoading(true);
    setProcessedError(null);
    const base = collection(db, "processed_loans");
    const qy = query(base, orderBy("processedAt", "desc"), fsLimit(200));
    const unsub = onSnapshot(
      qy,
      (snap) => {
        const rows: ProcessedLoan[] = snap.docs.map((d) => {
          const v = d.data() as any;
          return {
            id: d.id,
            applicantFull: v.applicantFull || "—",
            mobile: v.mobile || "—",
            email: v.email || "",
            area: v.area || "—",
            processedStatus: v.processedStatus,
            processedAt: v.processedAt ?? Date.now(),
            loanAmount: Number(v.loanAmount || 0),
            currentBalance: Number(v.currentBalance || 0),
            period: Number(v.period || 0),
            frequency: v.frequency || "monthly",
            startMs: toMillis(v.startMs),
            endMs: toMillis(v.endMs),
            original: v.original || null,
            cleared: !!v.cleared,
          };
        });
        setProcessed(rows);
        setProcessedLoading(false);
      },
      (err) => {
        console.warn("[processed:onSnapshot]", err);
        setProcessedError("Failed to load processed loans");
        setProcessedLoading(false);
      }
    );
    return () => unsub();
  }, []);

  /* Derived slices */
  const outstanding = useMemo(
    () => loans.filter((r) => (r.status === "approved" || r.status === "active") && (r.currentBalance ?? 0) > 0)
               .sort((a, b) => (b.currentBalance ?? 0) - (a.currentBalance ?? 0)),
    [loans]
  );
  const outstandingTop = useMemo(() => outstanding.slice(0, 6), [outstanding]);
  const now = useMemo(() => new Date(), [updatedAt]);
  const soon = useMemo(() => new Date((updatedAt ?? Date.now()) + 14*24*60*60*1000), [updatedAt]);

  const deadlinesUpcoming = useMemo(
    () => loans
      .filter(r => {
        const end = r.endDate ? new Date(r.endDate) : null;
        return (r.status==="approved"||r.status==="active") && (r.currentBalance ?? 0) > 0 && end && end >= now && end <= soon;
      })
      .sort((a,b)=> new Date(a.endDate||0).getTime() - new Date(b.endDate||0).getTime())
      .slice(0,8),
    [loans, now, soon]
  );

  const overdueWithCollateral = useMemo(
    () => loans
      .filter(r => {
        const end = r.endDate ? new Date(r.endDate) : null;
        return (r.status==="approved"||r.status==="active") && (r.currentBalance ?? 0) > 0 && end && end < now && (r.collateralItems?.length ?? 0) > 0;
      })
      .sort((a,b)=> new Date(a.endDate||0).getTime() - new Date(b.endDate||0).getTime())
      .slice(0,8),
    [loans, now]
  );

  const finished = useMemo(
    () => loans.filter(r => (r.currentBalance ?? 0) <= 0 || r.status === "closed" || r.status === "finished").slice(0,8),
    [loans]
  );
  const recentApplicants = useMemo(() => loans.slice(0, 8), [loans]);

  const totals: Totals = useMemo(
    () => ({
      outstandingCount: outstanding.length,
      outstandingBalanceSum: outstanding.reduce((s, r) => s + (r.currentBalance || 0), 0),
      collateralCount: loans.reduce((s, r) => s + (r.collateralItems?.length ?? 0), 0),
      finishedCount: finished.length,
      overdueCount: loans.filter(r => { const end = r.endDate ? new Date(r.endDate) : null; return end && end < now && (r.currentBalance ?? 0) > 0; }).length,
    }),
    [loans, outstanding, finished, now]
  );

  const breakdown: Breakdown = useMemo(() => {
    const status: Record<string, number> = {};
    const type: Record<string, number> = {};
    const frequency: Record<string, number> = {};
    loans.forEach((r) => {
      add(status, normalizeStatus(r.status));
      add(type, String(r.loanType || "unknown").toLowerCase());
      add(frequency, String(r.paymentFrequency || "monthly"));
    });
    return { status, type, frequency };
  }, [loans]);

  /* KYC badge */
  const [kycNewCount, setKycNewCount] = useState(0);
  useEffect(() => {
    const LAST_KEY = "kyc_seen_at";
    const lastSeen = Number(localStorage.getItem(LAST_KEY) || "0");
    if (!kycPending.length) { setKycNewCount(0); return; }
    const count = kycPending.reduce((acc, r) => acc + ((typeof r.createdAt === "number" ? r.createdAt : 0) > lastSeen ? 1 : 0), 0);
    setKycNewCount(count);
  }, [kycPending]);
  function markKycSeen() { localStorage.setItem("kyc_seen_at", String(Date.now())); setKycNewCount(0); }

  /* Modals */
  const [viewKycId, setViewKycId] = useState<string | null>(null);
  const [viewLoanId, setViewLoanId] = useState<string | null>(null);

  /* Actions for PROCESSED list */
  async function considerBackToActive(p: ProcessedLoan) {
    // Build payload to restore
    const original = (p as any)?.original;
    let payload: any;
    if (original && typeof original === "object" && Object.keys(original).length) {
      payload = original; // exact original doc
    } else {
      // Fallback reconstruction
      const nameParts = (p.applicantFull || "").trim().split(/\s+/);
      payload = {
        title: "",
        firstName: nameParts.length > 1 ? nameParts.slice(0, -1).join(" ") : nameParts[0] || "",
        surname: nameParts.length > 1 ? nameParts.slice(-1)[0] : "",
        mobile: p.mobile || "",
        email: p.email || "",
        areaName: p.area || "",
        loanAmount: p.loanAmount ?? p.currentBalance ?? 0,
        currentBalance: p.currentBalance ?? p.loanAmount ?? 0,
        loanPeriod: p.period ?? 0,
        paymentFrequency: (p.frequency || "monthly").toString().toLowerCase(),
        timestamp: p.startMs ? new Date(p.startMs) : new Date(),
        endDate: p.endMs ? new Date(p.endMs) : null,
        status: p.processedStatus === "approved" ? "approved" : "pending",
        loanType: "unknown",
      };
    }

    try {
      await setDoc(fsDoc(db, "loan_applications", p.id), payload, { merge: false });
      await deleteDoc(fsDoc(db, "processed_loans", p.id));
    } catch (e: any) {
      alert(`Failed to restore: ${e?.message || e}`);
    }
  }

  async function clearProcessed(p: ProcessedLoan) {
    try {
      await updateDoc(fsDoc(db, "processed_loans", p.id), { cleared: true, clearedAt: Date.now() });
    } catch (e: any) {
      alert(`Failed to clear: ${e?.message || e}`);
    }
  }

  async function deleteProcessedForever(p: ProcessedLoan) {
    try {
      await deleteDoc(fsDoc(db, "processed_loans", p.id));
    } catch (e: any) {
      alert(`Failed to delete: ${e?.message || e}`);
    }
  }

  /* Header & KPIs */
  const lastUpdated = updatedAt ? timeAgo(new Date(updatedAt)) : loansLoading ? "—" : "a moment ago";
  const cards = [
    { label: "Outstanding Loans", value: num(totals.outstandingCount), sub: "Active with balance", icon: IconClipboard, tint: "from-amber-500 to-amber-600" },
    { label: "Outstanding Balance", value: "MWK " + money(totals.outstandingBalanceSum || 0), sub: "Sum of balances", icon: IconCash, tint: "from-rose-500 to-rose-600" },
    { label: "Collateral Items", value: num(totals.collateralCount), sub: "Across loans", icon: IconShield, tint: "from-indigo-500 to-indigo-600" },
    { label: "Finished Repayments", value: num(totals.finishedCount), sub: "Recently closed", icon: IconCheck, tint: "from-emerald-500 to-emerald-600" },
  ];

  return (
    <div className="min-h-screen w-full bg-slate-50">
      {/* Header */}
      <header className="sticky top-0 z-20 border-b bg-white/90 backdrop-blur supports-[backdrop-filter]:bg-white/60">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="h-9 w-9 rounded-lg bg-gradient-to-br from-blue-600 to-indigo-600 text-white grid place-items-center font-semibold">EL</div>
            <div>
              <h1 className="text-base sm:text-lg font-semibold text-slate-900">ESSA Loans — Admin Dashboard</h1>
              <div className="text-xs text-slate-500">Updated {lastUpdated}</div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => setUpdatedAt(Date.now())} className="inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm hover:bg-slate-50" title="Refresh">
              <IconRefresh className="h-4 w-4" />
              Refresh
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-8">
        {/* KPIs */}
        <section>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {cards.map((c) => (<KPICard key={c.label} {...c} value={loansLoading ? undefined : c.value} />))}
          </div>
        </section>

        {/* Loan Detailed Overview */}
        <section className="rounded-2xl border bg-white p-4 sm:p-6">
          <div className="flex items-center justify-between">
            <h2 className="text-base sm:text-lg font-semibold text-slate-900">Loan Detailed Overview</h2>
          </div>

          <div className="mt-4 grid gap-4 lg:grid-cols-3">
            <div className="rounded-xl border p-4">
              <h3 className="font-medium text-slate-800">By Status</h3>
              <MiniDonut isLoading={loansLoading} data={toSegments(breakdown.status || {}, STATUS_PALETTE)} centerLabel="Loans" />
              <Legend items={Object.entries(breakdown.status || {})} />
            </div>
            <div className="rounded-xl border p-4">
              <h3 className="font-medium text-slate-800">By Type</h3>
              <MiniDonut isLoading={loansLoading} data={toSegments(breakdown.type || {}, TYPE_PALETTE)} centerLabel="Types" />
              <Legend items={Object.entries(breakdown.type || {})} />
            </div>
            <div className="grid gap-4">
              <div className="rounded-xl border p-4">
                <h3 className="font-medium text-slate-800">By Payment Frequency</h3>
                <BarRow label="Monthly" value={(breakdown.frequency || {})["monthly"] || 0} total={sumVals(breakdown.frequency || {})} />
                <BarRow label="Weekly" value={(breakdown.frequency || {})["weekly"] || 0} total={sumVals(breakdown.frequency || {})} />
              </div>
              <div className="rounded-xl border p-4">
                <h3 className="font-medium text-slate-800">Top Areas</h3>
                <ul className="mt-2 grid gap-2">
                  {loansLoading && <SkeletonLine count={5} />}
                  {!loansLoading &&
                    Object.entries(loans.reduce<Record<string, number>>((m, r) => (add(m, r.areaName || "—"), m), {}))
                      .sort((a, b) => b[1] - a[1])
                      .slice(0, 6)
                      .map(([name, count]) => (
                        <li key={name} className="flex items-center justify-between text-sm">
                          <span className="text-slate-700">{name}</span>
                          <span className="rounded-full bg-slate-50 px-2 py-0.5 text-slate-700 border">{num(count)}</span>
                        </li>
                      ))}
                </ul>
              </div>
            </div>
          </div>
        </section>

        {/* Main content */}
        <div className="grid gap-4 xl:grid-cols-2">
          <Section title="Outstanding loans (top 6)">
            <ResponsiveTable
              isLoading={loansLoading}
              emptyText="No outstanding loans."
              headers={["Applicant", "Balance", "Period", "Area", "End date", ""]}
              rows={outstandingTop.map((r) => [
                <CellPrimary key="a" title={fullName(r)} subtitle={r.mobile || "—"} />,
                <span key="b" className="font-medium text-slate-900">MWK {money(r.currentBalance || 0)}</span>,
                <span key="c" className="text-slate-700">{r.loanPeriod} {r.paymentFrequency === "weekly" ? "wk" : "mo"}</span>,
                <span key="d" className="text-slate-700">{r.areaName || "—"}</span>,
                <span key="e" className="text-slate-700">{fmtDate(r.endDate as any)}</span>,
                <button key="f" onClick={() => setViewLoanId(r.id)} className="inline-flex items-center gap-1 text-blue-700 hover:underline">
                  View <IconArrowRight className="h-3.5 w-3.5" />
                </button>,
              ])}
            />
          </Section>

          <Section title="Deadlines in next 14 days">
            <ListCards
              isLoading={loansLoading}
              emptyText="No deadlines in the next 14 days."
              items={deadlinesUpcoming.map((r) => ({
                title: fullName(r),
                chips: [`MWK ${money(r.currentBalance || 0)}`, `${r.loanPeriod}${r.paymentFrequency === "weekly" ? "wk" : "mo"}`],
                meta: `${fmtDate(r.endDate as any)} · ${r.areaName || "—"}`,
                onClick: () => setViewLoanId(r.id),
              }))}
            />
          </Section>

          <Section title="Due for collateral (overdue)">
            <ListCards
              isLoading={loansLoading}
              emptyText="No overdue loans with collateral."
              items={overdueWithCollateral.map((r) => ({
                title: fullName(r),
                chips: [`MWK ${money(r.currentBalance || 0)}`, `${r.collateralItems?.length || 0} item(s)`],
                meta: `Overdue since ${fmtDate(r.endDate as any)} · ${r.areaName || "—"}`,
                onClick: () => setViewLoanId(r.id),
              }))}
            />
          </Section>

          <Section title="Finished repayments">
            <ListCards
              isLoading={loansLoading}
              emptyText="No recent finishes."
              items={finished.map((r) => ({
                title: fullName(r),
                chips: ["Paid", `${r.loanPeriod}${r.paymentFrequency === "weekly" ? "wk" : "mo"}`],
                meta: r.areaName || "—",
                onClick: () => setViewLoanId(r.id),
              }))}
            />
          </Section>

          {/* KYC */}
          <Section
            title={
              <div className="flex items-center gap-2">
                <span>KYC to review</span>
                {kycNewCount > 0 && (
                  <span className="inline-flex items-center justify-center h-5 min-w-[20px] rounded-full bg-rose-600 text-white text-xs px-1">{kycNewCount}</span>
                )}
              </div>
            }
            extra={
              <button onClick={markKycSeen} className="rounded-lg bg-blue-600 text-white px-2.5 py-1 text-xs hover:bg-blue-700" title="Reset new counter">
                Mark seen
              </button>
            }
          >
            <div className="grid gap-2">
              {kycLoading && <SkeletonLine count={3} />}
              {kycError && <div className="text-sm text-rose-600">Failed to load KYC.</div>}
              {!kycLoading && !kycError && kycPending.length === 0 && <div className="text-center text-slate-500">Nothing pending.</div>}
              {!kycLoading && !kycError &&
                kycPending.map((k) => (
                  <div key={k.id} className="rounded-xl border bg-white p-3 flex items-start justify-between gap-2">
                    <div>
                      <div className="font-medium text-slate-900">{fullName({ firstName: k.firstName, lastName: k.lastName })}</div>
                      <div className="text-xs text-slate-500 mt-0.5">{k.createdAt ? new Date(k.createdAt).toLocaleString() : "—"}</div>
                      <div className="text-xs text-slate-600 mt-1">{(k.mobile || "—")}{k.email ? ` · ${k.email}` : ""}</div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Link href={`/admin/kyc/${k.id}`} className="rounded-lg border px-2.5 py-1.5 text-xs hover:bg-slate-50">Open page</Link>
                      <button onClick={() => setViewKycId(k.id)} className="rounded-lg bg-blue-600 text-white px-2.5 py-1.5 text-xs hover:bg-blue-700">View KYC</button>
                    </div>
                  </div>
                ))}
            </div>
            <KycPreviewModal kycId={viewKycId} onClose={() => setViewKycId(null)} />
          </Section>

          {/* ========= Processed ========= */}
          <Section title="Processed">
            <div className="grid gap-2">
              {processedLoading && <SkeletonLine count={3} />}
              {processedError && <div className="text-sm text-rose-600">{processedError}</div>}
              {!processedLoading && !processedError && processed.filter(p => !p.cleared).length === 0 && (
                <div className="text-center text-slate-500">No processed records yet.</div>
              )}
              {!processedLoading && !processedError && processed
                .filter(p => !p.cleared)
                .map((p) => {
                  const chips = [
                    p.processedStatus === "approved" ? "Accepted" : "Declined",
                    `MWK ${money(p.currentBalance ?? p.loanAmount ?? 0)}`
                  ];
                  const meta = `${p.area || "—"} · ${p.processedAt ? new Date(toMillis(p.processedAt) || 0).toLocaleString() : ""}`;
                  return (
                    <div key={p.id} className="rounded-xl border bg-white p-3 flex items-start justify-between gap-2">
                      <div>
                        <div className="font-medium text-slate-900">{p.applicantFull || "—"}</div>
                        <div className="text-xs text-slate-600 mt-0.5">{p.mobile || "—"}{p.email ? ` · ${p.email}` : ""}</div>
                        <div className="mt-1 flex flex-wrap gap-1">
                          {chips.map((c) => (
                            <span key={c} className="inline-flex items-center rounded-full px-2 py-0.5 text-xs border bg-slate-50 text-slate-700">
                              {c}
                            </span>
                          ))}
                        </div>
                        <div className="text-xs text-slate-500 mt-1">{meta}</div>
                      </div>

                      <div className="flex items-center gap-2">
                        {/* CONSIDER (restore) */}
                        <button
                          onClick={async () => {
                            if (!confirm("Move back to Active (loan_applications)?")) return;
                            await considerBackToActive(p);
                          }}
                          className="rounded-lg bg-amber-600 text-white px-2.5 py-1.5 text-xs hover:bg-amber-700"
                          title="Restore to active"
                        >
                          Consider
                        </button>

                        {/* CLEAR (hide) */}
                        <button
                          onClick={async () => {
                            if (!confirm("Hide this record from Processed (not deleted)?")) return;
                            await clearProcessed(p);
                          }}
                          className="rounded-lg border px-2.5 py-1.5 text-xs hover:bg-slate-50"
                          title="Hide from list (not deleted)"
                        >
                          Clear
                        </button>

                        {/* DELETE FOREVER */}
                        <button
                          onClick={async () => {
                            if (!confirm("Delete this processed record forever?")) return;
                            await deleteProcessedForever(p);
                          }}
                          className="rounded-lg bg-rose-600 text-white px-2.5 py-1.5 text-xs hover:bg-rose-700"
                          title="Delete forever"
                        >
                          Delete forever
                        </button>
                      </div>
                    </div>
                  );
                })}
            </div>
          </Section>

          <Section title="Recent applicants">
            <ListCards
              isLoading={loansLoading}
              emptyText="No recent applications."
              items={recentApplicants.map((r) => ({
                title: fullName(r),
                chips: [`MWK ${money(r.loanAmount || 0)}`, String(r.status ?? "—")],
                meta: r.timestamp ? new Date(toMillis(r.timestamp) || 0).toLocaleString() : "",
                onClick: () => setViewLoanId(r.id),
              }))}
            />
          </Section>
        </div>

        {(loansError || kycError) && (
          <div className="text-center text-xs text-rose-600 pt-2">{loansError || kycError}</div>
        )}
      </main>

      <LoanPreviewModal loanId={viewLoanId} onClose={() => setViewLoanId(null)} />
    </div>
  );
}

/* =========================================================
   Loan Preview Modal (moves to processed on Accept/Decline)
   ========================================================= */
function LoanPreviewModal({ loanId, onClose }: { loanId: string | null; onClose: () => void; }) {
  const [data, setData] = useState<any>(null);
  const [loanRaw, setLoanRaw] = useState<any>(null); // raw loan for copy
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<"accept" | "decline" | "notify" | null>(null);
  const [notifyOpen, setNotifyOpen] = useState(false);
  const mounted = useRef(false);

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!loanId) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [loanId, onClose]);

  useEffect(() => {
    if (!loanId) return;
    (async () => {
      setLoading(true); setErr(null); setData(null);
      try {
        const loanSnap = await getDoc(fsDoc(db, "loan_applications", loanId));
        if (!mounted.current) return;
        if (!loanSnap.exists()) throw new Error("Loan not found");
        const lr: any = { id: loanSnap.id, ...loanSnap.data() };
        setLoanRaw(lr);

        let kycRaw: any = null;
        const kycId = detectKycId(lr);
        if (kycId) {
          try {
            const kycSnap = await getDoc(fsDoc(db, "kyc_data", String(kycId)));
            if (kycSnap.exists()) kycRaw = { id: kycSnap.id, ...kycSnap.data() };
          } catch {}
        }

        const merged = { ...lr, kyc: kycRaw || {} };

        const first = firstDefined(merged.firstName, merged.applicantFirstName, merged.givenName, g(merged,"name.first"), g(merged,"applicant.name.first"), g(merged,"kyc.firstName"), g(merged,"kyc.applicantFirstName"), g(merged,"kyc.givenName"), g(merged,"kyc.name.first"))
          || (typeof merged.name === "string" ? merged.name.split(/\s+/).slice(0, -1).join(" ") : undefined);
        const last = firstDefined(merged.surname, merged.lastName, merged.applicantLastName, merged.familyName, g(merged,"name.last"), g(merged,"applicant.name.last"), g(merged,"kyc.surname"), g(merged,"kyc.lastName"), g(merged,"kyc.applicantLastName"), g(merged,"kyc.familyName"), g(merged,"kyc.name.last"))
          || (typeof merged.name === "string" ? merged.name.split(/\s+/).slice(-1)[0] : undefined);
        const applicantFull = [merged.title, first, last].filter(Boolean).join(" ") || "—";

        const mobile = firstDefined(merged.mobileTel, merged.mobileTel1, merged.mobile, merged.phone, merged.phoneNumber, g(merged,"contact.phone"), g(merged,"contact.mobile"), g(merged,"kyc.mobileTel1"), g(merged,"kyc.mobile"), g(merged,"kyc.phone"), g(merged,"kyc.phoneNumber")) || "—";
        const email  = firstDefined(merged.email, g(merged,"contact.email"), g(merged,"kyc.email1"), g(merged,"kyc.email")) || "";
        const area   = firstDefined(merged.areaName, merged.physicalCity, merged.city, merged.addressCity, g(merged,"address.city"), g(merged,"location.city"), merged.town, merged.village, g(merged,"kyc.physicalCity"), g(merged,"kyc.areaName")) || "—";

        const rawStatus = firstDefined(merged.status, merged.loanStatus, merged.applicationStatus, merged.state, g(merged,"kyc.status"));
        const status = ((): string => {
          const s = typeof rawStatus === "string" ? rawStatus.toLowerCase() : rawStatus;
          if (s === "finished" || s === "complete" || s === "completed") return "closed";
          return s || "pending";
        })();

        const startRaw = firstDefined(merged.timestamp, merged.startDate, merged.start_date, merged.createdAt, merged.created_at, g(merged,"kyc.timestamp"), g(merged,"kyc.createdAt"));
        const explicitEnd = firstDefined(merged.endDate, merged.loanEndDate, merged.expectedEndDate, merged.maturityDate, merged.end_date, g(merged,"kyc.endDate"));
        let endMs = toMillis(explicitEnd);
        if (!endMs) {
          const periodRaw = firstDefined(merged.loanPeriod, merged.period, merged.term, merged.tenorMonths, merged.tenorWeeks);
          const freqRaw   = firstDefined(merged.paymentFrequency, merged.frequency, merged.repaymentFrequency);
          const freq = String(freqRaw || "monthly").toLowerCase() as "weekly" | "monthly";
          const period = Number(periodRaw || 0);
          endMs = computeEndDate(startRaw, period, freq)?.getTime() ?? null;
        }

        const view = {
          id: merged.id,
          applicantFull, mobile, email, status, area,
          loanAmount: Number(firstDefined(merged.loanAmount, 0)),
          currentBalance: Number(firstDefined(merged.currentBalance, merged.loanAmount, 0)),
          period: Number(firstDefined(merged.loanPeriod, merged.period, 0)),
          frequency: String(firstDefined(merged.paymentFrequency, merged.frequency, "monthly")).toLowerCase(),
          startMs: toMillis(startRaw),
          endMs: endMs || null,
          collateralItems: Array.isArray(merged.collateralItems) ? merged.collateralItems : [],
        };
        if (mounted.current) setData(view);
      } catch (e: any) {
        if (mounted.current) setErr(e?.message || "Failed to load loan");
      } finally {
        if (mounted.current) setLoading(false);
      }
    })();
  }, [loanId]);

  if (!loanId) return null;

  const endDate = data?.endMs ? new Date(data.endMs).toLocaleDateString() : "—";
  const startStr = data?.startMs ? new Date(data.startMs).toLocaleString() : "—";

  async function moveToProcessed(next: "approved" | "declined") {
    if (!loanId || !data) return;
    const busyKey = next === "approved" ? "accept" : "decline";
    setBusy(busyKey);
    try {
      try { await updateDoc(fsDoc(db, "loan_applications", loanId), { status: next }); } catch {}

      const processedDoc: ProcessedLoan & Record<string, any> = {
        id: loanId,
        applicantFull: data.applicantFull || "—",
        mobile: data.mobile || "",
        email: data.email || "",
        area: data.area || "—",
        processedStatus: next,
        processedAt: Date.now(),
        loanAmount: data.loanAmount ?? 0,
        currentBalance: data.currentBalance ?? data.loanAmount ?? 0,
        period: data.period ?? 0,
        frequency: data.frequency ?? "monthly",
        startMs: data.startMs ?? null,
        endMs: data.endMs ?? null,
        original: loanRaw || {},
        cleared: false,
      };

      await setDoc(fsDoc(db, "processed_loans", loanId), processedDoc);
      await deleteDoc(fsDoc(db, "loan_applications", loanId));
      onClose();
    } catch (e: any) {
      alert(`Failed to move to processed: ${e?.message || e}`);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="fixed inset-0 z-40">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="absolute inset-x-0 top-10 mx-auto w-[94%] max-w-2xl">
        <div className="rounded-2xl border bg-white shadow-xl">
          <div className="flex items-center justify-between p-4 border-b">
            <h3 className="text-base font-semibold text-slate-900">Loan Preview</h3>
            <button onClick={onClose} className="rounded-lg border px-2 py-1 text-sm hover:bg-slate-50">Close</button>
          </div>

          <div className="p-4">
            {loading && <SkeletonLine count={6} />}
            {err && <div className="text-rose-600 text-sm">Failed to load: {err}</div>}
            {!loading && !err && data && (
              <div className="grid gap-3 text-sm">
                <KV label="Applicant" value={data.applicantFull || "—"} />
                <KV label="Mobile" value={data.mobile || "—"} />
                <KV label="Email" value={data.email || "—"} />
                <KV label="Status" value={String(data.status || "—")} />
                <KV label="Area" value={data.area || "—"} />
                <KV label="Loan Amount" value={`MWK ${money(data.loanAmount)}`} />
                <KV label="Current Balance" value={`MWK ${money(data.currentBalance)}`} />
                <KV label="Period" value={`${data.period} ${data.frequency === "weekly" ? "wk" : "mo"}`} />
                <KV label="Start" value={startStr} />
                <KV label="End" value={endDate} />

                {Array.isArray(data.collateralItems) && data.collateralItems.length > 0 && (
                  <div>
                    <div className="text-slate-500 mb-1">Collateral</div>
                    <div className="flex flex-wrap gap-2">
                      {data.collateralItems.map((it: any, i: number) => {
                        const label = typeof it === "string" ? it : JSON.stringify(it);
                        const color = pickColor(label);
                        return (
                          <span key={i} className="inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium border" style={{ borderColor: color, color }} title={label}>
                            {label}
                          </span>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="p-4 border-t flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <button
                disabled={busy === "accept"}
                onClick={() => moveToProcessed("approved")}
                className="inline-flex items-center rounded-lg bg-emerald-600 text-white px-3 py-1.5 text-sm hover:bg-emerald-700 disabled:opacity-60"
                title="Approve and move to Processed"
              >
                {busy === "accept" ? "Processing…" : "Accept"}
              </button>
              <button
                disabled={busy === "decline"}
                onClick={() => moveToProcessed("declined")}
                className="inline-flex items-center rounded-lg bg-rose-600 text-white px-3 py-1.5 text-sm hover:bg-rose-700 disabled:opacity-60"
                title="Decline and move to Processed"
              >
                {busy === "decline" ? "Processing…" : "Decline"}
              </button>
              <button
                onClick={() => setNotifyOpen(true)}
                className="inline-flex items-center rounded-lg bg-blue-600 text-white px-3 py-1.5 text-sm hover:bg-blue-700"
                title="Notify client via Email"
              >
                Notify
              </button>
            </div>

            <button onClick={onClose} className="inline-flex items-center rounded-lg bg-green-600 text-white border px-3 py-1.5 text-sm hover:bg-green-700">
              Done
            </button>
          </div>
        </div>
      </div>

      {/* Notify modal */}
      {notifyOpen && data && (
        <NotifyEmailModal
          onClose={() => setNotifyOpen(false)}
          defaultToEmail={data.email || ""}
          defaultToName={data.applicantFull || ""}
          defaultSubject=""
          defaultMessage=""
        />
      )}
    </div>
  );
}

/* =========================================================
   NotifyEmailModal (EmailJS)
   ========================================================= */
function NotifyEmailModal({
  onClose, defaultToEmail, defaultToName, defaultSubject, defaultMessage,
}: { onClose: () => void; defaultToEmail: string; defaultToName: string; defaultSubject: string; defaultMessage: string; }) {
  const [toEmail, setToEmail] = useState(defaultToEmail);
  const [toName, setToName] = useState(defaultToName);
  const [subject, setSubject] = useState(defaultSubject);
  const [message, setMessage] = useState(defaultMessage);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState(false);

  async function sendEmail(e: React.FormEvent) {
    e.preventDefault();
    setError(null); setOk(false);
    if (!EMAILJS_SERVICE_ID || !EMAILJS_TEMPLATE_ID || !EMAILJS_PUBLIC_KEY) {
      setError("EmailJS keys are not configured."); return;
    }
    if (!toEmail) { setError("Recipient email is required."); return; }
    if (!subject) { setError("Subject is required."); return; }
    if (!message) { setError("Message is required."); return; }

    setSending(true);
    try {
      await emailjs.send(
        EMAILJS_SERVICE_ID,
        EMAILJS_TEMPLATE_ID,
        { to_email: toEmail, to_name: toName || "Customer", subject, message },
        { publicKey: EMAILJS_PUBLIC_KEY }
      );
      setOk(true);
    } catch (e: any) {
      setError(e?.text || e?.message || "Failed to send email.");
    } finally { setSending(false); }
  }

  return (
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="absolute inset-x-0 top-16 mx-auto w-[94%] max-w-md">
        <form onSubmit={sendEmail} className="rounded-2xl border bg-white shadow-xl overflow-hidden">
          <div className="p-4 border-b flex items-center justify-between">
            <h4 className="font-semibold text-slate-900 ">Notify Client</h4>
            <button type="button" onClick={onClose} className="rounded-lg bg-red-600 text-white border px-2 py-1 text-sm hover:bg-red-700">Close</button>
          </div>
          <div className="p-4 grid gap-3">
            {ok && <div className="rounded-md bg-emerald-50 border border-emerald-200 text-emerald-800 text-sm px-3 py-2">Email sent successfully.</div>}
            {error && <div className="rounded-md bg-rose-50 border border-rose-200 text-rose-800 text-sm px-3 py-2">{error}</div>}

            <label className="grid gap-1 text-sm">
              <span className="text-slate-700">To (email)</span>
              <input
                value={toEmail}
                onChange={(e) => setToEmail(e.target.value)}
                type="email"
                className="rounded-lg border px-3 py-2 placeholder:text-black placeholder:opacity-100"
                placeholder="client@example.com"
                required
              />
            </label>

            <label className="grid gap-1 text-sm">
              <span className="text-slate-700">Recipient name</span>
              <input value={toName} onChange={(e) => setToName(e.target.value)} type="text" className="rounded-lg border px-3 py-2 placeholder:text-black placeholder:opacity-100" placeholder="Client name" />
            </label>

            <label className="grid gap-1 text-sm">
              <span className="text-slate-700">Subject</span>
              <input value={subject} onChange={(e) => setSubject(e.target.value)} type="text" className="rounded-lg border px-3 py-2 placeholder:text-black placeholder:opacity-100" placeholder="e.g. Update on your ESSA loan" required />
            </label>

            <label className="grid gap-1 text-sm">
              <span className="text-slate-700">Message</span>
              <textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={6} className="rounded-lg border px-3 py-2 placeholder:text-black placeholder:opacity-100" placeholder="Type your message…" required />
            </label>
          </div>

          <div className="p-4 border-t flex items-center justify-end gap-2">
            <button type="button" onClick={onClose} className="rounded-lg bg-red-600 text-white border px-3 py-1.5 text-sm hover:bg-red-700">Cancel</button>
            <button type="submit" disabled={sending} className="rounded-lg bg-blue-600 text-white px-3 py-1.5 text-sm hover:bg-blue-700 disabled:opacity-60">
              {sending ? "Sending…" : "Send Email"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/* =========================================================
   KYC Preview Modal
   ========================================================= */
function KycPreviewModal({ kycId, onClose }: { kycId: string | null; onClose: () => void; }) {
  const [data, setData] = useState<any>(null);
  const [isLoading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const mounted = useRef(false);

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!kycId) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [kycId, onClose]);

  useEffect(() => {
    if (!kycId) return;
    setLoading(true); setErr(null); setData(null);
    (async () => {
      try {
        const snap = await getDoc(fsDoc(db, "kyc_data", kycId));
        if (!mounted.current) return;
        if (!snap.exists()) throw new Error("Record not found");
        setData({ id: snap.id, ...snap.data() });
        setLoading(false);
      } catch (e: any) {
        if (!mounted.current) return;
        setErr(e?.message || "Failed to load KYC");
        setLoading(false);
      }
    })();
  }, [kycId]);

  if (!kycId) return null;

  return (
    <div className="fixed inset-0 z-40">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="absolute inset-x-0 top-10 mx-auto w-[94%] max-w-2xl">
        <div className="rounded-2xl border bg-white shadow-xl">
          <div className="flex items-center justify-between p-4 border-b">
            <h3 className="text-base font-semibold text-slate-900">KYC Preview</h3>
            <button onClick={onClose} className="rounded-lg border px-2 py-1 text-sm hover:bg-slate-50">Close</button>
          </div>
          <div className="p-4">
            {isLoading && <SkeletonLine count={6} />}
            {err && <div className="text-rose-600 text-sm">Failed to load KYC: {err}</div>}
            {!isLoading && !err && (
              <div className="grid gap-2 text-sm">
                <KV
                  label="Name"
                  value={[data?.title, data?.firstName ?? data?.applicantFirstName, data?.lastName ?? data?.surname ?? data?.applicantLastName].filter(Boolean).join(" ") || "—"}
                />
                <KV label="ID Number" value={data?.idNumber || "—"} />
                <KV label="Gender" value={data?.gender || "—"} />
                <KV label="Date of Birth" value={fmtMaybeDate(data?.dateOfBirth)} />
                <KV label="Email" value={data?.email1 || data?.email || "—"} />
                <KV label="Mobile" value={data?.mobileTel1 || data?.mobile || "—"} />
                <KV label="Address / City" value={data?.physicalAddress || data?.physicalCity || data?.areaName || "—"} />
                <KV label="Employer" value={data?.employer || "—"} />
                <KV label="Dependants" value={String(data?.dependants ?? "—")} />
                <KV label="Next of Kin" value={`${data?.familyName || "—"} (${data?.familyRelation || "—"})${data?.familyMobile ? " · " + data?.familyMobile : ""}`} />
              </div>
            )}
          </div>
          <div className="p-4 border-t text-right">
            <Link href={`/admin/kyc/${kycId}`} className="inline-flex items-center rounded-lg bg-blue-600 text-white px-3 py-1.5 text-sm hover:bg-blue-700">
              Open Full KYC
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}

/* =========================================================
   UI bits
   ========================================================= */
function KPICard({
  label, value, sub, icon: Icon, tint,
}: {
  label: string; value?: string | number; sub: string;
  icon: React.ComponentType<React.SVGProps<SVGSVGElement>>; tint: string;
}) {
  return (
    <div className="rounded-2xl border bg-white p-4 shadow-sm">
      <div className="flex items-start justify-between">
        <div className="text-sm text-slate-600">{label}</div>
        <div className={`h-9 w-9 shrink-0 rounded-lg bg-gradient-to-br ${tint} text-white grid place-items-center`}>
          <Icon className="h-4 w-4" />
        </div>
      </div>
      <div className="mt-1">
        {value === undefined ? <div className="h-7 w-32 rounded-md bg-slate-200 animate-pulse" /> :
          <div className="text-2xl sm:text-3xl font-bold tabular-nums">{value}</div>}
      </div>
      <div className="mt-1 text-xs text-slate-500">{sub}</div>
    </div>
  );
}

function Section({ title, extra, children }: { title: React.ReactNode; extra?: React.ReactNode; children: React.ReactNode; }) {
  return (
    <section className="rounded-2xl border bg-white p-4 sm:p-5">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-slate-900">{title}</h2>
        {extra}
      </div>
      <div className="mt-3">{children}</div>
    </section>
  );
}

function ResponsiveTable({ isLoading, emptyText, headers, rows }: { isLoading: boolean; emptyText: string; headers: string[]; rows: React.ReactNode[][]; }) {
  return (
    <>
      <div className="hidden md:block overflow-auto rounded-xl border">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-600 sticky top-0">
            <tr>{headers.map((h) => (<th key={h} className="text-left font-medium p-3 whitespace-nowrap">{h}</th>))}</tr>
          </thead>
          <tbody className="bg-white">
            {isLoading && (<tr><td className="p-6 text-center text-slate-500" colSpan={headers.length}>Loading…</td></tr>)}
            {!isLoading && rows.length === 0 && (<tr><td className="p-6 text-center text-slate-500" colSpan={headers.length}>{emptyText}</td></tr>)}
            {!isLoading && rows.map((r, i) => (
              <tr key={i} className="border-t">
                {r.map((c, j) => (<td key={j} className="p-3 align-middle whitespace-nowrap">{c}</td>))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="md:hidden grid gap-3">
        {isLoading && <div className="text-center text-slate-500">Loading…</div>}
        {!isLoading && rows.length === 0 && <div className="text-center text-slate-500">{emptyText}</div>}
        {!isLoading && rows.length > 0 && rows.map((r, i) => (
          <div key={i} className="rounded-xl border bg-white p-3 grid gap-1">{r.map((c, j) => <div key={j}>{c}</div>)}</div>
        ))}
      </div>
    </>
  );
}

function ListCards({
  isLoading, emptyText, items,
}: {
  isLoading: boolean; emptyText: string;
  items: Array<{ title: string; chips?: string[]; meta?: string; href?: string; onClick?: () => void }>;
}) {
  return (
    <div className="grid gap-2">
      {isLoading && <SkeletonLine count={3} />}
      {!isLoading && items.length === 0 && <div className="text-center text-slate-500">{emptyText}</div>}
      {!isLoading && items.map((it, i) => {
        const content = (
          <>
            <div>
              <div className="font-medium text-slate-900">{it.title}</div>
              {!!it.meta && <div className="text-xs text-slate-500 mt-0.5">{it.meta}</div>}
            </div>
            <div className="flex flex-wrap items-center justify-end gap-1">
              {(it.chips || []).map((c) => (
                <span key={c} className="inline-flex items-center rounded-full px-2 py-0.5 text-xs border bg-slate-50 text-slate-700">{c}</span>
              ))}
            </div>
          </>
        );
        if (it.onClick) {
          return (
            <button key={i} onClick={it.onClick} className="text-left rounded-xl border hover:bg-slate-50 transition bg-white p-3 flex items-start justify-between gap-2">
              {content}
            </button>
          );
        }
        if (it.href?.startsWith("/")) {
          return (
            <Link key={i} href={it.href} className="rounded-xl border hover:bg-slate-50 transition bg-white p-3 flex items-start justify-between gap-2">
              {content}
            </Link>
          );
        }
        return (
          <a key={i} href={it.href} className="rounded-xl border hover:bg-slate-50 transition bg-white p-3 flex items-start justify-between gap-2">
            {content}
          </a>
        );
      })}
    </div>
  );
}

function CellPrimary({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div>
      <div className="font-medium text-slate-900">{title}</div>
      <div className="text-xs text-slate-500">{subtitle || "—"}</div>
    </div>
  );
}

function MiniDonut({ isLoading, data, centerLabel }: { isLoading: boolean; data: Array<{ label: string; value: number; color: string }>; centerLabel: string; }) {
  const total = Math.max(1, data.reduce((s, d) => s + d.value, 0));
  const css = conicCSS(data);
  return (
    <div className="mt-2 flex items-center gap-4">
      <div className="relative h-28 w-28 shrink-0 rounded-full" style={{ backgroundImage: css }} aria-label="donut chart" role="img">
        <div className="absolute inset-2 rounded-full bg-white grid place-items-center">
          {isLoading ? <div className="h-4 w-10 rounded bg-slate-200 animate-pulse" /> :
            <div className="text-center">
              <div className="text-xs text-slate-500">{centerLabel}</div>
              <div className="text-sm font-semibold text-slate-900 tabular-nums">{num(total)}</div>
            </div>}
        </div>
      </div>
      <div className="flex-1">{isLoading ? <SkeletonLine count={4} /> : null}</div>
    </div>
  );
}

function Legend({ items }: { items: Array<[string, number]> }) {
  if (!items || items.length === 0) return null;
  const total = items.reduce((s, [, v]) => s + v, 0);
  return (
    <ul className="mt-2 grid gap-1 text-sm">
      {items.map(([k, v]) => (
        <li key={k} className="flex items-center justify-between">
          <span className="capitalize text-slate-700">{k}</span>
          <span className="tabular-nums text-slate-900">{num(v)}</span>
        </li>
      ))}
      <li className="mt-1 flex items-center justify-between text-xs text-slate-500 border-t pt-1">
        <span>Total</span>
        <span className="tabular-nums">{num(total)}</span>
      </li>
    </ul>
  );
}

function BarRow({ label, value, total }: { label: string; value: number; total: number }) {
  const pct = total > 0 ? Math.round((value / total) * 100) : 0;
  return (
    <div className="mt-2">
      <div className="flex items-center justify-between text-sm">
        <span className="text-slate-700">{label}</span>
        <span className="tabular-nums text-slate-900">{pct}%</span>
      </div>
      <div className="mt-1 h-2 w-full rounded-full bg-slate-100">
        <div className="h-2 rounded-full bg-gradient-to-r from-blue-500 to-indigo-500" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function SkeletonLine({ count = 3 }: { count?: number }) {
  return (
    <div className="grid gap-2">
      {Array.from({ length: count }).map((_, i) => (<div key={i} className="h-4 w-full rounded bg-slate-200 animate-pulse" />))}
    </div>
  );
}

function KV({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <div className="w-40 shrink-0 text-slate-500">{label}</div>
      <div className="text-slate-900">{value}</div>
    </div>
  );
}

/* ===== Icons (inline, no deps) ===== */
function IconRefresh(props: React.SVGProps<SVGSVGElement>) { return (<svg viewBox="0 0 24 24" fill="none" {...props}><path d="M4 4v6h6M20 20v-6h-6M20 10a8 8 0 0 0-14.9-3M4 14a8 8 0 0 0 14.9 3" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>); }
function IconClipboard(props: React.SVGProps<SVGSVGElement>) { return (<svg viewBox="0 0 24 24" fill="none" {...props}><rect x="6" y="4" width="12" height="16" rx="2" stroke="currentColor" strokeWidth="2"/><path d="M9 4h6v2H9z" fill="currentColor"/></svg>); }
function IconCash(props: React.SVGProps<SVGSVGElement>) { return (<svg viewBox="0 0 24 24" fill="none" {...props}><rect x="3" y="6" width="18" height="12" rx="2" stroke="currentColor" strokeWidth="2"/><circle cx="12" cy="12" r="2.5" stroke="currentColor" strokeWidth="2"/></svg>); }
function IconShield(props: React.SVGProps<SVGSVGElement>) { return (<svg viewBox="0 0 24 24" fill="none" {...props}><path d="M12 3l7 3v5c0 5-3.5 8-7 10-3.5-2-7-5-7-10V6l7-3z" stroke="currentColor" strokeWidth="2"/></svg>); }
function IconCheck(props: React.SVGProps<SVGSVGElement>) { return (<svg viewBox="0 0 24 24" fill="none" {...props}><path d="M20 6L9 17l-5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>); }
function IconArrowRight(props: React.SVGProps<SVGSVGElement>) { return (<svg viewBox="0 0 24 24" fill="none" {...props}><path d="M5 12h14M13 5l7 7-7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>); }
