// app/api/admin/overview-data/route.ts
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import type admin from "firebase-admin";
import { adminDb } from "@/app/lib/firebase-admin";

type LoanDoc = {
  firstName?: string; applicantFirstName?: string;
  surname?: string; applicantLastName?: string;
  title?: string;
  mobileTel?: string; mobile?: string; mobileTel1?: string;
  loanAmount?: number | string;
  currentBalance?: number | string;
  loanPeriod?: number | string;
  paymentFrequency?: "weekly" | "monthly";
  status?: string;
  timestamp?: admin.firestore.Timestamp | null;
  areaName?: string;
  collateralItems?: unknown;
  loanType?: string;
};

type KycDoc = {
  firstName?: string; lastName?: string;
  mobile?: string; mobileTel1?: string;
  createdAt?: admin.firestore.Timestamp | null;
  timestamp?: admin.firestore.Timestamp | null;
};

/* ---- toMillis: remove `any`, keep behavior ---- */
type HasToMillis = { toMillis?: () => number };
type HasToDate = { toDate?: () => Date };

function toMillis(v: unknown): number | null {
  try {
    if (v == null) return null;

    // Prefer native toMillis() if exposed (admin.firestore.Timestamp has it)
    if (typeof (v as HasToMillis).toMillis === "function") {
      const n = (v as HasToMillis).toMillis!();
      return Number.isFinite(n) ? n : null;
    }

    // Fall back to toDate() (for client Timestamp)
    if (typeof (v as HasToDate).toDate === "function") {
      const d = (v as HasToDate).toDate!();
      return d instanceof Date ? d.getTime() : null;
    }

    // Also accept primitives and ISO strings if ever passed through
    if (v instanceof Date) return v.getTime();
    if (typeof v === "number") return Number.isFinite(v) ? v : null;
    if (typeof v === "string") {
      const n = Date.parse(v);
      return Number.isFinite(n) ? n : null;
    }
  } catch {
    // ignore
  }
  return null;
}

function computeEndDate(
  ts: admin.firestore.Timestamp | null | undefined,
  period: number | undefined,
  freq: "weekly" | "monthly" | undefined
) {
  if (!ts || !period || period <= 0) return null;
  const start = ts.toDate();
  const end = new Date(start);
  if (freq === "weekly") end.setDate(end.getDate() + period * 7);
  else end.setMonth(end.getMonth() + period);
  return end;
}

export async function GET() {
  try {
    const db = adminDb();

    // ----- Loans -----
    let loansSnap: FirebaseFirestore.QuerySnapshot<FirebaseFirestore.DocumentData>;
    try {
      loansSnap = await db
        .collection("loan_applications")
        .orderBy("timestamp", "desc")
        .limit(200)
        .get();
    } catch (e) {
      console.warn(
        "[/api/admin/overview-data] orderBy(timestamp) failed, fallback to .limit():",
        e
      );
      loansSnap = await db.collection("loan_applications").limit(200).get();
    }

    const loans = loansSnap.docs.map((d) => {
      const v = d.data() as LoanDoc;
      const status = (v.status || "pending").toLowerCase();
      const paymentFrequency = v.paymentFrequency ?? "monthly";
      const loanPeriod = Number(v.loanPeriod ?? 0);
      const ts = v.timestamp ?? null;
      return {
        id: d.id,
        firstName: v.firstName ?? v.applicantFirstName ?? "",
        surname: v.surname ?? v.applicantLastName ?? "",
        title: v.title ?? "",
        mobile: v.mobileTel ?? v.mobile ?? v.mobileTel1 ?? "",
        loanAmount: Number(v.loanAmount ?? 0),
        currentBalance: Number(v.currentBalance ?? v.loanAmount ?? 0),
        loanPeriod,
        paymentFrequency,
        status,
        timestamp: ts,
        endDate: computeEndDate(ts, loanPeriod, paymentFrequency),
        areaName: v.areaName ?? "",
        collateralItems: Array.isArray(v.collateralItems) ? v.collateralItems : [],
        loanType: (v.loanType || "unknown").toLowerCase(),
      };
    });

    const now = new Date();
    const soon = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);

    const outstanding = loans
      .filter(
        (r) =>
          (r.status === "approved" || r.status === "active") &&
          (r.currentBalance ?? 0) > 0
      )
      .sort((a, b) => (b.currentBalance ?? 0) - (a.currentBalance ?? 0));

    const outstandingTop = outstanding.slice(0, 6);

    const deadlinesUpcoming = loans
      .filter(
        (r) =>
          (r.status === "approved" || r.status === "active") &&
          (r.currentBalance ?? 0) > 0 &&
          r.endDate &&
          r.endDate >= now &&
          r.endDate <= soon
      )
      .sort((a, b) => a.endDate!.getTime() - b.endDate!.getTime())
      .slice(0, 8);

    const overdueWithCollateral = loans
      .filter(
        (r) =>
          (r.status === "approved" || r.status === "active") &&
          (r.currentBalance ?? 0) > 0 &&
          r.endDate &&
          r.endDate < now &&
          (r.collateralItems?.length ?? 0) > 0
      )
      .sort((a, b) => a.endDate!.getTime() - b.endDate!.getTime())
      .slice(0, 8);

    const finished = loans
      .filter(
        (r) =>
          (r.currentBalance ?? 0) <= 0 ||
          r.status === "closed" ||
          r.status === "finished"
      )
      .slice(0, 8);

    const recentApplicants = loans.slice(0, 8);

    // ----- KYC (compact list) -----
    let kycSnap: FirebaseFirestore.QuerySnapshot<FirebaseFirestore.DocumentData>;
    try {
      kycSnap = await db
        .collection("kyc_data")
        .orderBy("createdAt", "desc")
        .limit(10)
        .get();
    } catch (e) {
      console.warn(
        "[/api/admin/overview-data] KYC orderBy(createdAt) failed, fallback to .limit():",
        e
      );
      kycSnap = await db.collection("kyc_data").limit(10).get();
    }

    const kycPending = kycSnap.docs.map((d) => {
      const v = d.data() as KycDoc;
      return {
        id: d.id,
        firstName: v.firstName ?? "",
        lastName: v.lastName ?? "",
        mobile: v.mobileTel1 ?? v.mobile ?? "",
        createdAt: toMillis(v.createdAt) ?? toMillis(v.timestamp) ?? null,
      };
    });

    const totals = {
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
      overdueCount: loans.filter(
        (r) => r.endDate && r.endDate < now && (r.currentBalance ?? 0) > 0
      ).length,
    };

    const breakdown = {
      status: loans.reduce<Record<string, number>>((m, r) => {
        m[r.status] = (m[r.status] || 0) + 1;
        return m;
      }, {}),
      type: loans.reduce<Record<string, number>>((m, r) => {
        const key = r.loanType || "unknown";
        m[key] = (m[key] || 0) + 1;
        return m;
      }, {}),
      frequency: loans.reduce<Record<string, number>>((m, r) => {
        const key = r.paymentFrequency || "monthly";
        m[key] = (m[key] || 0) + 1;
        return m;
      }, {}),
    };

    return NextResponse.json({
      totals,
      outstandingTop,
      deadlinesUpcoming,
      overdueWithCollateral,
      finished,
      recentApplicants,
      kycPending,
      breakdown,
      updatedAt: Date.now(),
    });
  } catch (err) {
    console.error("[/api/admin/kyc/[id]] failed:", err);
    return NextResponse.json({ error: "internal-error" }, { status: 500 });
  }
}
