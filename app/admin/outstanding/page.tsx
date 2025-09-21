// app/admin/outstanding/page.tsx
"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  addDoc,
  collection,
  doc as fsDoc,
  getDocs,
  onSnapshot,
  orderBy,
  query,
  limit as fsLimit,
  serverTimestamp,
  Timestamp,
  updateDoc,
} from "firebase/firestore";
import { db } from "../../lib/firebase";

/* Config */
const LATE_FEE_DAILY = Number(process.env.NEXT_PUBLIC_LATE_FEE_DAILY || 0.001); // 0.1%/day

/* Types */
type FireTimestamp = { seconds: number; nanoseconds?: number };
type TsLike = Timestamp | FireTimestamp | number | string | Date | null;

type Loan = {
  id: string;
  firstName?: string;
  surname?: string;
  mobile?: string;
  email?: string;
  areaName?: string;
  loanAmount?: number;
  currentBalance?: number;
  loanPeriod?: number;
  paymentFrequency?: "weekly" | "monthly";
  status?: string;
  timestamp?: TsLike;
  endDate?: TsLike;
  loanType?: string;
  kycId?: string;
};

type Payment = {
  id: string;
  amount?: number; // optional if note-only
  paymentDate?: TsLike;
  createdAt?: TsLike;
  note?: string;
};

type ExtendedLoan = Loan & {
  startMs: number | null;
  endMs: number | null;
  end: Date | null;
  overdueDays: number;
  latePct: number;
  lateAmt: number;
};

type AnyRec = Record<string, unknown>;

/* Helpers */
function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function getErrorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (isObject(e) && "message" in e) {
    const msg = (e as { message?: unknown }).message;
    if (typeof msg === "string") return msg;
  }
  try {
    return typeof e === "string" ? e : JSON.stringify(e);
  } catch {
    return String(e ?? "Unknown error");
  }
}

function isFirestoreTs(v: unknown): v is Timestamp {
  return !!v && typeof (v as { toDate?: unknown }).toDate === "function";
}
function toMillis(v: unknown): number | null {
  try {
    if (!v) return null;
    if (v instanceof Date) return v.getTime();
    if (typeof v === "number") return isFinite(v) ? v : null;
    if (typeof v === "string") {
      const n = Date.parse(v);
      return isFinite(n) ? n : null;
    }
    if (isFirestoreTs(v)) return v.toDate().getTime();
    if (
      typeof v === "object" &&
      v !== null &&
      "seconds" in v &&
      typeof (v as { seconds: unknown }).seconds === "number"
    )
      return Math.round((v as { seconds: number }).seconds * 1000);
  } catch {}
  return null;
}
function computeEndDate(
  ts: unknown,
  period?: number,
  freq?: "weekly" | "monthly"
): Date | null {
  const startMs = toMillis(ts);
  if (!startMs || !period || period <= 0) return null;
  const end = new Date(startMs);
  if (freq === "weekly") end.setDate(end.getDate() + period * 7);
  else end.setMonth(end.getMonth() + period);
  return end;
}
function money(n?: number) {
  const v = typeof n === "number" && isFinite(n) ? Math.round(n) : 0;
  try {
    return new Intl.NumberFormat().format(v);
  } catch {
    return String(v);
  }
}
function fmtDate(d?: unknown) {
  const ms = toMillis(d);
  if (!ms) return "—";
  const dt = new Date(ms);
  return isNaN(+dt) ? "—" : dt.toLocaleDateString();
}
function fmtDateTime(d?: unknown) {
  const ms = toMillis(d);
  if (!ms) return "—";
  const dt = new Date(ms);
  return isNaN(+dt) ? "—" : dt.toLocaleString();
}

