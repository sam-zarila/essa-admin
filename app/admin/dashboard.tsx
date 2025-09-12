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
} from "firebase/firestore";
import { db } from "../lib/firebase";

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
  status?: "pending" | "approved" | "active" | "overdue" | "closed" | string;
  collateralItems?: unknown[];
  loanType?: string;
  timestamp?: Timestamp | FireTimestamp | number | string | Date | null;
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
function isFirestoreTs(v: any): v is Timestamp {
  return !!v && typeof v.toDate === "function";
}
function toMillis(v: any): number | null {
  try {
    if (!v) return null;
    if (v instanceof Date) return v.getTime();
    if (typeof v === "number") return isFinite(v) ? v : null;
    if (typeof v === "string") {
      const n = Date.parse(v);
      return isFinite(n) ? n : null;
    }
    if (isFirestoreTs(v)) return v.toDate().getTime();
    if (typeof v === "object" && "seconds" in v && typeof v.seconds === "number") {
      return Math.round(v.seconds * 1000);
    }
  } catch {}
  return null;
}

/** Safe nested getter like "name.first" */
function g(obj: any, path: string) {
  return path.split(".").reduce((v, k) => (v == null ? v : v[k]), obj);
}

/** Extract first/last name + area from ANY common schema variants */
function extractNameArea(v: any): { first?: string; last?: string; area?: string } {
  const firstCandidates = [
    "firstName",
    "applicantFirstName",
    "givenName",
    "fname",
    "first_name",
    "name.first",
    "applicant.name.first",
  ];
  const lastCandidates = [
    "surname",
    "lastName",
    "applicantLastName",
    "familyName",
    "lname",
    "last_name",
    "name.last",
    "applicant.name.last",
  ];
  const areaCandidates = [
    "areaName",
    "physicalCity",
    "city",
    "addressCity",
    "address.city",
    "location.city",
    "town",
    "village",
    "area",
    "district",
  ];

  const first = firstCandidates.map((k) => g(v, k)).find(Boolean);
  const last = lastCandidates.map((k) => g(v, k)).find(Boolean);

  let area = areaCandidates.map((k) => g(v, k)).find(Boolean) as string | undefined;

  // Fallback: single "name" string like "John Banda"
  if (!first && !last && typeof v?.name === "string" && v.name.trim()) {
    const parts = v.name.trim().split(/\s+/);
    if (parts.length >= 2) {
      return { first: parts.slice(0, -1).join(" "), last: parts.slice(-1)[0], area };
    }
    return { first: v.name.trim(), last: undefined, area };
  }

  return { first, last, area };
}

function computeEndDate(
  ts: any,
  period?: number,
  freq?: "weekly" | "monthly"
): Date | null {
  const startMs = toMillis(ts);
  if (!startMs || !period || period <= 0) return null;
  const start = new Date(startMs);
  const end = new Date(start);
  if (freq === "weekly") end.setDate(end.getDate() + period * 7);
  else end.setMonth(end.getMonth() + period);
  return end;
}

