// app/api/admin/overview-data/route.ts
import { NextResponse } from "next/server";
import { cookies } from "next/headers";

import admin from "firebase-admin";
import { adminAuth, adminDb } from "@/app/lib/firebase-admin";

export const runtime = "nodejs";

/* =========================
   Types
   ========================= */
type Loan = {
  id: string;
  firstName?: string;
  surname?: string;
  title?: string;
  mobile?: string;
  loanAmount?: number;
  currentBalance?: number;
  loanPeriod?: number;
  paymentFrequency?: "weekly" | "monthly";
  status?: string;
  timestamp?: admin.firestore.Timestamp | null;
  areaName?: string;
  collateralItems?: Array<{ description?: string }>;
};

type LoanDoc = {
  firstName?: string;
  applicantFirstName?: string;
  surname?: string;
  applicantLastName?: string;
  title?: string;
  mobileTel?: string;
  mobile?: string;
  mobileTel1?: string;
  loanAmount?: number | string;
  currentBalance?: number | string;
  loanPeriod?: number | string;
  paymentFrequency?: "weekly" | "monthly";
  status?: string;
  timestamp?: admin.firestore.Timestamp | null;
  areaName?: string;
  collateralItems?: unknown;
};

type KycDoc = {
  firstName?: string;
  lastName?: string;
  mobileTel1?: string;
  mobile?: string;
  timestamp?: admin.firestore.Timestamp | null;
  createdAt?: admin.firestore.Timestamp | null;
};

type DecodedClaims = admin.auth.DecodedIdToken & {
  admin?: boolean;
  officer?: boolean;
};

function hasToMillis(
  x: unknown
): x is { toMillis: () => number } {
  return (
    typeof x === "object" &&
    x !== null &&
    "toMillis" in x &&
    typeof (x as { toMillis: unknown }).toMillis === "function"
  );
}

function computeEndDate(
  ts: admin.firestore.Timestamp | null | undefined,
  period: number | undefined,
  freq: Loan["paymentFrequency"] | undefined
): Date | null {
  if (!ts || !period || period <= 0) return null;
  const start = ts.toDate();
  const end = new Date(start);
  if (freq === "weekly") {
    end.setDate(end.getDate() + period * 7);
  } else {
    end.setMonth(end.getMonth() + period);
  }
  return end;
}

/* =========================
   Handler
   ========================= */
export async function GET() {
  // Read session cookie
  const cookieStore = cookies();
  const session = (await cookieStore).get("__session")?.value;

  if (!session) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  try {
    const decoded = await adminAuth().verifySessionCookie(session, true);
    const claims: DecodedClaims = decoded;
    if (!claims.admin && !claims.officer) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    const db = adminDb();

    // Latest 200 loans
    const loansSnap = await db
      .collection("loan_applications")
      .orderBy("timestamp", "desc")
      .limit(200)
      .get();

    const loans: Loan[] = loansSnap.docs.map((d) => {
      const v = d.data() as LoanDoc;
      const collateral =
        Array.isArray(v.collateralItems)
          ? (v.collateralItems as Array<{ description?: string }>)
          : [];

      return {
        id: d.id,
        firstName: v.firstName ?? v.applicantFirstName ?? "",
        surname: v.surname ?? v.applicantLastName ?? "",
        title: v.title ?? "",
        mobile: v.mobileTel ?? v.mobile ?? v.mobileTel1 ?? "",
        loanAmount: Number(v.loanAmount ?? 0),
        currentBalance: Number(v.currentBalance ?? v.loanAmount ?? 0),
        loanPeriod: Number(v.loanPeriod ?? 0),
        paymentFrequency: v.paymentFrequency ?? "monthly",
        status: v.status ?? "pending",
        timestamp: v.timestamp ?? null,
        areaName: v.areaName ?? "",
        collateralItems: collateral,
      };
    });

    const now = new Date();
    const soon = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000); // 14 days

    const withDerived = loans.map((r) => {
      const endDate = computeEndDate(r.timestamp ?? null, r.loanPeriod, r.paymentFrequency);
      return { ...r, endDate };
    });

    const outstanding = withDerived
      .filter((r) => r.status === "approved" && (r.currentBalance ?? 0) > 0)
      .sort((a, b) => (b.currentBalance ?? 0) - (a.currentBalance ?? 0));

    const outstandingTop = outstanding.slice(0, 6);

    const deadlinesUpcoming = withDerived
      .filter(
        (r) =>
          r.status === "approved" &&
          (r.currentBalance ?? 0) > 0 &&
          r.endDate &&
          r.endDate >= now &&
          r.endDate <= soon
      )
      .sort((a, b) => a.endDate!.getTime() - b.endDate!.getTime())
      .slice(0, 8);

    const overdueWithCollateral = withDerived
      .filter(
        (r) =>
          r.status === "approved" &&
          (r.currentBalance ?? 0) > 0 &&
          r.endDate &&
          r.endDate < now &&
          (r.collateralItems?.length ?? 0) > 0
      )
      .sort((a, b) => a.endDate!.getTime() - b.endDate!.getTime())
      .slice(0, 8);

    const finished = withDerived
      .filter(
        (r) =>
          (r.currentBalance ?? 0) <= 0 ||
          r.status === "closed" ||
          r.status === "finished"
      )
      .slice(0, 8);

    const recentApplicants = withDerived.slice(0, 8);

    let kycPending: Array<{
      id: string;
      firstName?: string;
      lastName?: string;
      mobile?: string;
      createdAt?: number | null;
    }> = [];

    try {
      const kycSnap = await db
        .collection("kyc_data")
        .where("kycCompleted", "==", false)
        .limit(10)
        .get();

      kycPending = kycSnap.docs.map((d) => {
        const v = d.data() as KycDoc;
        const created =
          (v.timestamp && hasToMillis(v.timestamp) && v.timestamp.toMillis()) ||
          (v.createdAt && hasToMillis(v.createdAt) && v.createdAt.toMillis()) ||
          null;

        return {
          id: d.id,
          firstName: v.firstName ?? "",
          lastName: v.lastName ?? "",
          mobile: v.mobileTel1 ?? v.mobile ?? "",
          createdAt: created,
        };
      });
    } catch {
      kycPending = [];
    }

    const totals = {
      outstandingCount: outstanding.length,
      outstandingBalanceSum: outstanding.reduce((s, r) => s + (r.currentBalance || 0), 0),
      collateralCount: withDerived.reduce((s, r) => s + (r.collateralItems?.length ?? 0), 0),
      finishedCount: finished.length,
    };

    return NextResponse.json({
      outstandingTop,
      deadlinesUpcoming,
      overdueWithCollateral,
      finished,
      recentApplicants,
      kycPending,
      totals,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "server-error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