/* Page */
export default function OutstandingManagementPage() {
  const [loans, setLoans] = useState<Loan[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<"outstanding" | "finished">("outstanding");

  // live loans
  useEffect(() => {
    setLoading(true);
    const qy = query(
      collection(db, "loan_applications"),
      orderBy("timestamp", "desc"),
      fsLimit(500)
    );
    const unsub = onSnapshot(
      qy,
      (snap) => {
        const rows: Loan[] = snap.docs.map((d) => {
          const v = d.data() as AnyRec;
          return {
            id: d.id,
            firstName: (v.firstName as string) || "",
            surname:
              (v.surname as string) || (v.lastName as string) || "",
            mobile: (v.mobile as string) || (v.mobileTel as string) || "",
            email: (v.email as string) || "",
            areaName: (v.areaName as string) || "",
            loanAmount: Number(v.loanAmount ?? 0),
            currentBalance: Number(v.currentBalance ?? v.loanAmount ?? 0),
            loanPeriod: Number(v.loanPeriod ?? v.period ?? 0),
            paymentFrequency: String(
              v.paymentFrequency ?? v.frequency ?? "monthly"
            ).toLowerCase() as "weekly" | "monthly",
            status: String(v.status ?? "pending").toLowerCase(),
            timestamp: v.timestamp as TsLike | undefined,
            endDate: v.endDate as TsLike | undefined,
            loanType: String(v.loanType ?? "unknown").toLowerCase(),
            kycId: (v.kycId as string) || (v.userId as string) || "",
          };
        });
        setLoans(rows);
        setLoading(false);
      },
      () => setLoading(false)
    );
    return () => unsub();
  }, []);

  const now = Date.now();

  const derived: ExtendedLoan[] = useMemo(() => {
    return loans.map((l) => {
      const startMs = toMillis(l.timestamp);
      const freq = (l.paymentFrequency || "monthly") as "weekly" | "monthly";
      const end = l.endDate
        ? new Date(toMillis(l.endDate) || 0)
        : computeEndDate(l.timestamp, l.loanPeriod, freq);
      const endMs = end ? end.getTime() : null;
      const overdueDays =
        endMs && endMs < now
          ? Math.ceil((now - endMs) / (24 * 60 * 60 * 1000))
          : 0;
      const latePct = overdueDays > 0 ? overdueDays * LATE_FEE_DAILY * 100 : 0;
      const lateAmt =
        overdueDays > 0
          ? (l.currentBalance || 0) * LATE_FEE_DAILY * overdueDays
          : 0;
      return {
        ...l,
        startMs,
        endMs,
        end,
        overdueDays,
        latePct,
        lateAmt,
      };
    });
  }, [loans, now]);

  const outstanding = useMemo(
    () =>
      derived.filter(
        (r) =>
          (r.status === "approved" ||
            r.status === "active" ||
            r.status === "overdue") &&
          (r.currentBalance ?? 0) > 0
      ),
    [derived]
  );
  const finished = useMemo(
    () =>
      derived.filter(
        (r) => (r.currentBalance ?? 0) <= 0 || r.status === "closed"
      ),
    [derived]
  );

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="sticky top-0 z-20 border-b bg-white/90 backdrop-blur supports-[backdrop-filter]:bg-white/60">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 h-14 flex items-center justify-between">
          <h1 className="text-base sm:text-lg font-semibold text-slate-900">
            Outstanding Loans — Management
          </h1>
          <Link
            href="/admin/dashboard"
            className="rounded-lg border px-3 py-1.5 text-sm hover:bg-slate-50"
          >
            Back to Dashboard
          </Link>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 sm:px-6 py-6">
        <div className="flex items-center gap-2 mb-4">
          <button
            onClick={() => setTab("outstanding")}
            className={`rounded-lg px-3 py-1.5 text-sm border ${
              tab === "outstanding"
                ? "bg-slate-900 text-white"
                : "bg-white hover:bg-slate-50"
            }`}
          >
            Outstanding
          </button>
          <button
            onClick={() => setTab("finished")}
            className={`rounded-lg px-3 py-1.5 text-sm border ${
              tab === "finished"
                ? "bg-slate-900 text-white"
                : "bg-white hover:bg-slate-50"
            }`}
          >
            Finished
          </button>
        </div>

        {loading && <div className="text-slate-600">Loading…</div>}

        {!loading && tab === "outstanding" && (
          <div className="grid gap-4">
            {outstanding.length === 0 && (
              <div className="rounded-xl border bg-white p-4 text-slate-600">
                No outstanding loans.
              </div>
            )}
            {outstanding.map((r) => (
              <LoanCard key={r.id} loan={r} />
            ))}
          </div>
        )}

        {!loading && tab === "finished" && (
          <div className="grid gap-4">
            {finished.length === 0 && (
              <div className="rounded-xl border bg-white p-4 text-slate-600">
                No finished loans.
              </div>
            )}
            {finished.map((r) => (
              <LoanCard key={r.id} loan={r} />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}

function LoanCard({ loan }: { loan: ExtendedLoan }) {
  const [expanded, setExpanded] = useState(false);
  const [payments, setPayments] = useState<Payment[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | "pay" | "close">(null);

  const fullName =
    [loan.firstName, loan.surname].filter(Boolean).join(" ") || "—";
  const periodLabel = `${loan.loanPeriod || 0} ${
    loan.paymentFrequency === "weekly" ? "wk" : "mo"
  }`;

  const principal = Number(loan.loanAmount || 0);
  const balance = Number(loan.currentBalance || 0);
  const paid = Math.max(0, principal - balance);
  const progressPct = principal > 0 ? Math.round((paid / principal) * 100) : 0;

  const loadPayments = useCallback(async () => {
    try {
      setLoading(true);
      setErr(null);
      const snap = await getDocs(
        query(
          collection(db, `loan_applications/${loan.id}/loan_payments`),
          orderBy("paymentDate", "desc")
        )
      );

      // FIX: drop any `id` that might exist inside the document data
      type PaymentDoc = Omit<Payment, "id">;
      const rows: Payment[] = snap.docs.map((d) => {
        const data = (d.data() as PaymentDoc) ?? {};
        return { id: d.id, ...data };
      });

      setPayments(rows);
    } catch (e: unknown) {
      setErr(getErrorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [loan.id]);

  // lazy-load on expand
  useEffect(() => {
    if (expanded && payments === null) {
      loadPayments();
    }
  }, [expanded, payments, loadPayments]);

  async function addPayment(amount: number, note?: string) {
    if (!amount || amount <= 0) return;
    try {
      setBusy("pay");
      setErr(null);
      // 1) write payment
      await addDoc(collection(db, `loan_applications/${loan.id}/loan_payments`), {
        amount,
        paymentDate: serverTimestamp(),
        createdAt: serverTimestamp(),
        note: note || null,
      });
      // 2) lower balance locally & in Firestore doc
      const nextBalance = Math.max(0, (loan.currentBalance || 0) - amount);
      await updateDoc(fsDoc(db, "loan_applications", loan.id), {
        currentBalance: nextBalance,
        status: nextBalance <= 0 ? "closed" : loan.status,
      });
      // 3) refresh payments
      await loadPayments();
    } catch (e: unknown) {
      setErr(getErrorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  async function closeLoan() {
    try {
      setBusy("close");
      setErr(null);
      await updateDoc(fsDoc(db, "loan_applications", loan.id), {
        status: "closed",
        currentBalance: 0,
      });
    } catch (e: unknown) {
      setErr(getErrorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="rounded-2xl border bg-white p-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-base font-semibold text-slate-900">
            {fullName}
          </div>
          <div className="text-xs text-slate-600">
            {loan.mobile || "—"}
            {loan.areaName ? ` · ${loan.areaName}` : ""}
          </div>
          <div className="mt-1 flex flex-wrap gap-1">
            <span className="inline-flex items-center rounded-full px-2 py-0.5 text-xs border bg-slate-50 text-slate-700">
              Type: {loan.loanType || "unknown"}
            </span>
            <span className="inline-flex items-center rounded-full px-2 py-0.5 text-xs border bg-slate-50 text-slate-700">
              Period: {periodLabel}
            </span>
            <span className="inline-flex items-center rounded-full px-2 py-0.5 text-xs border bg-slate-50 text-slate-700">
              Start: {fmtDateTime(loan.startMs)}
            </span>
            <span className="inline-flex items-center rounded-full px-2 py-0.5 text-xs border bg-slate-50 text-slate-700">
              End: {fmtDate(loan.end)}
            </span>
          </div>
        </div>
        <div className="text-right">
          <div className="text-xs text-slate-500">Outstanding balance</div>
          <div className="text-lg font-bold tabular-nums">
            MWK {money(balance)}
          </div>
          <div className="text-xs text-slate-600">
            Principal: MWK {money(principal)} · Paid: MWK {money(paid)} (
            {progressPct}%)
          </div>
        </div>
      </div>

      {/* Progress */}
      <div className="mt-3">
        <div className="h-2 w-full rounded-full bg-slate-100">
          <div
            className="h-2 rounded-full bg-gradient-to-r from-blue-500 to-indigo-500"
            style={{ width: `${progressPct}%` }}
          />
        </div>
      </div>

      {/* Overdue & late fee */}
      <div className="mt-3 grid gap-2 sm:grid-cols-3">
        <KV
          label="Status"
          value={<span className="capitalize">{loan.status}</span>}
        />
        <KV
          label="Overdue"
          value={
            loan.overdueDays > 0
              ? `${loan.overdueDays} day${loan.overdueDays === 1 ? "" : "s"}`
              : "—"
          }
        />
        <KV
          label="Late fee growth"
          value={
            loan.overdueDays > 0
              ? `${loan.latePct.toFixed(2)}% · MWK ${money(
                  Math.ceil(loan.lateAmt)
                )}`
              : "—"
          }
        />
      </div>

      {/* Actions */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          onClick={() => setExpanded((v) => !v)}
          className="rounded-lg border px-2.5 py-1.5 text-xs hover:bg-slate-50"
        >
          {expanded ? "Hide details" : "Show details & payments"}
        </button>
        <RecordPaymentButton disabled={busy === "pay"} onSubmit={addPayment} />
        <button
          onClick={closeLoan}
          disabled={busy === "close"}
          className="rounded-lg bg-emerald-600 text-white px-2.5 py-1.5 text-xs hover:bg-emerald-700 disabled:opacity-60"
        >
          Mark as finished
        </button>
        <Link
          href={loan.kycId ? `/kyc/${loan.kycId}` : "#"}
          className={`rounded-lg px-2.5 py-1.5 text-xs ${
            loan.kycId
              ? "bg-blue-600 text-white hover:bg-blue-700"
              : "bg-slate-200 text-slate-600 pointer-events-none"
          }`}
        >
          Open KYC
        </Link>
      </div>

      {/* Details */}
      {expanded && (
        <div className="mt-4 rounded-xl border bg-slate-50 p-3">
          {loading && <div className="text-slate-600 text-sm">Loading payments…</div>}
          {err && <div className="text-sm text-rose-600">{err}</div>}

          <div className="grid gap-2 sm:grid-cols-4">
            <KV label="Acquisition (start)" value={fmtDateTime(loan.startMs)} />
            <KV label="Expected end" value={fmtDate(loan.end)} />
            <KV label="Frequency" value={loan.paymentFrequency} />
            <KV label="Loan ID" value={loan.id} />
          </div>

          <h4 className="mt-3 text-sm font-semibold text-slate-800">Payment history</h4>
          {!loading && payments?.length === 0 && (
            <div className="text-sm text-slate-600">No payments yet.</div>
          )}
          {!loading && payments && payments.length > 0 && (
            <div className="mt-2 overflow-auto rounded-lg border bg-white">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-slate-600">
                  <tr>
                    <th className="text-left font-medium p-2">When</th>
                    <th className="text-left font-medium p-2">Amount</th>
                    <th className="text-left font-medium p-2">Note</th>
                  </tr>
                </thead>
                <tbody className="bg-white">
                  {payments.map((p) => (
                    <tr key={p.id} className="border-t">
                      <td className="p-2">
                        {fmtDateTime(p.paymentDate || p.createdAt)}
                      </td>
                      <td className="p-2">
                        {typeof p.amount === "number"
                          ? `MWK ${money(p.amount)}`
                          : "—"}
                      </td>
                      <td className="p-2">{p.note || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function KV({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 text-sm">
      <div className="w-36 shrink-0 text-slate-500">{label}</div>
      <div className="text-slate-900">{value}</div>
    </div>
  );
}

function RecordPaymentButton({
  onSubmit,
  disabled,
}: {
  onSubmit: (amount: number, note?: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState<string>("");
  const [note, setNote] = useState<string>("");

  function handleSave() {
    const n = Number(amount);
    if (!isFinite(n) || n <= 0) return alert("Enter a valid amount > 0");
    onSubmit(n, note || undefined);
    setOpen(false);
    setAmount("");
    setNote("");
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        disabled={disabled}
        className="rounded-lg bg-amber-600 text-white px-2.5 py-1.5 text-xs hover:bg-amber-700 disabled:opacity-60"
      >
        Record payment
      </button>
    );
  }
  return (
    <div className="flex items-center gap-2">
      <input
        type="number"
        inputMode="decimal"
        placeholder="Amount"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        className="rounded-lg border px-2 py-1.5 text-xs w-28"
      />
      <input
        type="text"
        placeholder="Note (optional)"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        className="rounded-lg border px-2 py-1.5 text-xs w-40"
      />
      <button
        onClick={handleSave}
        disabled={disabled}
        className="rounded-lg bg-slate-900 text-white px-2.5 py-1.5 text-xs hover:bg-black disabled:opacity-60"
      >
        Save
      </button>
      <button
        onClick={() => setOpen(false)}
        className="rounded-lg border px-2.5 py-1.5 text-xs hover:bg-slate-50"
      >
        Cancel
      </button>
    </div>
  );
}