function fullName(r: { title?: string; firstName?: string; surname?: string; lastName?: string }) {
  const last = r.surname ?? r.lastName;
  return [r.title, r.firstName, last].filter(Boolean).join(" ") || "—";
}
function fmtDate(d?: string | number | Date | null) {
  if (!d) return "—";
  const date = typeof d === "string" || typeof d === "number" ? new Date(d) : d;
  if (!(date instanceof Date) || isNaN(date.getTime())) return "—";
  return date.toLocaleDateString();
}
function fmtMaybeDate(v: any) {
  const ms = toMillis(v);
  return ms ? new Date(ms).toLocaleDateString() : "—";
}
function money(n?: number) {
  const safe = typeof n === "number" && isFinite(n) ? Math.round(n) : 0;
  try { return new Intl.NumberFormat().format(safe); } catch { return String(safe); }
}
function num(n?: number) {
  const safe = typeof n === "number" && isFinite(n) ? n : 0;
  try { return new Intl.NumberFormat().format(safe); } catch { return String(safe); }
}
function timeAgo(d: Date) {
  const s = Math.floor((Date.now() - d.getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  return `${days}d ago`;
}
function add(obj: Record<string, number>, key: string, inc = 1) {
  obj[key] = (obj[key] || 0) + inc;
}
function sumVals(obj: Record<string, number>) {
  return Object.values(obj).reduce((s, v) => s + v, 0);
}
function normalizeStatus(s?: string) {
  const k = String(s || "pending").toLowerCase();
  if (k === "finished" || k === "complete" || k === "completed") return "closed";
  return k;
}
function toSegments(
  map: Record<string, number>,
  palette: Record<string, string>
): Array<{ label: string; value: number; color: string }> {
  return Object.entries(map).map(([label, value]) => ({
    label,
    value,
    color: palette[label] || pickColor(label),
  }));
}
function pickColor(seed: string) {
  const colors = ["#0ea5e9", "#6366f1", "#a855f7", "#22c55e", "#f59e0b", "#ef4444", "#14b8a6"];
  let h = 0;
  for (let i = 0; i < (seed || "").length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return colors[h % colors.length];
}
function conicCSS(data: Array<{ value: number; color: string }>) {
  const total = Math.max(1, data.reduce((s, d) => s + d.value, 0));
  let acc = 0;
  const stops = data.map((d) => {
    const start = (acc / total) * 360;
    acc += d.value;
    const end = (acc / total) * 360;
    return `${d.color} ${start}deg ${end}deg`;
  });
  return `conic-gradient(${stops.join(",")})`;
}

/* Palettes */
const STATUS_PALETTE: Record<string, string> = {
  pending: "#f59e0b",
  approved: "#0ea5e9",
  active: "#22c55e",
  overdue: "#ef4444",
  closed: "#6b7280",
  unknown: "#94a3b8",
};
const TYPE_PALETTE: Record<string, string> = {
  business: "#0ea5e9",
  payroll: "#a855f7",
  salary: "#6366f1",
  agriculture: "#22c55e",
  school: "#f59e0b",
  unknown: "#94a3b8",
};

/* =========================================================
   Page
   ========================================================= */
export default function AdminDashboardPage() {
  // ---------- Loans (client Firestore, realtime) ----------
  const [loans, setLoans] = useState<Loan[]>([]);
  const [loansLoading, setLoansLoading] = useState(true);
  const [loansError, setLoansError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);

  useEffect(() => {
    setLoansLoading(true);
    setLoansError(null);

    const loansRef = collection(db, "loan_applications");
    const q = query(loansRef, orderBy("timestamp", "desc"), fsLimit(200));

    const unsub = onSnapshot(
      q,
      (snap) => {
        const rows: Loan[] = snap.docs.map((d) => {
          const v = d.data() as any;

          // 🔎 Robust name & area extraction
          const { first, last, area } = extractNameArea(v);

          const status = normalizeStatus(v.status);
          const paymentFrequency = (v.paymentFrequency ?? "monthly") as "weekly" | "monthly";
          const loanPeriod = Number(v.loanPeriod ?? 0);
          const ts = v.timestamp ?? null;

          return {
            id: d.id,
            // Names
            firstName: (first ?? "") as string,
            surname: (last ?? "") as string,
            title: v.title ?? "",
            // Contacts
            mobile: v.mobileTel ?? v.mobile ?? v.mobileTel1 ?? "",
            // Amounts
            loanAmount: Number(v.loanAmount ?? 0),
            currentBalance: Number(v.currentBalance ?? v.loanAmount ?? 0),
            // Terms
            loanPeriod,
            paymentFrequency,
            status,
            // Dates
            timestamp: ts,
            endDate: computeEndDate(ts, loanPeriod, paymentFrequency),
            // Area
            areaName: (area ?? "") as string,
            // Other
            collateralItems: Array.isArray(v.collateralItems) ? v.collateralItems : [],
            loanType: String(v.loanType || "unknown").toLowerCase(),
          };
        });
        setLoans(rows);
        setUpdatedAt(Date.now());
        setLoansLoading(false);
      },
      async (err) => {
        console.warn("[loans:onSnapshot] falling back to .limit()", err);
        try {
          const snap = await getDocs(query(collection(db, "loan_applications"), fsLimit(200)));
          const rows: Loan[] = snap.docs.map((d) => {
            const v = d.data() as any;

            const { first, last, area } = extractNameArea(v);

            const status = normalizeStatus(v.status);
            const paymentFrequency = (v.paymentFrequency ?? "monthly") as "weekly" | "monthly";
            const loanPeriod = Number(v.loanPeriod ?? 0);
            const ts = v.timestamp ?? null;

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
              timestamp: ts,
              endDate: computeEndDate(ts, loanPeriod, paymentFrequency),
              areaName: (area ?? "") as string,
              collateralItems: Array.isArray(v.collateralItems) ? v.collateralItems : [],
              loanType: String(v.loanType || "unknown").toLowerCase(),
            };
          });
          setLoans(rows);
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

  // ---------- KYC (client Firestore, realtime) ----------
  const [kycPending, setKycPending] = useState<KycRow[]>([]);
  const [kycLoading, setKycLoading] = useState(true);
  const [kycError, setKycError] = useState<string | null>(null);

  useEffect(() => {
    setKycLoading(true);
    setKycError(null);

    const base = collection(db, "kyc_data");
    const q1 = query(base, orderBy("createdAt", "desc"), fsLimit(100));

    const unsub = onSnapshot(
      q1,
      (snap) => {
        const rows = snap.docs.map((d) => {
          const v = d.data() as any;
          return {
            id: d.id,
            firstName: v.firstName ?? v.applicantFirstName ?? "",
            lastName: v.lastName ?? v.applicantLastName ?? "",
            mobile: v.mobileTel1 ?? v.mobile ?? "",
            email: v.email1 ?? v.email ?? "",
            gender: v.gender ?? "",
            physicalCity: v.physicalCity ?? v.areaName ?? "",
            createdAt: toMillis(v.createdAt) ?? toMillis(v.timestamp) ?? null,
          } as KycRow;
        });
        setKycPending(rows);
        setKycLoading(false);
      },
      async () => {
        // fallback: try timestamp, then simple limit
        try {
          const q2 = query(base, orderBy("timestamp", "desc"), fsLimit(100));
          const snap = await getDocs(q2);
          const rows = snap.docs.map((d) => {
            const v = d.data() as any;
            return {
              id: d.id,
              firstName: v.firstName ?? v.applicantFirstName ?? "",
              lastName: v.lastName ?? v.applicantLastName ?? "",
              mobile: v.mobileTel1 ?? v.mobile ?? "",
              email: v.email1 ?? v.email ?? "",
              gender: v.gender ?? "",
              physicalCity: v.physicalCity ?? v.areaName ?? "",
              createdAt: toMillis(v.createdAt) ?? toMillis(v.timestamp) ?? null,
            } as KycRow;
          });
          setKycPending(rows);
          setKycLoading(false);
        } catch (e) {
          try {
            const snap = await getDocs(query(base, fsLimit(100)));
            const rows = snap.docs.map((d) => {
              const v = d.data() as any;
              return {
                id: d.id,
                firstName: v.firstName ?? v.applicantFirstName ?? "",
                lastName: v.lastName ?? v.applicantLastName ?? "",
                mobile: v.mobileTel1 ?? v.mobile ?? "",
                email: v.email1 ?? v.email ?? "",
                gender: v.gender ?? "",
                physicalCity: v.physicalCity ?? v.areaName ?? "",
                createdAt: toMillis(v.createdAt) ?? toMillis(v.timestamp) ?? null,
              } as KycRow;
            });
            setKycPending(rows);
            setKycLoading(false);
          } catch (err: any) {
            setKycError(err?.message || "Failed to load KYC");
            setKycLoading(false);
          }
        }
      }
    );

    return () => unsub();
  }, []);

  // ---------- Derived slices from loans ----------
  const outstanding = useMemo(
    () =>
      loans
        .filter(
          (r) =>
            (r.status === "approved" || r.status === "active") &&
            (r.currentBalance ?? 0) > 0
        )
        .sort((a, b) => (b.currentBalance ?? 0) - (a.currentBalance ?? 0)),
    [loans]
  );
  const outstandingTop = useMemo(() => outstanding.slice(0, 6), [outstanding]);

  // Re-evaluate the rolling 14-day window whenever data is refreshed
  const now = useMemo(() => new Date(), [updatedAt]);
  const soon = useMemo(
    () => new Date((updatedAt ?? Date.now()) + 14 * 24 * 60 * 60 * 1000),
    [updatedAt]
  );

  const deadlinesUpcoming = useMemo(
    () =>
      loans
        .filter((r) => {
          const end = r.endDate ? new Date(r.endDate) : null;
          return (
            (r.status === "approved" || r.status === "active") &&
            (r.currentBalance ?? 0) > 0 &&
            end &&
            end >= now &&
            end <= soon
          );
        })
        .sort(
          (a, b) =>
            new Date(a.endDate || 0).getTime() -
            new Date(b.endDate || 0).getTime()
        )
        .slice(0, 8),
    [loans, now, soon]
  );

  const overdueWithCollateral = useMemo(
    () =>
      loans
        .filter((r) => {
          const end = r.endDate ? new Date(r.endDate) : null;
          return (
            (r.status === "approved" || r.status === "active") &&
            (r.currentBalance ?? 0) > 0 &&
            end &&
            end < now &&
            (r.collateralItems?.length ?? 0) > 0
          );
        })
        .sort(
          (a, b) =>
            new Date(a.endDate || 0).getTime() -
            new Date(b.endDate || 0).getTime()
        )
        .slice(0, 8),
    [loans, now]
  );

  const finished = useMemo(
    () =>
      loans
        .filter(
          (r) =>
            (r.currentBalance ?? 0) <= 0 ||
            r.status === "closed" ||
            r.status === "finished"
        )
        .slice(0, 8),
    [loans]
  );
  const recentApplicants = useMemo(() => loans.slice(0, 8), [loans]);

  const totals: Totals = useMemo(
    () => ({
      outstandingCount: outstanding.length,
      outstandingBalanceSum: outstanding.reduce(
        (s, r) => s + (r.currentBalance || 0),
        0
      ),
      collateralCount: loans.reduce(
        (s, r) => s + (r.collateralItems?.length ?? 0),
        0
      ),
      finishedCount: finished.length,
      overdueCount: loans.filter((r) => {
        const end = r.endDate ? new Date(r.endDate) : null;
        return end && end < now && (r.currentBalance ?? 0) > 0;
      }).length,
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

  // ---------- “new KYC” badge counter ----------
  const [kycNewCount, setKycNewCount] = useState(0);
  useEffect(() => {
    const LAST_KEY = "kyc_seen_at";
    const lastSeen = Number(localStorage.getItem(LAST_KEY) || "0");
    if (!kycPending.length) {
      setKycNewCount(0);
      return;
    }
    const count = kycPending.reduce((acc, r) => {
      const ts = typeof r.createdAt === "number" ? r.createdAt : 0;
      return acc + (ts > lastSeen ? 1 : 0);
    }, 0);
    setKycNewCount(count);
  }, [kycPending]);
  function markKycSeen() {
    localStorage.setItem("kyc_seen_at", String(Date.now()));
    setKycNewCount(0);
  }

  // ---------- Modals ----------
  const [viewKycId, setViewKycId] = useState<string | null>(null);
  const [viewLoanId, setViewLoanId] = useState<string | null>(null); // NEW

  // ---------- Header & KPIs ----------
  const lastUpdated = updatedAt
    ? timeAgo(new Date(updatedAt))
    : loansLoading
    ? "—"
    : "a moment ago";
  const cards = [
    {
      label: "Outstanding Loans",
      value: num(totals.outstandingCount),
      sub: "Active with balance",
      icon: IconClipboard,
      tint: "from-amber-500 to-amber-600",
    },
    {
      label: "Outstanding Balance",
      value: "MWK " + money(totals.outstandingBalanceSum || 0),
      sub: "Sum of balances",
      icon: IconCash,
      tint: "from-rose-500 to-rose-600",
    },
    {
      label: "Collateral Items",
      value: num(totals.collateralCount),
      sub: "Across loans",
      icon: IconShield,
      tint: "from-indigo-500 to-indigo-600",
    },
    {
      label: "Finished Repayments",
      value: num(totals.finishedCount),
      sub: "Recently closed",
      icon: IconCheck,
      tint: "from-emerald-500 to-emerald-600",
    },
  ];

  return (
    <div className="min-h-screen w-full bg-slate-50">
      {/* Header */}
      <header className="sticky top-0 z-20 border-b bg-white/90 backdrop-blur supports-[backdrop-filter]:bg-white/60">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="h-9 w-9 rounded-lg bg-gradient-to-br from-blue-600 to-indigo-600 text-white grid place-items-center font-semibold">
              EL
            </div>
            <div>
              <h1 className="text-base sm:text-lg font-semibold text-slate-900">
                ESSA Loans — Admin Dashboard
              </h1>
              <div className="text-xs text-slate-500">Updated {lastUpdated}</div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setUpdatedAt(Date.now())}
              className="inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm hover:bg-slate-50"
              title="Refresh"
            >
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
            {cards.map((c) => (
              <KPICard
                key={c.label}
                label={c.label}
                value={loansLoading ? undefined : c.value}
                sub={c.sub}
                icon={c.icon}
                tint={c.tint}
              />
            ))}
          </div>
        </section>

        {/* Loan Detailed Overview */}
        <section className="rounded-2xl border bg-white p-4 sm:p-6">
          <div className="flex items-center justify-between">
            <h2 className="text-base sm:text-lg font-semibold text-slate-900">
              Loan Detailed Overview
            </h2>
          </div>

          <div className="mt-4 grid gap-4 lg:grid-cols-3">
            <div className="rounded-xl border p-4">
              <h3 className="font-medium text-slate-800">By Status</h3>
              <MiniDonut
                isLoading={loansLoading}
                data={toSegments(breakdown.status || {}, STATUS_PALETTE)}
                centerLabel="Loans"
              />
              <Legend items={Object.entries(breakdown.status || {})} />
            </div>

            <div className="rounded-xl border p-4">
              <h3 className="font-medium text-slate-800">By Type</h3>
              <MiniDonut
                isLoading={loansLoading}
                data={toSegments(breakdown.type || {}, TYPE_PALETTE)}
                centerLabel="Types"
              />
              <Legend items={Object.entries(breakdown.type || {})} />
            </div>

            <div className="grid gap-4">
              <div className="rounded-xl border p-4">
                <h3 className="font-medium text-slate-800">By Payment Frequency</h3>
                <BarRow
                  label="Monthly"
                  value={(breakdown.frequency || {})["monthly"] || 0}
                  total={sumVals(breakdown.frequency || {})}
                />
                <BarRow
                  label="Weekly"
                  value={(breakdown.frequency || {})["weekly"] || 0}
                  total={sumVals(breakdown.frequency || {})}
                />
              </div>
              <div className="rounded-xl border p-4">
                <h3 className="font-medium text-slate-800">Top Areas</h3>
                <ul className="mt-2 grid gap-2">
                  {loansLoading && <SkeletonLine count={5} />}
                  {!loansLoading &&
                    Object.entries(
                      loans.reduce<Record<string, number>>((m, r) => (add(m, r.areaName || "—"), m), {})
                    )
                      .sort((a, b) => b[1] - a[1])
                      .slice(0, 6)
                      .map(([name, count]) => (
                        <li key={name} className="flex items-center justify-between text-sm">
                          <span className="text-slate-700">{name}</span>
                          <span className="rounded-full bg-slate-50 px-2 py-0.5 text-slate-700 border">
                            {num(count)}
                          </span>
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
                <span key="b" className="font-medium text-slate-900">
                  MWK {money(r.currentBalance || 0)}
                </span>,
                <span key="c" className="text-slate-700">
                  {r.loanPeriod} {r.paymentFrequency === "weekly" ? "wk" : "mo"}
                </span>,
                <span key="d" className="text-slate-700">{r.areaName || "—"}</span>,
                <span key="e" className="text-slate-700">{fmtDate(r.endDate as any)}</span>,
                <button
                  key="f"
                  onClick={() => setViewLoanId(r.id)} // ⬅️ open modal instead of navigating
                  className="inline-flex items-center gap-1 text-blue-700 hover:underline"
                >
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
                chips: [
                  `MWK ${money(r.currentBalance || 0)}`,
                  `${r.loanPeriod}${r.paymentFrequency === "weekly" ? "wk" : "mo"}`,
                ],
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
                chips: [
                  `MWK ${money(r.currentBalance || 0)}`,
                  `${r.collateralItems?.length || 0} item(s)`,
                ],
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

          {/* KYC Section with badge + actions + modal */}
          <Section
            title={
              <div className="flex items-center gap-2">
                <span>KYC to review</span>
                {kycNewCount > 0 && (
                  <span className="inline-flex items-center justify-center h-5 min-w-[20px] rounded-full bg-rose-600 text-white text-xs px-1">
                    {kycNewCount}
                  </span>
                )}
              </div>
            }
            extra={
              <button
                onClick={markKycSeen}
                className="rounded-lg bg-blue-600 text-white px-2.5 py-1 text-xs hover:bg-blue-700"
                title="Reset new counter"
              >
                Mark seen
              </button>
            }
          >
            <div className="grid gap-2">
              {kycLoading && <SkeletonLine count={3} />}
              {kycError && (
                <div className="text-sm text-rose-600">Failed to load KYC.</div>
              )}
              {!kycLoading && !kycError && kycPending.length === 0 && (
                <div className="text-center text-slate-500">Nothing pending.</div>
              )}
              {!kycLoading &&
                !kycError &&
                kycPending.map((k) => (
                  <div
                    key={k.id}
                    className="rounded-xl border bg-white p-3 flex items-start justify-between gap-2"
                  >
                    <div>
                      <div className="font-medium text-slate-900">
                        {fullName({ firstName: k.firstName, lastName: k.lastName })}
                      </div>
                      <div className="text-xs text-slate-500 mt-0.5">
                        {k.createdAt
                          ? new Date(k.createdAt).toLocaleString()
                          : "—"}
                      </div>
                      <div className="text-xs text-slate-600 mt-1">
                        {(k.mobile || "—")}
                        {k.email ? ` · ${k.email}` : ""}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Link
                        href={`/admin/kyc/${k.id}`}
                        className="rounded-lg border px-2.5 py-1.5 text-xs hover:bg-slate-50"
                      >
                        Open page
                      </Link>
                      <button
                        onClick={() => setViewKycId(k.id)}
                        className="rounded-lg bg-blue-600 text-white px-2.5 py-1.5 text-xs hover:bg-blue-700"
                      >
                        View KYC
                      </button>
                    </div>
                  </div>
                ))}
            </div>

            <KycPreviewModal kycId={viewKycId} onClose={() => setViewKycId(null)} />
          </Section>

          <Section title="Recent applicants">
            <ListCards
              isLoading={loansLoading}
              emptyText="No recent applications."
              items={recentApplicants.map((r) => ({
                title: fullName(r),
                chips: [`MWK ${money(r.loanAmount || 0)}`, String(r.status ?? "—")],
                meta: r.timestamp
                  ? new Date(toMillis(r.timestamp) || 0).toLocaleString()
                  : "",
                onClick: () => setViewLoanId(r.id),
              }))}
            />
          </Section>
        </div>

        {(loansError || kycError) && (
          <div className="text-center text-xs text-rose-600 pt-2">
            {loansError || kycError}
          </div>
        )}

        <div className="pt-2 pb-8 text-center text-xs text-slate-500">
          Realtime data · No server auth · Client Firestore
        </div>
      </main>

      {/* NEW: Loan modal (fixes "page not found" issue) */}
      <LoanPreviewModal loanId={viewLoanId} onClose={() => setViewLoanId(null)} />
    </div>
  );
}

/* =========================================================
   Loan Preview Modal (fetches /loan_applications/{id})
   ========================================================= */
function LoanPreviewModal({
  loanId,
  onClose,
}: {
  loanId: string | null;
  onClose: () => void;
}) {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Allow ESC to close
  useEffect(() => {
    if (!loanId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [loanId, onClose]);

  useEffect(() => {
    if (!loanId) return;
    setLoading(true);
    setErr(null);
    setData(null);

    (async () => {
      try {
        const snap = await getDoc(fsDoc(db, "loan_applications", loanId));
        if (!mounted.current) return;
        if (!snap.exists()) throw new Error("Loan not found");

        const raw = { id: snap.id, ...snap.data() };
        const { first, last, area } = extractNameArea(raw);
        setData({
          ...raw,
          __first: first,
          __last: last,
          __area: area,
        });
      } catch (e: any) {
        if (!mounted.current) return;
        setErr(e?.message || "Failed to load loan");
      } finally {
        if (mounted.current) setLoading(false);
      }
    })();
  }, [loanId]);

  if (!loanId) return null;

  const ts = data ? toMillis(data.timestamp) : null;
  const end = data ? toMillis(data.endDate) : null;
  const full =
    [data?.title, data?.__first, data?.__last].filter(Boolean).join(" ") || "—";
  const area =
    data?.__area ??
    data?.areaName ??
    data?.physicalCity ??
    data?.city ??
    data?.addressCity ??
    data?.town ??
    data?.village ??
    "—";

  return (
    <div className="fixed inset-0 z-40">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="absolute inset-x-0 top-10 mx-auto w-[94%] max-w-2xl">
        <div className="rounded-2xl border bg-white shadow-xl">
          <div className="flex items-center justify-between p-4 border-b">
            <h3 className="text-base font-semibold text-slate-900">Loan Preview</h3>
            <button
              onClick={onClose}
              className="rounded-lg border px-2 py-1 text-sm hover:bg-slate-50"
            >
              Close
            </button>
          </div>
          <div className="p-4">
            {loading && <SkeletonLine count={6} />}
            {err && <div className="text-rose-600 text-sm">Failed to load: {err}</div>}
            {!loading && !err && data && (
              <div className="grid gap-2 text-sm">
                <KV label="Applicant" value={full} />
                <KV
                  label="Mobile"
                  value={data?.mobileTel ?? data?.mobile ?? data?.mobileTel1 ?? "—"}
                />
                <KV label="Area" value={area} />
                <KV label="Status" value={String(data?.status ?? "pending")} />
                <KV
                  label="Loan Amount"
                  value={`MWK ${money(Number(data?.loanAmount ?? 0))}`}
                />
                <KV
                  label="Current Balance"
                  value={`MWK ${money(Number(data?.currentBalance ?? data?.loanAmount ?? 0))}`}
                />
                <KV
                  label="Period"
                  value={`${Number(data?.loanPeriod ?? 0)} ${String(
                    data?.paymentFrequency ?? "monthly"
                  ) === "weekly" ? "wk" : "mo"}`}
                />
                <KV label="Start" value={ts ? new Date(ts).toLocaleString() : "—"} />
                <KV label="End" value={end ? new Date(end).toLocaleDateString() : "—"} />
                {Array.isArray(data?.collateralItems) && data.collateralItems.length > 0 && (
                  <div>
                    <div className="text-slate-500 mb-1">Collateral</div>
                    <ul className="list-disc pl-5">
                      {data.collateralItems.map((it: any, i: number) => (
                        <li key={i} className="text-sm">
                          {typeof it === "string" ? it : JSON.stringify(it)}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </div>
          <div className="p-4 border-t text-right">
            {/* If you later add a detail page, you can link to it here */}
            <button
              onClick={onClose}
              className="inline-flex items-center rounded-lg bg-blue-600 text-white px-3 py-1.5 text-sm hover:bg-blue-700"
            >
              Done
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* =========================================================
   KYC Preview Modal (client Firestore doc fetch)
   ========================================================= */
function KycPreviewModal({
  kycId,
  onClose,
}: {
  kycId: string | null;
  onClose: () => void;
}) {
  const [data, setData] = useState<any>(null);
  const [isLoading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Allow ESC to close
  useEffect(() => {
    if (!kycId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [kycId, onClose]);

  useEffect(() => {
    if (!kycId) return;
    setLoading(true);
    setErr(null);
    setData(null);

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
            <button
              onClick={onClose}
              className="rounded-lg border px-2 py-1 text-sm hover:bg-slate-50"
            >
              Close
            </button>
          </div>
          <div className="p-4">
            {isLoading && <SkeletonLine count={6} />}
            {err && <div className="text-rose-600 text-sm">Failed to load KYC: {err}</div>}
            {!isLoading && !err && (
              <div className="grid gap-2 text-sm">
                <KV
                  label="Name"
                  value={[
                    data?.title,
                    data?.firstName ?? data?.applicantFirstName,
                    data?.lastName ?? data?.surname ?? data?.applicantLastName,
                  ]
                    .filter(Boolean)
                    .join(" ") || "—"}
                />
                <KV label="ID Number" value={data?.idNumber || "—"} />
                <KV label="Gender" value={data?.gender || "—"} />
                <KV label="Date of Birth" value={fmtMaybeDate(data?.dateOfBirth)} />
                <KV label="Email" value={data?.email1 || data?.email || "—"} />
                <KV
                  label="Mobile"
                  value={data?.mobileTel1 || data?.mobile || "—"}
                />
                <KV
                  label="Address / City"
                  value={data?.physicalAddress || data?.physicalCity || data?.areaName || "—"}
                />
                <KV label="Employer" value={data?.employer || "—"} />
                <KV label="Dependants" value={String(data?.dependants ?? "—")} />
                <KV
                  label="Next of Kin"
                  value={`${data?.familyName || "—"} (${
                    data?.familyRelation || "—"
                  })${data?.familyMobile ? " · " + data?.familyMobile : ""}`}
                />
              </div>
            )}
          </div>
          <div className="p-4 border-t text-right">
            <Link
              href={`/admin/kyc/${kycId}`}
              className="inline-flex items-center rounded-lg bg-blue-600 text-white px-3 py-1.5 text-sm hover:bg-blue-700"
            >
              Open Full KYC
            </Link>
          </div>
        </div>
      </div>
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

/* =========================================================
   UI bits
   ========================================================= */
function KPICard({
  label,
  value,
  sub,
  icon: Icon,
  tint,
}: {
  label: string;
  value?: string | number;
  sub: string;
  icon: React.ComponentType<React.SVGProps<SVGSVGElement>>;
  tint: string;
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
        {value === undefined ? (
          <div className="h-7 w-32 rounded-md bg-slate-200 animate-pulse" />
        ) : (
          <div className="text-2xl sm:text-3xl font-bold tabular-nums">{value}</div>
        )}
      </div>
      <div className="mt-1 text-xs text-slate-500">{sub}</div>
    </div>
  );
}

function Section({
  title,
  extra,
  children,
}: {
  title: React.ReactNode;
  extra?: React.ReactNode;
  children: React.ReactNode;
}) {
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

function ResponsiveTable({
  isLoading,
  emptyText,
  headers,
  rows,
}: {
  isLoading: boolean;
  emptyText: string;
  headers: string[];
  rows: React.ReactNode[][];
}) {
  return (
    <>
      <div className="hidden md:block overflow-auto rounded-xl border">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-600 sticky top-0">
            <tr>
              {headers.map((h) => (
                <th key={h} className="text-left font-medium p-3 whitespace-nowrap">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="bg-white">
            {isLoading && (
              <tr>
                <td className="p-6 text-center text-slate-500" colSpan={headers.length}>
                  Loading…
                </td>
              </tr>
            )}
            {!isLoading && rows.length === 0 && (
              <tr>
                <td className="p-6 text-center text-slate-500" colSpan={headers.length}>
                  {emptyText}
                </td>
              </tr>
            )}
            {!isLoading &&
              rows.map((r, i) => (
                <tr key={i} className="border-t">
                  {r.map((c, j) => (
                    <td key={j} className="p-3 align-middle whitespace-nowrap">
                      {c}
                    </td>
                  ))}
                </tr>
              ))}
          </tbody>
        </table>
      </div>

      <div className="md:hidden grid gap-3">
        {isLoading && <div className="text-center text-slate-500">Loading…</div>}
        {!isLoading && rows.length === 0 && (
          <div className="text-center text-slate-500">{emptyText}</div>
        )}
        {!isLoading &&
          rows.length > 0 &&
          rows.map((r, i) => (
            <div key={i} className="rounded-xl border bg-white p-3 grid gap-1">
              {r.map((c, j) => (
                <div key={j}>{c}</div>
              ))}
            </div>
          ))}
      </div>
    </>
  );
}

function ListCards({
  isLoading,
  emptyText,
  items,
}: {
  isLoading: boolean;
  emptyText: string;
  items: Array<{ title: string; chips?: string[]; meta?: string; href?: string; onClick?: () => void }>;
}) {
  return (
    <div className="grid gap-2">
      {isLoading && <SkeletonLine count={3} />}
      {!isLoading && items.length === 0 && (
        <div className="text-center text-slate-500">{emptyText}</div>
      )}
      {!isLoading &&
        items.map((it, i) => {
          const content = (
            <>
              <div>
                <div className="font-medium text-slate-900">{it.title}</div>
                {!!it.meta && <div className="text-xs text-slate-500 mt-0.5">{it.meta}</div>}
              </div>
              <div className="flex flex-wrap items-center justify-end gap-1">
                {(it.chips || []).map((c) => (
                  <span
                    key={c}
                    className="inline-flex items-center rounded-full px-2 py-0.5 text-xs border bg-slate-50 text-slate-700"
                  >
                    {c}
                  </span>
                ))}
              </div>
            </>
          );

          if (it.onClick) {
            return (
              <button
                key={i}
                onClick={it.onClick}
                className="text-left rounded-xl border hover:bg-slate-50 transition bg-white p-3 flex items-start justify-between gap-2"
              >
                {content}
              </button>
            );
          }
          if (it.href?.startsWith("/")) {
            return (
              <Link
                key={i}
                href={it.href}
                className="rounded-xl border hover:bg-slate-50 transition bg-white p-3 flex items-start justify-between gap-2"
              >
                {content}
              </Link>
            );
          }
          return (
            <a
              key={i}
              href={it.href}
              className="rounded-xl border hover:bg-slate-50 transition bg-white p-3 flex items-start justify-between gap-2"
            >
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

function MiniDonut({
  isLoading,
  data,
  centerLabel,
}: {
  isLoading: boolean;
  data: Array<{ label: string; value: number; color: string }>;
  centerLabel: string;
}) {
  const total = Math.max(1, data.reduce((s, d) => s + d.value, 0));
  const css = conicCSS(data);

  return (
    <div className="mt-2 flex items-center gap-4">
      <div
        className="relative h-28 w-28 shrink-0 rounded-full"
        style={{ backgroundImage: css }}
        aria-label="donut chart"
        role="img"
      >
        <div className="absolute inset-2 rounded-full bg-white grid place-items-center">
          {isLoading ? (
            <div className="h-4 w-10 rounded bg-slate-200 animate-pulse" />
          ) : (
            <div className="text-center">
              <div className="text-xs text-slate-500">{centerLabel}</div>
              <div className="text-sm font-semibold text-slate-900 tabular-nums">
                {num(total)}
              </div>
            </div>
          )}
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
        <div
          className="h-2 rounded-full bg-gradient-to-r from-blue-500 to-indigo-500"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function SkeletonLine({ count = 3 }: { count?: number }) {
  return (
    <div className="grid gap-2">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="h-4 w-full rounded bg-slate-200 animate-pulse" />
      ))}
    </div>
  );
}

/* ===== Icons (inline, no deps) ===== */
function IconRefresh(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" {...props}>
      <path
        d="M4 4v6h6M20 20v-6h-6M20 10a8 8 0 0 0-14.9-3M4 14a8 8 0 0 0 14.9 3"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}
function IconClipboard(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" {...props}>
      <rect x="6" y="4" width="12" height="16" rx="2" stroke="currentColor" strokeWidth="2" />
      <path d="M9 4h6v2H9z" fill="currentColor" />
    </svg>
  );
}
function IconCash(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" {...props}>
      <rect x="3" y="6" width="18" height="12" rx="2" stroke="currentColor" strokeWidth="2" />
      <circle cx="12" cy="12" r="2.5" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}
function IconShield(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" {...props}>
      <path
        d="M12 3l7 3v5c0 5-3.5 8-7 10-3.5-2-7-5-7-10V6l7-3z"
        stroke="currentColor"
        strokeWidth="2"
      />
    </svg>
  );
}
function IconCheck(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" {...props}>
      <path d="M20 6L9 17l-5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
function IconArrowRight(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" {...props}>
      <path d="M5 12h14M13 5l7 7-7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
