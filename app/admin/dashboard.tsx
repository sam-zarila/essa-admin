"use client";

import useSWR, { mutate as globalMutate } from "swr";
import { useMemo } from "react";
import type React from "react";

/* =========================
   Shared types
   ========================= */
type FireTimestamp = { seconds: number; nanoseconds?: number };

type Loan = {
  id: string;
  title?: string;
  firstName?: string;
  surname?: string;
  mobile?: string;
  areaName?: string;
  loanAmount?: number;
  loanPeriod?: number; // months or weeks
  paymentFrequency?: "weekly" | "monthly";
  currentBalance?: number;
  endDate?: string | number | Date;
  status?: "pending" | "approved" | "active" | "overdue" | "closed" | string;
  collateralItems?: unknown[];
  loanType?: string; // "business" | "payroll" | etc.
  timestamp?: string | number | Date | FireTimestamp;
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

type KycApplicant = {
  id: string;
  firstName?: string;
  lastName?: string;
  mobile?: string;
  createdAt?: string | number | Date | FireTimestamp;
};

type OverviewResponse = {
  totals?: Totals;
  outstandingTop?: Loan[];
  deadlinesUpcoming?: Loan[];
  overdueWithCollateral?: Loan[];
  finished?: Loan[];
  recentApplicants?: Loan[];
  kycPending?: KycApplicant[];
  breakdown?: Breakdown;
  updatedAt?: number; // ms timestamp
};

/* =========================
   Fetcher (typed)
   ========================= */
const fetcher = async <T,>(u: string): Promise<T> => {
  const r = await fetch(u);
  if (!r.ok) throw new Error(`Failed ${r.status}`);
  return (await r.json()) as T;
};

const defaultTotals: Totals = {
  outstandingCount: 0,
  outstandingBalanceSum: 0,
  collateralCount: 0,
  finishedCount: 0,
  overdueCount: 0,
};

/* =========================
   Component
   ========================= */
export default function AdminOverview() {
  const { data, isLoading, mutate } = useSWR<OverviewResponse>(
    "/api/admin/overview-data",
    fetcher<OverviewResponse>,
    { refreshInterval: 15000, revalidateOnFocus: true }
  );

  // ✅ stabilize top-level slices to avoid deps warnings
  const t = useMemo(() => data?.totals ?? defaultTotals, [data?.totals]);
  const outstandingTop = useMemo(() => data?.outstandingTop ?? [], [data?.outstandingTop]);
  const deadlinesUpcoming = useMemo(() => data?.deadlinesUpcoming ?? [], [data?.deadlinesUpcoming]);
  const overdueWithCollateral = useMemo(
    () => data?.overdueWithCollateral ?? [],
    [data?.overdueWithCollateral]
  );
  const finished = useMemo(() => data?.finished ?? [], [data?.finished]);
  const recentApplicants = useMemo(() => data?.recentApplicants ?? [], [data?.recentApplicants]);
  const kycPending = useMemo(() => data?.kycPending ?? [], [data?.kycPending]);
  const breakdown = useMemo(() => data?.breakdown, [data?.breakdown]);

  const cards = [
    {
      label: "Outstanding Loans",
      value: num(t.outstandingCount),
      sub: "Active with balance",
      icon: IconClipboard,
      tint: "from-amber-500 to-amber-600",
    },
    {
      label: "Outstanding Balance",
      value: "MWK " + money(t.outstandingBalanceSum || 0),
      sub: "Sum of current balances",
      icon: IconCash,
      tint: "from-rose-500 to-rose-600",
    },
    {
      label: "Collateral Items",
      value: num(t.collateralCount),
      sub: "Across active loans",
      icon: IconShield,
      tint: "from-indigo-500 to-indigo-600",
    },
    {
      label: "Finished Repayments",
      value: num(t.finishedCount),
      sub: "Recently closed",
      icon: IconCheck,
      tint: "from-emerald-500 to-emerald-600",
    },
  ];

  // ---------- Derived “Detailed Overview” ----------
  const derived = useMemo(() => {
    // status distribution
    const statusCounts: Record<string, number> = { ...(breakdown?.status || {}) };

    if (!breakdown?.status) {
      add(statusCounts, "active", t.outstandingCount || 0);
      add(statusCounts, "overdue", t.overdueCount || overdueWithCollateral.length || 0);
      add(statusCounts, "closed", t.finishedCount || finished.length || 0);
    }

    // loan type distribution
    const typeCounts: Record<string, number> = { ...(breakdown?.type || {}) };
    if (!breakdown?.type) {
      [...outstandingTop, ...finished, ...deadlinesUpcoming].forEach((r) =>
        add(typeCounts, (r.loanType || "unknown").toLowerCase())
      );
    }

    // payment frequency distribution
    const freqCounts: Record<string, number> = { ...(breakdown?.frequency || {}) };
    if (!breakdown?.frequency) {
      [...outstandingTop, ...finished, ...deadlinesUpcoming].forEach((r) =>
        add(freqCounts, r.paymentFrequency || "monthly")
      );
    }

    // top areas
    const areas: Record<string, number> = {};
    [...outstandingTop, ...deadlinesUpcoming].forEach((r) => add(areas, r.areaName || "—"));
    const topAreas = Object.entries(areas)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6);

    return { statusCounts, typeCounts, freqCounts, topAreas };
  }, [breakdown, t, outstandingTop, finished, deadlinesUpcoming, overdueWithCollateral]);

  const lastUpdated =
    data?.updatedAt ? timeAgo(new Date(data.updatedAt)) : isLoading ? "—" : "a moment ago";

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
              onClick={() => mutate()}
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
                value={isLoading ? undefined : c.value}
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
            {/* Status Donut */}
            <div className="rounded-xl border p-4">
              <h3 className="font-medium text-slate-800">By Status</h3>
              <MiniDonut
                isLoading={isLoading}
                data={toSegments(derived.statusCounts, {
                  active: "#22c55e",
                  overdue: "#ef4444",
                  closed: "#6b7280",
                })}
                centerLabel="Loans"
              />
              <Legend items={Object.entries(derived.statusCounts)} />
            </div>

            {/* Type Donut */}
            <div className="rounded-xl border p-4">
              <h3 className="font-medium text-slate-800">By Type</h3>
              <MiniDonut
                isLoading={isLoading}
                data={toSegments(derived.typeCounts, {
                  business: "#0ea5e9",
                  payroll: "#a855f7",
                  unknown: "#94a3b8",
                })}
                centerLabel="Types"
              />
              <Legend items={Object.entries(derived.typeCounts)} />
            </div>

            {/* Frequency & Areas */}
            <div className="grid gap-4">
              <div className="rounded-xl border p-4">
                <h3 className="font-medium text-slate-800">By Payment Frequency</h3>
                <BarRow label="Monthly" value={derived.freqCounts["monthly"] || 0} total={sumVals(derived.freqCounts)} />
                <BarRow label="Weekly" value={derived.freqCounts["weekly"] || 0} total={sumVals(derived.freqCounts)} />
              </div>
              <div className="rounded-xl border p-4">
                <h3 className="font-medium text-slate-800">Top Areas</h3>
                <ul className="mt-2 grid gap-2">
                  {isLoading && <SkeletonLine count={5} />}
                  {!isLoading && derived.topAreas.length === 0 && (
                    <li className="text-sm text-slate-500">No area data.</li>
                  )}
                  {!isLoading &&
                    derived.topAreas.map(([name, count]) => (
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

        {/* Main content sections */}
        <div className="grid gap-4 xl:grid-cols-2">
          <Section title="Outstanding loans (top 6)">
            <ResponsiveTable
              isLoading={isLoading}
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
                <span key="d" className="text-slate-700">
                  {r.areaName || "—"}
                </span>,
                <span key="e" className="text-slate-700">
                  {fmtDate(r.endDate)}
                </span>,
                <a
                  key="f"
                  className="inline-flex items-center gap-1 text-blue-700 hover:underline"
                  href={`/admin/loans/${r.id}`}
                >
                  View <IconArrowRight className="h-3.5 w-3.5" />
                </a>,
              ])}
            />
          </Section>

          <Section title="Deadlines in next 14 days">
            <ListCards
              isLoading={isLoading}
              emptyText="No deadlines in the next 14 days."
              items={deadlinesUpcoming.map((r) => ({
                title: fullName(r),
                chips: [
                  `MWK ${money(r.currentBalance || 0)}`,
                  `${r.loanPeriod}${r.paymentFrequency === "weekly" ? "wk" : "mo"}`,
                ],
                meta: `${fmtDate(r.endDate)} · ${r.areaName || "—"}`,
                href: `/admin/loans/${r.id}`,
              }))}
            />
          </Section>

          <Section title="Due for collateral (overdue)">
            <ListCards
              isLoading={isLoading}
              emptyText="No overdue loans with collateral."
              items={overdueWithCollateral.map((r) => ({
                title: fullName(r),
                chips: [
                  `MWK ${money(r.currentBalance || 0)}`,
                  `${r.collateralItems?.length || 0} item(s)`,
                ],
                meta: `Overdue since ${fmtDate(r.endDate)} · ${r.areaName || "—"}`,
                href: `/admin/loans/${r.id}`,
              }))}
            />
          </Section>

          <Section title="Finished repayments">
            <ListCards
              isLoading={isLoading}
              emptyText="No recent finishes."
              items={finished.map((r) => ({
                title: fullName(r),
                chips: ["Paid", `${r.loanPeriod}${r.paymentFrequency === "weekly" ? "wk" : "mo"}`],
                meta: r.areaName || "—",
                href: `/admin/loans/${r.id}`,
              }))}
            />
          </Section>

          <Section title="KYC to review">
            <ListCards
              isLoading={isLoading}
              emptyText="Nothing pending."
              items={kycPending.map((k) => ({
                title: fullName({ firstName: k.firstName, lastName: k.lastName }),
                chips: [k.mobile || "—"],
                meta: k.createdAt ? new Date(normalizeDate(k.createdAt)).toLocaleString() : "",
                href: `/admin/kyc/${k.id}`,
              }))}
            />
          </Section>

          <Section title="Recent applicants">
            <ListCards
              isLoading={isLoading}
              emptyText="No recent applications."
              items={recentApplicants.map((r) => ({
                title: fullName(r),
                chips: [`MWK ${money(r.loanAmount || 0)}`, r.status ?? "—"],
                meta:
                  r.timestamp
                    ? new Date(normalizeDate(r.timestamp)).toLocaleString()
                    : "",
                href: `/admin/loans/${r.id}`,
              }))}
            />
          </Section>
        </div>

        <div className="pt-2 pb-8 text-center text-xs text-slate-500">
          Dashboard auto-refreshes every 15s ·{" "}
          <button className="underline" onClick={() => globalMutate("/api/admin/overview-data")}>
            force refresh
          </button>
        </div>
      </main>
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

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border bg-white p-4 sm:p-5">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-slate-900">{title}</h2>
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
      {/* desktop */}
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

      {/* mobile cards */}
      <div className="md:hidden grid gap-3">
        {isLoading && <div className="text-center text-slate-500">Loading…</div>}
        {!isLoading && rows.length === 0 && <div className="text-center text-slate-500">{emptyText}</div>}
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
  items: Array<{ title: string; chips?: string[]; meta?: string; href?: string }>;
}) {
  return (
    <div className="grid gap-2">
      {isLoading && <SkeletonLine count={3} />}
      {!isLoading && items.length === 0 && <div className="text-center text-slate-500">{emptyText}</div>}
      {!isLoading &&
        items.map((it, i) => (
          <a
            key={i}
            href={it.href}
            className="rounded-xl border hover:bg-slate-50 transition bg-white p-3 flex items-start justify-between gap-2"
          >
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
          </a>
        ))}
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

/* ===== Mini visuals (no chart libs) ===== */
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
              <div className="text-sm font-semibold text-slate-900 tabular-nums">{num(total)}</div>
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
      <path d="M4 4v6h6M20 20v-6h-6M20 10a8 8 0 0 0-14.9-3M4 14a8 8 0 0 0 14.9 3" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
    </svg>
  );
}
function IconClipboard(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" {...props}>
      <rect x="6" y="4" width="12" height="16" rx="2" stroke="currentColor" strokeWidth="2"/>
      <path d="M9 4h6v2H9z" fill="currentColor"/>
    </svg>
  );
}
function IconCash(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" {...props}>
      <rect x="3" y="6" width="18" height="12" rx="2" stroke="currentColor" strokeWidth="2"/>
      <circle cx="12" cy="12" r="2.5" stroke="currentColor" strokeWidth="2"/>
    </svg>
  );
}
function IconShield(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" {...props}>
      <path d="M12 3l7 3v5c0 5-3.5 8-7 10-3.5-2-7-5-7-10V6l7-3z" stroke="currentColor" strokeWidth="2"/>
    </svg>
  );
}
function IconCheck(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" {...props}>
      <path d="M20 6L9 17l-5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
    </svg>
  );
}
function IconArrowRight(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" {...props}>
      <path d="M5 12h14M13 5l7 7-7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
    </svg>
  );
}

/* =========================================================
   utils
   ========================================================= */
type Nameable = { title?: string; firstName?: string; surname?: string; lastName?: string };

function fullName(r: Nameable) {
  const last = r.surname ?? r.lastName;
  return [r.title, r.firstName, last].filter(Boolean).join(" ") || "—";
}

function normalizeDate(d: string | number | Date | FireTimestamp): number {
  if (typeof d === "number") return d;
  if (typeof d === "string") return Date.parse(d);
  if (d instanceof Date) return d.getTime();
  // FireTimestamp
  if (typeof d === "object" && d && "seconds" in d) return d.seconds * 1000;
  return NaN;
}

function fmtDate(d?: string | number | Date | null) {
  if (!d) return "—";
  const date = typeof d === "string" || typeof d === "number" ? new Date(d) : d;
  if (!(date instanceof Date) || isNaN(date.getTime())) return "—";
  return date.toLocaleDateString();
}
function money(n: number) {
  try {
    return new Intl.NumberFormat().format(Math.round(n));
  } catch {
    return String(n);
  }
}
function num(n?: number) {
  try {
    return new Intl.NumberFormat().format(n || 0);
  } catch {
    return String(n || 0);
  }
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
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
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
