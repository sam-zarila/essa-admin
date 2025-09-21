"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import type React from "react";
import Link from "next/link";
import Image from "next/image";
import {
  collection,
  collectionGroup,
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
  serverTimestamp,
} from "firebase/firestore";
import emailjs from "@emailjs/browser";
import { db } from "../lib/firebase";

/* EmailJS config (env or replace placeholders) */
const EMAILJS_SERVICE_ID =
  process.env.NEXT_PUBLIC_EMAILJS_SERVICE_ID || "YOUR_SERVICE_ID";
const EMAILJS_TEMPLATE_ID =
  process.env.NEXT_PUBLIC_EMAILJS_TEMPLATE_ID || "YOUR_TEMPLATE_ID";
const EMAILJS_PUBLIC_KEY =
  process.env.NEXT_PUBLIC_EMAILJS_PUBLIC_KEY || "YOUR_PUBLIC_KEY";

/* Late-fee config (per-day rate; tune via env if needed) */
const LATE_FEE_DAILY = Number(
  process.env.NEXT_PUBLIC_LATE_FEE_DAILY || 0.001
); // 0.1%/day default

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
  status?:
    | "pending"
    | "approved"
    | "active"
    | "overdue"
    | "closed"
    | "declined"
    | string;
  collateralItems?: unknown[];
  loanType?: string;
  timestamp?: Timestamp | FireTimestamp | number | string | Date | null;
  kycId?: string;
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
  original?: Record<string, unknown> | null;
  cleared?: boolean;
};

type CalcDecision = {
  status?: string;
  note?: string;
  byUid?: string;
  byEmail?: string;
  at?: Timestamp | FireTimestamp | number | string | Date | null;
};

type CalcResults = {
  monthlyInstallment?: number;
  totalAmountPaid?: number;
  netReceived?: number;
  eir?: number;
} | null;

type CalcProposal = {
  id: string;
  path: string;
  userId: string;
  loanType: string;
  loanAmount: number;
  months: number;
  monthlyInstallment?: number;
  totalAmountPaid?: number;
  netReceived?: number;
  eir?: number;
  timestamp?: Timestamp | FireTimestamp | number | string | Date | null;
  decision?: CalcDecision | null;
  results?: CalcResults;
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

type CollateralVM = {
  key: string;
  label: string;
  estValue?: number | null;
  loanId: string;
  borrower: string;
  mobile?: string;
  area?: string;
  startMs: number | null;
  endMs: number | null;
  daysLeft: number | null;
  overdueDays: number;
  lateFee: number;
  currentBalance: number;
  kycId?: string;
  imageUrl?: string | null;
};

type LoanPreview = {
  id: string;
  applicantFull: string;
  mobile: string;
  email: string;
  status?: string;
  area: string;
  loanAmount: number;
  currentBalance: number;
  period: number;
  frequency: "weekly" | "monthly" | string;
  startMs: number | null;
  endMs: number | null;
  collateralItems: unknown[];
};

/* =========================================================
   Narrowing helpers (TypeScript-safe)
   ========================================================= */
type AnyRec = Record<string, unknown>;
type TsLike = Timestamp | FireTimestamp | number | string | Date | null;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null;

const isTs = (v: unknown): v is Timestamp =>
  isObject(v) && "toDate" in v && typeof (v as { toDate: unknown }).toDate === "function";

const isFireObj = (v: unknown): v is FireTimestamp =>
  isObject(v) && "seconds" in v && typeof (v as { seconds: unknown }).seconds === "number";

const asNumber = (v: unknown): number | undefined =>
  typeof v === "number" && isFinite(v) ? v : undefined;

const asString = (v: unknown): string | undefined =>
  typeof v === "string" ? v : undefined;

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

const g = (obj: unknown, path: string): unknown =>
  path.split(".").reduce<unknown>((v, k) => {
    if (!isObject(v)) return undefined;
    return (v as AnyRec)[k];
  }, obj);

function firstDefined<T>(...vals: T[]): T | undefined {
  for (const v of vals) if (v !== undefined && v !== null && (typeof v !== "string" || v !== "")) return v;
  return undefined;
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
    if (isTs(v)) return v.toDate().getTime();
    if (isFireObj(v)) return Math.round(v.seconds * 1000);
  } catch {
    // ignore
  }
  return null;
}

function extractNameArea(v: AnyRec): {
  first?: string;
  last?: string;
  area?: string;
} {
  const first =
    (firstDefined(
      v.firstName,
      v.applicantFirstName,
      v.givenName,
      g(v, "name.first"),
      g(v, "applicant.name.first")
    ) as string | undefined) ||
    (typeof v?.name === "string" && v.name.trim()
      ? v.name.trim().split(/\s+/).slice(0, -1).join(" ")
      : undefined);

  const last =
    (firstDefined(
      v.surname,
      v.lastName,
      v.applicantLastName,
      v.familyName,
      g(v, "name.last"),
      g(v, "applicant.name.last")
    ) as string | undefined) ||
    (typeof v?.name === "string" && v.name.trim()
      ? v.name.trim().split(/\s+/).slice(-1)[0]
      : undefined);

  const area = firstDefined(
    v.areaName,
    v.physicalCity,
    v.city,
    v.addressCity,
    g(v, "address.city"),
    g(v, "location.city"),
    v.town,
    v.village,
    v.area,
    v.district
  ) as string | undefined;

  return { first, last, area };
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

function fullName(r: {
  title?: string;
  firstName?: string;
  surname?: string;
  lastName?: string;
}) {
  const last = r.surname ?? r.lastName;
  return [r.title, r.firstName, last].filter(Boolean).join(" ") || "—";
}

function fmtDate(d?: string | number | Date | null) {
  if (!d) return "—";
  const date = typeof d === "string" || typeof d === "number" ? new Date(d) : d;
  return isNaN(+date) ? "—" : date.toLocaleDateString();
}

function fmtMaybeDate(v: unknown) {
  const ms = toMillis(v);
  return ms ? new Date(ms).toLocaleDateString() : "—";
}

function money(n?: number) {
  const v = typeof n === "number" && isFinite(n) ? Math.round(n) : 0;
  try {
    return new Intl.NumberFormat().format(v);
  } catch {
    return String(v);
  }
}

function num(n?: number) {
  const v = typeof n === "number" && isFinite(n) ? n : 0;
  try {
    return new Intl.NumberFormat().format(v);
  } catch {
    return String(v);
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

function normalizeStatus(s?: string) {
  const k = String(s || "pending").toLowerCase();
  if (k === "finished" || k === "complete" || k === "completed") return "closed";
  return k;
}

function toSegments(
  map: Record<string, number>,
  palette: Record<string, string>
) {
  return Object.entries(map).map(([label, value]) => ({
    label,
    value,
    color: palette[label] || pickColor(label),
  }));
}

function pickColor(seed: string) {
  const colors = [
    "#0ea5e9",
    "#6366f1",
    "#a855f7",
    "#22c55e",
    "#f59e0b",
    "#ef4444",
    "#14b8a6",
  ];
  let h = 0;
  for (let i = 0; i < (seed || "").length; i++)
    h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return colors[h % colors.length];
}

function conicCSS(data: Array<{ value: number; color: string }>) {
  const total = Math.max(
    1,
    data.reduce((s, d) => s + d.value, 0)
  );
  let acc = 0;
  const stops = data.map((d) => {
    const start = (acc / total) * 360;
    acc += d.value;
    const end = (acc / total) * 360;
    return `${d.color} ${start}deg ${end}deg`;
  });
  return `conic-gradient(${stops.join(",")})`;
}

function onlyDigits(s?: string) {
  return (s || "").replace(/\D+/g, "");
}

function phoneKeys(s?: string) {
  const d = onlyDigits(s);
  if (!d) return [] as string[];
  const keys = new Set([d]);
  if (d.startsWith("265")) keys.add(d.slice(3));
  if (d.startsWith("0")) keys.add(d.slice(1));
  return [...keys];
}

function nameKey(first?: string, last?: string) {
  const f = (first || "").trim().toLowerCase();
  const l = (last || "").trim().toLowerCase();
  return f && l ? `${f}|${l}` : "";
}

function detectKycId(loan: AnyRec): string | undefined {
  const id =
    firstDefined(
      loan.kycId,
      (loan as AnyRec)["kyc_id"],
      (loan as AnyRec)["kycID"],
      (loan as AnyRec)["applicantId"],
      (loan as AnyRec)["applicant_id"],
      (loan as AnyRec)["applicantID"],
      (loan as AnyRec)["userId"],
      (loan as AnyRec)["uid"],
      (loan as AnyRec)["customerId"],
      (loan as AnyRec)["customer_id"],
      g(loan, "customer.id"),
      g(loan, "applicant.id")
    ) || undefined;
  const ref = firstDefined(g(loan, "kycRef"), g(loan, "applicantRef"));
  if (!id && ref && typeof (ref as AnyRec).id === "string")
    return (ref as AnyRec).id as string;
  return id ? String(id) : undefined;
}

const STATUS_PALETTE: Record<string, string> = {
  pending: "#f59e0b",
  approved: "#0ea5e9",
  active: "#22c55e",
  overdue: "#ef4444",
  closed: "#6b7280",
  declined: "#ef4444",
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

/* Base64/URL helpers for images */
function toDataUrlMaybe(b64?: string) {
  if (!b64 || typeof b64 !== "string") return "";
  const s = b64.trim();
  return s.startsWith("data:") ? s : `data:image/jpeg;base64,${s}`;
}

function isUrlLike(s?: string) {
  if (!s || typeof s !== "string") return false;
  const t = s.trim();
  return t.startsWith("http://") || t.startsWith("https://") || t.startsWith("data:");
}

/* Try to extract an image URL or data URI from a collateral item */
function collateralImageUrl(it: unknown): string | null {
  if (!it) return null;
  if (typeof it === "string") return isUrlLike(it) ? it : null;
  if (typeof it === "object") {
    const cand =
      (it as AnyRec).imageUrl ||
      (it as AnyRec).photoUrl ||
      (it as AnyRec).pictureUrl ||
      (it as AnyRec).thumbnail ||
      (it as AnyRec).thumbUrl ||
      (it as AnyRec).url ||
      (it as AnyRec).image ||
      (it as AnyRec).photo ||
      (it as AnyRec).picture;
    if (typeof cand === "string" && isUrlLike(cand)) return cand;

    const b64 =
      (it as AnyRec).imageBase64 ||
      (it as AnyRec).photoBase64 ||
      (it as AnyRec).pictureBase64 ||
      (it as AnyRec).thumbnailBase64;
    if (typeof b64 === "string" && b64.trim()) return toDataUrlMaybe(b64);

    const images = (it as AnyRec).images;
    const photos = (it as AnyRec).photos;
    const pictures = (it as AnyRec).pictures;
    const arrCand =
      (Array.isArray(images) ? images[0] : undefined) ??
      (Array.isArray(photos) ? photos[0] : undefined) ??
      (Array.isArray(pictures) ? pictures[0] : undefined);
    if (typeof arrCand === "string" && isUrlLike(arrCand)) return arrCand;
    if (arrCand && typeof arrCand === "object") {
      const nestedUrl =
        (arrCand as AnyRec).url ||
        (arrCand as AnyRec).imageUrl ||
        (arrCand as AnyRec).photoUrl ||
        (arrCand as AnyRec).src;
      if (typeof nestedUrl === "string" && isUrlLike(nestedUrl)) return nestedUrl;
      const nestedB64 =
        (arrCand as AnyRec).base64 || (arrCand as AnyRec).imageBase64;
      if (typeof nestedB64 === "string" && nestedB64.trim())
        return toDataUrlMaybe(nestedB64);
    }
  }
  return null;
}

function collateralLabel(it: unknown): string {
  if (!it) return "Collateral item";
  if (typeof it === "string") return it;
  if (typeof it === "object") {
    return (
      (it as AnyRec).label ||
      (it as AnyRec).name ||
      (it as AnyRec).title ||
      (it as AnyRec).model ||
      (it as AnyRec).description ||
      `${(it as AnyRec).make ? String((it as AnyRec).make) + " " : ""}${
        (it as AnyRec).model ? String((it as AnyRec).model) : "Item"
      }`
    ) as string;
  }
  return "Collateral item";
}

function collateralValue(it: unknown): number | undefined {
  if (!it || typeof it !== "object") return undefined;
  const v =
    (it as AnyRec).value ||
    (it as AnyRec).estimatedValue ||
    (it as AnyRec).estValue ||
    (it as AnyRec).amount ||
    (it as AnyRec).price;
  return asNumber(v);
}

/* =========================================================
   Page
   ========================================================= */
export default function AdminDashboardPage() {
  /* Feedback banner */
  const [feedback, setFeedback] = useState<{
    type: "success" | "error" | "info";
    text: string;
  } | null>(null);

  function pushFeedback(
    type: "success" | "error" | "info",
    text: string
  ): void {
    setFeedback({ type, text });
    window.setTimeout(() => setFeedback(null), 4000);
  }

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
        const rows = snap.docs.map<Loan>((d) => {
          const v = d.data() as AnyRec;
          const { first, last, area } = extractNameArea(v);
          const status = normalizeStatus(asString(v.status));
          const paymentFrequency =
            (firstDefined(
              v.paymentFrequency,
              v.frequency
            ) as "weekly" | "monthly" | undefined) ?? "monthly";
          const loanPeriod = Number(
            firstDefined(
              v.loanPeriod,
              v.period,
              v.term,
              v.tenorMonths,
              v.tenorWeeks
            ) || 0
          );
          const startRaw = firstDefined(
            v.timestamp,
            v.startDate,
            v.start_date,
            v.createdAt,
            v.created_at,
            (v as AnyRec)["loanStartDate"]
          );
          const startVal = (startRaw ?? null) as TsLike;
          const explicitEnd = firstDefined(
            v.endDate,
            (v as AnyRec)["loanEndDate"],
            (v as AnyRec)["expectedEndDate"],
            (v as AnyRec)["maturityDate"],
            (v as AnyRec)["end_date"]
          );
          const explicitEndMs = toMillis(explicitEnd);
          const computedEnd = computeEndDate(
            startRaw,
            loanPeriod,
            paymentFrequency
          );
          return {
            id: d.id,
            firstName: first ?? "",
            surname: last ?? "",
            title: asString(v.title) ?? "",
            mobile:
              (asString((v as AnyRec)["mobileTel"]) ??
                asString(v.mobile) ??
                asString((v as AnyRec)["mobileTel1"]) ??
                "") || "",
            loanAmount: Number((v as AnyRec)["loanAmount"] ?? 0),
            currentBalance: Number(
              (v as AnyRec)["currentBalance"] ??
                (v as AnyRec)["loanAmount"] ??
                0
            ),
            loanPeriod,
            paymentFrequency,
            status,
            timestamp: startVal,
            endDate: explicitEndMs ? new Date(explicitEndMs) : computedEnd,
            areaName: area ?? "",
            collateralItems: Array.isArray(v.collateralItems)
              ? (v.collateralItems as unknown[])
              : [],
            loanType: String((v as AnyRec)["loanType"] || "unknown").toLowerCase(),
            kycId: detectKycId(v),
          } satisfies Loan;
        });
        setLoansRaw(rows);
        setUpdatedAt(Date.now());
        setLoansLoading(false);
      },
      async (err: unknown) => {
        console.warn("[loans:onSnapshot] fallback", err);
        try {
          const snap = await getDocs(
            query(collection(db, "loan_applications"), fsLimit(200))
          );
          const rows = snap.docs.map<Loan>((d) => {
            const v = d.data() as AnyRec;
            const { first, last, area } = extractNameArea(v);
            const status = normalizeStatus(asString(v.status));
            const paymentFrequency =
              (firstDefined(
                v.paymentFrequency,
                v.frequency
              ) as "weekly" | "monthly" | undefined) ?? "monthly";
            const loanPeriod = Number(
              firstDefined(
                v.loanPeriod,
                v.period,
                v.term,
                v.tenorMonths,
                v.tenorWeeks
              ) || 0
            );
            const startRaw = firstDefined(
              v.timestamp,
              v.startDate,
              v.start_date,
              v.createdAt,
              v.created_at,
              (v as AnyRec)["loanStartDate"]
            );
            const startVal = (startRaw ?? null) as TsLike;
            const explicitEnd = firstDefined(
              v.endDate,
              (v as AnyRec)["loanEndDate"],
              (v as AnyRec)["expectedEndDate"],
              (v as AnyRec)["maturityDate"],
              (v as AnyRec)["end_date"]
            );
            const explicitEndMs = toMillis(explicitEnd);
            const computedEnd = computeEndDate(
              startRaw,
              loanPeriod,
              paymentFrequency
            );
            return {
              id: d.id,
              firstName: first ?? "",
              surname: last ?? "",
              title: asString(v.title) ?? "",
              mobile:
                (asString((v as AnyRec)["mobileTel"]) ??
                  asString(v.mobile) ??
                  asString((v as AnyRec)["mobileTel1"]) ??
                  "") || "",
              loanAmount: Number((v as AnyRec)["loanAmount"] ?? 0),
              currentBalance: Number(
                (v as AnyRec)["currentBalance"] ??
                  (v as AnyRec)["loanAmount"] ??
                  0
              ),
              loanPeriod,
              paymentFrequency,
              status,
              timestamp: startVal,
              endDate: explicitEndMs ? new Date(explicitEndMs) : computedEnd,
              areaName: area ?? "",
              collateralItems: Array.isArray(v.collateralItems)
                ? (v.collateralItems as unknown[])
                : [],
              loanType: String((v as AnyRec)["loanType"] || "unknown").toLowerCase(),
              kycId: detectKycId(v),
            } satisfies Loan;
          });
          setLoansRaw(rows);
          setUpdatedAt(Date.now());
          setLoansLoading(false);
        } catch (e: unknown) {
          setLoansError(getErrorMessage(e));
          setLoansLoading(false);
        }
      }
    );
    return () => unsub();
  }, []);

  /* KYC (permissive; always fetch something) */
  const [kycPending, setKycPending] = useState<KycRow[]>([]);
  const [kycLoading, setKycLoading] = useState(true);
  const [kycError, setKycError] = useState<string | null>(null);

  useEffect(() => {
    setKycLoading(true);
    setKycError(null);
    const base = collection(db, "kyc_data");
    const q1 = query(base, fsLimit(500));
    const unsub = onSnapshot(
      q1,
      (snap) => {
        const rows = snap.docs.map((d) => {
          const v = d.data() as AnyRec;
          return {
            id: d.id,
            firstName:
              (asString(v.firstName) ??
                asString((v as AnyRec)["applicantFirstName"]) ??
                asString(v.givenName) ??
                "") || "",
            lastName:
              (asString(v.lastName) ??
                asString(v.applicantLastName) ??
                asString(v.surname) ??
                "") || "",
            mobile:
              (asString((v as AnyRec)["mobileTel1"]) ??
                asString(v.mobile) ??
                asString(v.phone) ??
                "") || "",
            email: (asString((v as AnyRec)["email1"]) ?? asString(v.email)) || "",
            gender: asString(v.gender) || "",
            physicalCity:
              (asString(v.physicalCity) ??
                asString(v.areaName) ??
                asString(v.city) ??
                "") || "",
            createdAt:
              toMillis(v.createdAt) ??
              toMillis((v as AnyRec)["timestamp"]) ??
              toMillis((v as AnyRec)["created_at"]) ??
              null,
          } as KycRow;
        });
        rows.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
        setKycPending(rows);
        setKycLoading(false);
      },
      (e: unknown) => {
        setKycError(getErrorMessage(e));
        setKycLoading(false);
      }
    );
    return () => unsub();
  }, []);

  /* Enrich loans with KYC */
  const kycIndex = useMemo(() => {
    const byPhone = new Map<string, KycRow>();
    const byName = new Map<string, KycRow>();
    const byId = new Map<string, KycRow>();
    for (const k of kycPending) {
      for (const key of phoneKeys(k.mobile)) byPhone.set(key, k);
      const nk = nameKey(k.firstName, k.lastName);
      if (nk) byName.set(nk, k);
      if (k.id) byId.set(k.id, k);
    }
    return { byPhone, byName, byId };
  }, [kycPending]);

  const loans: Loan[] = useMemo(() => {
    return loansRaw.map((l) => {
      const out: Loan = { ...l };
      if (!out.firstName || !out.surname || !out.areaName) {
        for (const key of phoneKeys(out.mobile)) {
          const k = kycIndex.byPhone.get(key);
          if (k) {
            out.firstName ||= k.firstName || "";
            out.surname ||= k.lastName || "";
            out.areaName ||= k.physicalCity || "";
            break;
          }
        }
        if (!out.firstName || !out.surname) {
          const k = kycIndex.byName.get(nameKey(out.firstName, out.surname));
          if (k) {
            out.firstName ||= k.firstName || "";
            out.surname ||= k.lastName || "";
            out.areaName ||= k.physicalCity || "";
          }
        }
      }
      if (!out.endDate)
        out.endDate = computeEndDate(
          out.timestamp,
          out.loanPeriod,
          out.paymentFrequency
        );
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
          const v = d.data() as AnyRec;
          return {
            id: d.id,
            applicantFull: (v.applicantFull as string) || "—",
            mobile: asString(v.mobile) || "—",
            email: asString(v.email) || "",
            area: asString(v.area) || "—",
            processedStatus: (v.processedStatus as
              | "approved"
              | "declined")!,
            processedAt: (v.processedAt as number) ?? Date.now(),
            loanAmount: asNumber(v.loanAmount) ?? 0,
            currentBalance: asNumber(v.currentBalance) ?? 0,
            period: asNumber(v.period) ?? 0,
            frequency: (asString(v.frequency) || "monthly").toLowerCase(),
            startMs: toMillis(v.startMs) ?? null,
            endMs: toMillis(v.endMs) ?? null,
            original:
              v.original && typeof v.original === "object"
                ? (v.original as AnyRec)
                : null,
            cleared: !!v.cleared,
          };
        });
        setProcessed(rows);
        setProcessedLoading(false);
      },
      (err: unknown) => {
        setProcessedError(getErrorMessage(err));
        setProcessedLoading(false);
      }
    );
    return () => unsub();
  }, []);

  /* ========= Loan Issuing (calculator proposals) — simple fetch ========= */
  const [issuing, setIssuing] = useState<CalcProposal[]>([]);
  const [issuingLoading, setIssuingLoading] = useState(true);
  const [issuingError, setIssuingError] = useState<string | null>(null);
  const [issuingExpanded, setIssuingExpanded] = useState(false);

  useEffect(() => {
    setIssuingLoading(true);
    setIssuingError(null);
    const qy = query(collectionGroup(db, "calculations"), fsLimit(200));
    const unsub = onSnapshot(
      qy,
      (snap) => {
        const rows: CalcProposal[] = snap.docs.map((d) => {
          const v = d.data() as AnyRec;
          const res = (v.results as AnyRec | null) || null;
          // ✅ sanitize timestamp into a TsLike
          const tsRaw = firstDefined(v.timestamp, v.createdAt, v.created_at);
          const tsVal = (tsRaw ?? null) as TsLike;
          return {
            id: d.id,
            path: d.ref.path,
            userId: String(v.userId || ""),
            loanType: String(v.loanType || "unknown"),
            loanAmount: Number(v.loanAmount || 0),
            months: Number(v.months || 0),
            monthlyInstallment: Number(
              v["monthlyInstallment"] ?? res?.monthlyInstallment ?? 0
            ),
            totalAmountPaid: Number(
              v["totalAmountPaid"] ?? res?.totalAmountPaid ?? 0
            ),
            netReceived: Number(
              v["netReceived"] ?? res?.netReceived ?? 0
            ),
            eir: Number(v["eir"] ?? res?.eir ?? 0),
            // ✅ now typed as Timestamp | FireTimestamp | number | string | Date | null
            timestamp: tsVal,
            decision: (v.decision as CalcDecision | undefined) ?? null,
            results: (res as CalcResults) ?? null,
          };
        });
        rows.sort(
          (a, b) => (toMillis(b.timestamp) ?? 0) - (toMillis(a.timestamp) ?? 0)
        );
        setIssuing(rows);
        setIssuingLoading(false);
      },
      async () => {
        try {
          const snap = await getDocs(qy);
          const rows: CalcProposal[] = snap.docs.map((d) => {
            const v = d.data() as AnyRec;
            const res = (v.results as AnyRec | null) || null;
            const tsRaw = firstDefined(v.timestamp, v.createdAt, v.created_at);
            const tsVal = (tsRaw ?? null) as TsLike;
            return {
              id: d.id,
              path: d.ref.path,
              userId: String(v.userId || ""),
              loanType: String(v.loanType || "unknown"),
              loanAmount: Number(v.loanAmount || 0),
              months: Number(v.months || 0),
              monthlyInstallment: Number(
                v["monthlyInstallment"] ?? res?.monthlyInstallment ?? 0
              ),
              totalAmountPaid: Number(
                v["totalAmountPaid"] ?? res?.totalAmountPaid ?? 0
              ),
              netReceived: Number(
                v["netReceived"] ?? res?.netReceived ?? 0
              ),
              eir: Number(v["eir"] ?? res?.eir ?? 0),
              timestamp: tsVal,
              decision: (v.decision as CalcDecision | undefined) ?? null,
              results: (res as CalcResults) ?? null,
            };
          });
          rows.sort(
            (a, b) => (toMillis(b.timestamp) ?? 0) - (toMillis(a.timestamp) ?? 0)
          );
          setIssuing(rows);
          setIssuingLoading(false);
        } catch (e: unknown) {
          setIssuingError(getErrorMessage(e));
          setIssuingLoading(false);
        }
      }
    );
    return () => unsub();
  }, []);

  async function decideProposal(
    p: CalcProposal,
    status: "approved" | "denied"
  ) {
    try {
      const note =
        typeof window !== "undefined"
          ? window.prompt(`Optional note for ${status.toUpperCase()} decision:`, "")
          : "";
      await updateDoc(fsDoc(db, p.path), {
        "decision.status": status,
        "decision.note": note || null,
        "decision.byUid": "admin",
        "decision.byEmail": "admin@essa.loans",
        "decision.at": serverTimestamp(),
      });

      await setDoc(
        fsDoc(db, "loan_issuing", p.id),
        {
          calcPath: p.path,
          calcId: p.id,
          userId: p.userId,
          loanType: p.loanType,
          loanAmount: p.loanAmount,
          months: p.months,
          monthlyInstallment: p.monthlyInstallment ?? null,
          totalAmountPaid: p.totalAmountPaid ?? null,
          netReceived: p.netReceived ?? null,
          eir: p.eir ?? null,
          status,
          note: note || null,
          decidedAt: Date.now(),
        },
        { merge: true }
      );

      if (status === "approved") {
        const k = kycIndex.byId.get(p.userId);
        const newLoanPayload: AnyRec = {
          title: "",
          firstName: k?.firstName || "",
          surname: k?.lastName || "",
          mobile: k?.mobile || "",
          email: k?.email || "",
          areaName: k?.physicalCity || "",
          loanAmount: p.loanAmount || 0,
          currentBalance: p.loanAmount || 0,
          loanPeriod: p.months || 0,
          paymentFrequency: "monthly",
          loanType: p.loanType || "unknown",
          status: "approved",
          timestamp: serverTimestamp(),
          kycId: p.userId,
          calcRefPath: p.path,
          calcRefId: p.id,
          calculatorSnapshot: {
            loanType: p.loanType,
            loanAmount: p.loanAmount,
            months: p.months,
            monthlyInstallment: p.monthlyInstallment ?? null,
            totalAmountPaid: p.totalAmountPaid ?? null,
            netReceived: p.netReceived ?? null,
            eir: p.eir ?? null,
            decidedAt: Date.now(),
          },
        };
        await setDoc(fsDoc(db, "loan_applications", p.id), newLoanPayload, {
          merge: true,
        });
      }

      pushFeedback(
        "success",
        `Proposal ${status === "approved" ? "approved" : "denied"} successfully.${status === "approved" ? " Loan created under Outstanding." : ""}`
      );
    } catch (e: unknown) {
      pushFeedback("error", `Failed to update proposal: ${getErrorMessage(e)}`);
    }
  }

  /* Derived slices */
  const outstanding = useMemo(
    () =>
      loans
        .filter(
          (r) =>
            (r.status === "approved" || r.status === "active") &&
            (r.currentBalance ?? 0) > 0
        )
        .sort(
          (a, b) => (b.currentBalance ?? 0) - (a.currentBalance ?? 0)
        ),
    [loans]
  );
  const outstandingTop = useMemo(() => outstanding.slice(0, 6), [outstanding]);

  // Updated clock based on updatedAt (avoids useMemo-on-Date anti-pattern)
  const nowDate = useMemo(() => new Date(updatedAt ?? Date.now()), [updatedAt]);
  const soonDate = useMemo(() => new Date((updatedAt ?? Date.now()) + 14 * 24 * 60 * 60 * 1000), [updatedAt]);

  const deadlinesUpcoming = useMemo(
    () =>
      loans
        .filter((r) => {
          const end = r.endDate ? new Date(r.endDate) : null;
          return (
            (r.status === "approved" || r.status === "active") &&
            (r.currentBalance ?? 0) > 0 &&
            end &&
            end >= nowDate &&
            end <= soonDate
          );
        })
        .sort(
          (a, b) =>
            new Date(a.endDate || 0).getTime() - new Date(b.endDate || 0).getTime()
        )
        .slice(0, 8),
    [loans, nowDate, soonDate]
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
            end < nowDate &&
            (r.collateralItems?.length ?? 0) > 0
          );
        })
        .sort(
          (a, b) =>
            new Date(a.endDate || 0).getTime() - new Date(b.endDate || 0).getTime()
        )
        .slice(0, 8),
    [loans, nowDate]
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
        return end && end < nowDate && (r.currentBalance ?? 0) > 0;
      }).length,
    }),
    [loans, outstanding, finished, nowDate]
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

  /* Collateral aggregation */
  const collaterals: CollateralVM[] = useMemo(() => {
    const list: CollateralVM[] = [];
    const msDay = 24 * 60 * 60 * 1000;
    const nowMs = Date.now();
    for (const loan of loans) {
      const items = Array.isArray(loan.collateralItems)
        ? loan.collateralItems
        : [];
      const borrower = fullName(loan);
      const startMs = toMillis(loan.timestamp);
      const endMs = toMillis(loan.endDate);
      const daysLeft = endMs ? Math.ceil((endMs - nowMs) / msDay) : null;
      const overdueDays = endMs && endMs < nowMs ? Math.ceil((nowMs - endMs) / msDay) : 0;
      const lateFee =
        overdueDays > 0 ? (loan.currentBalance || 0) * LATE_FEE_DAILY * overdueDays : 0;

      items.forEach((it, i) => {
        const label = collateralLabel(it);
        const estValue = collateralValue(it);
        const imageUrl = collateralImageUrl(it);
        list.push({
          key: `${loan.id}#${i}`,
          label,
          estValue: estValue ?? null,
          loanId: loan.id,
          borrower,
          mobile: loan.mobile,
          area: loan.areaName || "—",
          startMs,
          endMs,
          daysLeft,
          overdueDays,
          lateFee,
          currentBalance: loan.currentBalance || 0,
          kycId: loan.kycId,
          imageUrl,
        });
      });
    }
    return list.sort((a, b) => (b.startMs ?? 0) - (a.startMs ?? 0));
  }, [loans]);

  /* KYC badge */
  const [kycNewCount, setKycNewCount] = useState(0);
  useEffect(() => {
    const LAST_KEY = "kyc_seen_at";
    const lastSeen = Number(localStorage.getItem(LAST_KEY) || "0");
    if (!kycPending.length) {
      setKycNewCount(0);
      return;
    }
    const count = kycPending.reduce(
      (acc, r) =>
        acc +
        ((typeof r.createdAt === "number" ? r.createdAt : 0) > lastSeen
          ? 1
          : 0),
      0
    );
    setKycNewCount(count);
  }, [kycPending]);

  function markKycSeen() {
    localStorage.setItem("kyc_seen_at", String(Date.now()));
    setKycNewCount(0);
  }

  /* Modals */
  const [viewKycId, setViewKycId] = useState<string | null>(null);
  const [viewLoanId, setViewLoanId] = useState<string | null>(null);

  /* Actions for PROCESSED list */
  async function considerBackToActive(p: ProcessedLoan) {
    const original = p?.original;
    let payload: Record<string, unknown>;
    if (original && typeof original === "object" && Object.keys(original).length) {
      payload = original; // exact original doc
    } else {
      const nameParts = (p.applicantFull || "").trim().split(/\s+/);
      payload = {
        title: "",
        firstName:
          nameParts.length > 1
            ? nameParts.slice(0, -1).join(" ")
            : nameParts[0] || "",
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
      await setDoc(fsDoc(db, "loan_applications", p.id), payload, {
        merge: false,
      });
      await deleteDoc(fsDoc(db, "processed_loans", p.id));
      pushFeedback("success", "Moved back to Active successfully.");
    } catch (e: unknown) {
      pushFeedback("error", `Failed to restore: ${getErrorMessage(e)}`);
    }
  }

  async function clearProcessed(p: ProcessedLoan) {
    try {
      await updateDoc(fsDoc(db, "processed_loans", p.id), {
        cleared: true,
        clearedAt: Date.now(),
      });
      pushFeedback("success", "Record hidden from Processed.");
    } catch (e: unknown) {
      pushFeedback("error", `Failed to clear: ${getErrorMessage(e)}`);
    }
  }

  async function deleteProcessedForever(p: ProcessedLoan) {
    try {
      await deleteDoc(fsDoc(db, "processed_loans", p.id));
      pushFeedback("success", "Record deleted permanently.");
    } catch (e: unknown) {
      pushFeedback("error", `Failed to delete: ${getErrorMessage(e)}`);
    }
  }

  /* Header & KPIs */
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
  ] as const;

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

      {/* Feedback banner */}
      {feedback && (
        <div className={`mx-auto max-w-7xl px-4 sm:px-6 pt-3`}>
          <div
            className={[
              "rounded-md border px-3 py-2 text-sm",
              feedback.type === "success"
                ? "bg-emerald-50 border-emerald-200 text-emerald-800"
                : feedback.type === "error"
                ? "bg-rose-50 border-rose-200 text-rose-800"
                : "bg-slate-50 border-slate-200 text-slate-800",
            ].join(" ")}
          >
            {feedback.text}
          </div>
        </div>
      )}

      {/* ===================== MAIN (Reordered) ===================== */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-8">
        {/* KPIs */}
        <section>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {cards.map((c) => (
              <KPICard
                key={c.label}
                {...c}
                value={loansLoading ? undefined : c.value}
              />
            ))}
          </div>
        </section>

        {/* 1) Loan Detailed Overview — moved to the top */}
        <Section
          className="rounded-2xl border bg-white p-4 sm:p-6"
          title={
            <div className="text-base sm:text-lg font-semibold text-slate-900">
              Loan Detailed Overview
            </div>
          }
        >
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
                <h3 className="font-medium text-slate-800">
                  By Payment Frequency
                </h3>
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
                      loans.reduce<Record<string, number>>((m, r) => {
                        add(m, r.areaName || "—");
                        return m;
                      }, {})
                    )
                      .sort((a, b) => b[1] - a[1])
                      .slice(0, 6)
                      .map(([name, count]) => (
                        <li
                          key={name}
                          className="flex items-center justify-between text-sm"
                        >
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
        </Section>

        {/* 2) Loan Issuing (from calculator) — now below overview */}
        <Section
          title="Loan Issuing (from calculator)"
          extra={
            <div className="flex items-center gap-2">
              <Link
                href="/admin/outstanding"
                className="rounded-lg border px-2.5 py-1.5 text-xs hover:bg-slate-50"
              >
                Open Outstanding
              </Link>
              <button
                onClick={() => setIssuingExpanded((v) => !v)}
                className="rounded-lg bg-slate-900 text-white px-2.5 py-1.5 text-xs hover:bg-black"
              >
                {issuingExpanded ? "Show less" : "Show more"}
              </button>
            </div>
          }
        >
          <ResponsiveTable
            isLoading={issuingLoading}
            emptyText="No pending proposals from calculator."
            headers={[
              "Applicant",
              "Proposal",
              "Period",
              "Net Received",
              "EIR",
              "Created",
              "Actions",
            ]}
            rows={(issuingExpanded ? issuing : issuing.slice(0, 4)).map((p) => {
              const k = kycIndex.byId.get(p.userId);
              const name = k
                ? [k.firstName, k.lastName].filter(Boolean).join(" ")
                : `User: ${p.userId}`;
              return [
                <CellPrimary
                  key="a"
                  title={name || "—"}
                  subtitle={k?.mobile || k?.email || "—"}
                />,
                <div key="b">
                  <div className="font-medium text-slate-900">
                    {String(p.loanType || "").toUpperCase()}
                  </div>
                  <div className="text-xs text-slate-600">
                    MWK {money(p.loanAmount)}
                  </div>
                </div>,
                <span key="c" className="text-slate-700">
                  {p.months} mo
                </span>,
                <span key="d" className="font-medium text-slate-900">
                  MWK {money(p.netReceived || 0)}
                </span>,
                <span key="e" className="text-slate-700">
                  {isFinite(p.eir || 0) ? `${(p.eir || 0).toFixed(2)}%` : "—"}
                </span>,
                <span key="f" className="text-slate-700">
                  {fmtMaybeDate(p.timestamp)}
                </span>,
                <div key="g" className="flex items-center gap-2">
                  <button
                    onClick={() => decideProposal(p, "approved")}
                    className="rounded-lg bg-emerald-600 text-white px-2.5 py-1.5 text-xs hover:bg-emerald-700"
                  >
                    Approve
                  </button>
                  <button
                    onClick={() => decideProposal(p, "denied")}
                    className="rounded-lg bg-rose-600 text-white px-2.5 py-1.5 text-xs hover:bg-rose-700"
                  >
                    Deny
                  </button>
                  <button
                    onClick={() => setViewKycId(p.userId)}
                    className="rounded-lg border px-2.5 py-1.5 text-xs hover:bg-slate-50"
                  >
                    View KYC
                  </button>
                  <Link
                    href={`/kyc/${p.userId}`}
                    className="rounded-lg bg-blue-600 text-white px-2.5 py-1.5 text-xs hover:bg-blue-700"
                  >
                    Open KYC
                  </Link>
                </div>,
              ];
            })}
          />
          {issuingError && (
            <div className="text-xs text-rose-600 mt-2">{issuingError}</div>
          )}
        </Section>

        {/* 3) KYC to review — placed after Issuing */}
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
                      {k.mobile || "—"}
                      {k.email ? ` · ${k.email}` : ""}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Link
                      href={`/kyc/${k.id}`}
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

        {/* 4) Recent applicants — placed next */}
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

        {/* The rest (re-arranged after the priority sections) */}
        <Section title="Collateral items">
          <ResponsiveTable
            isLoading={loansLoading}
            emptyText="No collateral items found."
            headers={[
              "Image",
              "Item",
              "Borrower",
              "Balance",
              "Dates",
              "Countdown",
              "Late Fee",
              "",
            ]}
            rows={collaterals.slice(0, 25).map((c) => {
              const countdown =
                c.daysLeft === null
                  ? "—"
                  : c.daysLeft > 0
                  ? `${c.daysLeft} day${c.daysLeft === 1 ? "" : "s"} left`
                  : `Overdue by ${c.overdueDays} day${
                      c.overdueDays === 1 ? "" : "s"
                    }`;
              const chipClass =
                c.daysLeft === null
                  ? "bg-slate-100 text-slate-700"
                  : c.daysLeft > 5
                  ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                  : c.daysLeft >= 0
                  ? "bg-amber-50 text-amber-700 border-amber-200"
                  : "bg-rose-50 text-rose-700 border-rose-200";
              return [
                /* IMAGE */
                <div key="img" className="flex items-center">
                  {c.imageUrl ? (
                    <Image
                      src={c.imageUrl}
                      alt={c.label}
                      width={56}
                      height={56}
                      className="object-cover rounded-md border bg-white"
                    />
                  ) : (
                    <div className="h-14 w-14 rounded-md border bg-slate-100 grid place-items-center text-[10px] text-slate-500 px-1 text-center">
                      No image
                    </div>
                  )}
                </div>,
                /* ITEM */
                <div key="a">
                  <div className="font-medium text-slate-900">{c.label}</div>
                  {typeof c.estValue === "number" && (
                    <div className="text-xs text-slate-500">
                      Est. value: MWK {money(c.estValue)}
                    </div>
                  )}
                </div>,
                <CellPrimary
                  key="b"
                  title={c.borrower || "—"}
                  subtitle={c.mobile || c.area || "—"}
                />,
                <span key="c" className="font-medium text-slate-900">
                  MWK {money(c.currentBalance)}
                </span>,
                <span key="d" className="text-slate-700">
                  {fmtDate(c.startMs)} → {fmtDate(c.endMs)}
                </span>,
                <span
                  key="e"
                  className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs ${chipClass}`}
                >
                  {countdown}
                </span>,
                <span key="f" className="font-medium text-slate-900">
                  {c.overdueDays > 0 ? `MWK ${money(Math.ceil(c.lateFee))}` : "—"}
                </span>,
                <div key="g" className="flex items-center gap-2">
                  <button
                    onClick={() => setViewLoanId(c.loanId)}
                    className="rounded-lg border px-2.5 py-1.5 text-xs hover:bg-slate-50"
                  >
                    View loan
                  </button>
                  {c.kycId ? (
                    <Link
                      href={`/kyc/${c.kycId}`}
                      className="rounded-lg bg-blue-600 text-white px-2.5 py-1.5 text-xs hover:bg-blue-700"
                    >
                      Open KYC
                    </Link>
                  ) : (
                    <button
                      disabled
                      className="rounded-lg border px-2.5 py-1.5 text-xs opacity-60"
                      title="No KYC mapped"
                    >
                      Open KYC
                    </button>
                  )}
                </div>,
              ];
            })}
          />
        </Section>

        <div className="grid gap-4 xl:grid-cols-2">
          <Section title="Outstanding loans (top 6)">
            <ResponsiveTable
              isLoading={loansLoading}
              emptyText="No outstanding loans."
              headers={["Applicant", "Balance", "Period", "Area", "End date", ""]}
              rows={outstandingTop.map((r) => [
                <CellPrimary
                  key="a"
                  title={fullName(r)}
                  subtitle={r.mobile || "—"}
                />,
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
                <button
                  key="f"
                  onClick={() => setViewLoanId(r.id)}
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
                meta: `${fmtDate(r.endDate)} · ${r.areaName || "—"}`,
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
                meta: `Overdue since ${fmtDate(r.endDate)} · ${
                  r.areaName || "—"
                }`,
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
                chips: [
                  "Paid",
                  `${r.loanPeriod}${r.paymentFrequency === "weekly" ? "wk" : "mo"}`,
                ],
                meta: r.areaName || "—",
                onClick: () => setViewLoanId(r.id),
              }))}
            />
          </Section>

          <Section title="Processed">
            <div className="grid gap-2">
              {processedLoading && <SkeletonLine count={3} />}
              {processedError && (
                <div className="text-sm text-rose-600">{processedError}</div>
              )}
              {!processedLoading &&
                !processedError &&
                processed.filter((p) => !p.cleared).length === 0 && (
                  <div className="text-center text-slate-500">
                    No processed records yet.
                  </div>
                )}
              {!processedLoading &&
                !processedError &&
                processed
                  .filter((p) => !p.cleared)
                  .map((p) => {
                    const chips = [
                      p.processedStatus === "approved" ? "Accepted" : "Declined",
                      `MWK ${money(p.currentBalance ?? p.loanAmount ?? 0)}`,
                    ];
                    const meta = `${p.area || "—"} · ${
                      p.processedAt
                        ? new Date(toMillis(p.processedAt) || 0).toLocaleString()
                        : ""
                    }`;
                    return (
                      <div
                        key={p.id}
                        className="rounded-xl border bg-white p-3 flex items-start justify-between gap-2"
                      >
                        <div>
                          <div className="font-medium text-slate-900">
                            {p.applicantFull || "—"}
                          </div>
                          <div className="text-xs text-slate-600 mt-0.5">
                            {p.mobile || "—"}
                            {p.email ? ` · ${p.email}` : ""}
                          </div>
                          <div className="mt-1 flex flex-wrap gap-1">
                            {chips.map((c) => (
                              <span
                                key={c}
                                className="inline-flex items-center rounded-full px-2 py-0.5 text-xs border bg-slate-50 text-slate-700"
                              >
                                {c}
                              </span>
                            ))}
                          </div>
                          <div className="text-xs text-slate-500 mt-1">{meta}</div>
                        </div>
                        <div className="flex items-center gap-2">
                          <button
                            onClick={async () => {
                              if (
                                !confirm("Move back to Active (loan_applications)?")
                              )
                                return;
                              await considerBackToActive(p);
                            }}
                            className="rounded-lg bg-amber-600 text-white px-2.5 py-1.5 text-xs hover:bg-amber-700"
                            title="Restore to active"
                          >
                            Consider
                          </button>
                          <button
                            onClick={async () => {
                              if (
                                !confirm(
                                  "Hide this record from Processed (not deleted)?"
                                )
                              )
                                return;
                              await clearProcessed(p);
                            }}
                            className="rounded-lg border px-2.5 py-1.5 text-xs hover:bg-slate-50"
                            title="Hide from list (not deleted)"
                          >
                            Clear
                          </button>
                          <button
                            onClick={async () => {
                              if (
                                !confirm("Delete this processed record forever?")
                              )
                                return;
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
        </div>

        {(loansError || kycError) && (
          <div className="text-center text-xs text-rose-600 pt-2">
            {loansError || kycError}
          </div>
        )}
      </main>

      <LoanPreviewModal
        loanId={viewLoanId}
        onClose={() => setViewLoanId(null)}
        onFeedback={pushFeedback}
      />
    </div>
  );
}

/* =========================================================
   Loan Preview Modal (moves to processed on Accept/Decline)
   ========================================================= */
function LoanPreviewModal({
  loanId,
  onClose,
  onFeedback,
}: {
  loanId: string | null;
  onClose: () => void;
  onFeedback: (
    type: "success" | "error" | "info",
    text: string
  ) => void;
}) {
  const [data, setData] = useState<LoanPreview | null>(null);
  const [loanRaw, setLoanRaw] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<"accept" | "decline" | "notify" | null>(null);
  const [notifyOpen, setNotifyOpen] = useState(false);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

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
    (async () => {
      setLoading(true);
      setErr(null);
      setData(null);
      try {
        const loanSnap = await getDoc(fsDoc(db, "loan_applications", loanId));
        if (!mounted.current) return;
        if (!loanSnap.exists()) throw new Error("Loan not found");
        const lr = { id: loanSnap.id, ...loanSnap.data() } as AnyRec;
        setLoanRaw(lr);

        let kycRaw: AnyRec | null = null;
        const kycId = detectKycId(lr);
        if (kycId) {
          try {
            const kycSnap = await getDoc(fsDoc(db, "kyc_data", String(kycId)));
            if (kycSnap.exists())
              kycRaw = { id: kycSnap.id, ...kycSnap.data() } as AnyRec;
          } catch {
            // ignore
          }
        }

        const merged: AnyRec = { ...lr, kyc: kycRaw || {} };
        const first =
          (firstDefined(
            merged.firstName,
            merged["applicantFirstName"],
            merged.givenName,
            g(merged, "name.first"),
            g(merged, "applicant.name.first"),
            g(merged, "kyc.firstName"),
            g(merged, "kyc.applicantFirstName"),
            g(merged, "kyc.givenName"),
            g(merged, "kyc.name.first")
          ) as string | undefined) ||
          (typeof merged.name === "string"
            ? merged.name.split(/\s+/).slice(0, -1).join(" ")
            : undefined);
        const last =
          (firstDefined(
            merged.surname,
            merged.lastName,
            merged["applicantLastName"],
            merged.familyName,
            g(merged, "name.last"),
            g(merged, "applicant.name.last"),
            g(merged, "kyc.surname"),
            g(merged, "kyc.lastName"),
            g(merged, "kyc.applicantLastName"),
            g(merged, "kyc.familyName"),
            g(merged, "kyc.name.last")
          ) as string | undefined) ||
          (typeof merged.name === "string"
            ? merged.name.split(/\s+/).slice(-1)[0]
            : undefined);

        const applicantFull = [merged.title as string, first, last]
          .filter(Boolean)
          .join(" ") || "—";

        const mobile =
          (firstDefined(
            merged["mobileTel"],
            merged["mobileTel1"],
            merged.mobile,
            merged["phone"],
            merged["phoneNumber"],
            g(merged, "contact.phone"),
            g(merged, "contact.mobile"),
            g(merged, "kyc.mobileTel1"),
            g(merged, "kyc.mobile"),
            g(merged, "kyc.phone"),
            g(merged, "kyc.phoneNumber")
          ) as string | undefined) || "—";

        const email =
          (firstDefined(
            merged.email,
            g(merged, "contact.email"),
            g(merged, "kyc.email1"),
            g(merged, "kyc.email")
          ) as string | undefined) || "";

        const area =
          (firstDefined(
            merged.areaName,
            merged.physicalCity,
            merged.city,
            merged.addressCity,
            g(merged, "address.city"),
            g(merged, "location.city"),
            merged.town,
            merged.village,
            g(merged, "kyc.physicalCity"),
            g(merged, "kyc.areaName")
          ) as string | undefined) || "—";

        const rawStatus = firstDefined(
          merged.status,
          merged["loanStatus"],
          merged["applicationStatus"],
          merged.state,
          g(merged, "kyc.status")
        );
        const status = (() => {
          const s = typeof rawStatus === "string" ? rawStatus.toLowerCase() : rawStatus;
          if (s === "finished" || s === "complete" || s === "completed")
            return "closed";
          return String(s) || "pending";
        })();

        const startRaw = firstDefined(
          merged.timestamp,
          merged["startDate"],
          merged["start_date"],
          merged["createdAt"],
          merged["created_at"],
          g(merged, "kyc.timestamp"),
          g(merged, "kyc.createdAt")
        );
        const explicitEnd = firstDefined(
          merged.endDate,
          merged["loanEndDate"],
          merged["expectedEndDate"],
          merged["maturityDate"],
          merged["end_date"],
          g(merged, "kyc.endDate")
        );
        let endMs = toMillis(explicitEnd);
        if (!endMs) {
          const periodRaw = firstDefined(
            merged["loanPeriod"],
            merged["period"],
            merged["term"],
            merged["tenorMonths"],
            merged["tenorWeeks"]
          );
          const freqRaw = firstDefined(
            merged["paymentFrequency"],
            merged["frequency"],
            merged["repaymentFrequency"]
          );
          const freq = String(freqRaw || "monthly").toLowerCase() as
            | "weekly"
            | "monthly";
          const period = Number(periodRaw || 0);
          endMs = computeEndDate(startRaw, period, freq)?.getTime() ?? null;
        }

        const view: LoanPreview = {
          id: String(merged.id),
          applicantFull,
          mobile,
          email,
          status: status as string,
          area,
          loanAmount: Number(firstDefined(merged["loanAmount"], 0)),
          currentBalance: Number(
            firstDefined(
              merged["currentBalance"],
              merged["loanAmount"],
              0
            )
          ),
          period: Number(
            firstDefined(
              merged["loanPeriod"],
              merged["period"],
              0
            )
          ),
          frequency: String(
            firstDefined(
              merged["paymentFrequency"],
              merged["frequency"],
              "monthly"
            )
          ).toLowerCase(),
          startMs: toMillis(startRaw),
          endMs: endMs || null,
          collateralItems: Array.isArray(merged["collateralItems"])
            ? (merged["collateralItems"] as unknown[])
            : [],
        };
        if (mounted.current) setData(view);
      } catch (e: unknown) {
        if (mounted.current) setErr(getErrorMessage(e));
      } finally {
        if (mounted.current) setLoading(false);
      }
    })();
  }, [loanId]);

  if (!loanId) return null;

  const endDate = data?.endMs ? new Date(data.endMs).toLocaleDateString() : "—";
  const startStr = data?.startMs
    ? new Date(data.startMs).toLocaleString()
    : "—";

  async function moveToProcessed(next: "approved" | "declined") {
    if (!loanId || !data) return;
    const busyKey: "accept" | "decline" = next === "approved" ? "accept" : "decline";
    setBusy(busyKey);
    try {
      try {
        await updateDoc(fsDoc(db, "loan_applications", loanId), { status: next });
      } catch {
        // best-effort
      }
      const processedDoc: ProcessedLoan & Record<string, unknown> = {
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
        original: loanRaw ?? {},
        cleared: false,
      };
      await setDoc(fsDoc(db, "processed_loans", loanId), processedDoc);
      await deleteDoc(fsDoc(db, "loan_applications", loanId));
      onFeedback(
        "success",
        `Loan ${next === "approved" ? "approved" : "declined"} and moved to Processed.`
      );
      onClose();
    } catch (e: unknown) {
      onFeedback("error", `Failed to move to processed: ${getErrorMessage(e)}`);
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
            <button
              onClick={onClose}
              className="rounded-lg border px-2 py-1 text-sm hover:bg-slate-50"
            >
              Close
            </button>
          </div>
          <div className="p-4">
            {loading && <SkeletonLine count={6} />}
            {err && (
              <div className="rounded-md bg-rose-50 border border-rose-200 text-rose-800 text-sm px-3 py-2">
                Failed to load: {err}
              </div>
            )}
            {!loading && !err && data && (
              <div className="grid gap-3 text-sm">
                <KV label="Applicant" value={data.applicantFull || "—"} />
                <KV label="Mobile" value={data.mobile || "—"} />
                <KV label="Email" value={data.email || "—"} />
                <KV label="Status" value={String(data.status || "—")} />
                <KV label="Area" value={data.area || "—"} />
                <KV label="Loan Amount" value={`MWK ${money(data.loanAmount)}`} />
                <KV
                  label="Current Balance"
                  value={`MWK ${money(data.currentBalance)}`}
                />
                <KV
                  label="Period"
                  value={`${data.period} ${
                    data.frequency === "weekly" ? "wk" : "mo"
                  }`}
                />
                <KV label="Start" value={startStr} />
                <KV label="End" value={endDate} />
                {Array.isArray(data.collateralItems) &&
                  data.collateralItems.length > 0 && (
                    <div>
                      <div className="text-slate-500 mb-1">Collateral</div>
                      <div className="flex flex-wrap gap-2">
                        {data.collateralItems.map((it, i) => {
                          const label = collateralLabel(it);
                          const color = pickColor(label);
                          const thumb = collateralImageUrl(it);
                          return (
                            <span
                              key={i}
                              className="inline-flex items-center gap-2 rounded-full px-2.5 py-1 text-xs font-medium border"
                              style={{ borderColor: color, color }}
                            >
                              {thumb ? (
                                <Image
                                  src={thumb}
                                  alt=""
                                  width={20}
                                  height={20}
                                  className="rounded object-cover"
                                />
                              ) : null}
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
    } catch (e: unknown) {
      setError(getErrorMessage(e));
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
            <Button onClick={onClose} variant="danger">Cancel</Button>
            <button type="submit" disabled={sending} className="rounded-lg bg-blue-600 text-white px-3 py-1.5 text-sm hover:bg-blue-700 disabled:opacity-60">
              {sending ? "Sending…" : "Send Email"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function Button({ onClick, children, variant = "default" }: { onClick?: () => void; children: React.ReactNode; variant?: "default" | "danger" }) {
  const cls = variant === "danger"
    ? "rounded-lg bg-red-600 text-white border px-3 py-1.5 text-sm hover:bg-red-700"
    : "rounded-lg border px-3 py-1.5 text-sm hover:bg-slate-50";
  return (
    <button onClick={onClick} className={cls}>
      {children}
    </button>
  );
}

/* =========================================================
   KYC Preview Modal (includes ID/selfie images)
   ========================================================= */
function KycPreviewModal({ kycId, onClose }: { kycId: string | null; onClose: () => void; }) {
  const [data, setData] = useState<AnyRec | null>(null);
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
      } catch (e: unknown) {
        if (!mounted.current) return;
        setErr(getErrorMessage(e));
        setLoading(false);
      }
    })();
  }, [kycId]);

  if (!kycId) return null;

  const idFront = toDataUrlMaybe(asString(data?.idFrontImageBase64));
  const idBack = toDataUrlMaybe(asString(data?.idBackImageBase64));
  const selfie = toDataUrlMaybe(asString(data?.selfieImageBase64));

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
            {err && <div className="rounded-md bg-rose-50 border border-rose-200 text-rose-800 text-sm px-3 py-2">Failed to load KYC: {err}</div>}
            {!isLoading && !err && (
              <div className="grid gap-3 text-sm">
                <KV
                  label="Name"
                  value={[data?.title, data?.firstName ?? data?.applicantFirstName, data?.lastName ?? data?.surname ?? data?.applicantLastName].filter(Boolean).join(" ") || "—"}
                />
                <KV label="ID Number" value={String(data?.idNumber || "—")} />
                <KV label="Gender" value={String(data?.gender || "—")} />
                <KV label="Date of Birth" value={fmtMaybeDate(data?.dateOfBirth)} />
                <KV label="Email" value={String(data?.email1 || data?.email || "—")} />
                <KV label="Mobile" value={String(data?.mobileTel1 || data?.mobile || "—")} />
                <KV label="Address / City" value={String(data?.physicalAddress || data?.physicalCity || data?.areaName || "—")} />
                <KV label="Employer" value={String(data?.employer || "—")} />
                <KV label="Dependants" value={String(data?.dependants ?? "—")} />
                <KV label="Next of Kin" value={`${data?.familyName || "—"} (${data?.familyRelation || "—"})${data?.familyMobile ? " · " + data?.familyMobile : ""}`} />
                {(idFront || idBack || selfie) && (
                  <div className="mt-2">
                    <div className="text-slate-500 mb-1">Identity Images</div>
                    <div className="grid grid-cols-3 gap-2">
                      <div className="relative rounded-md border bg-slate-50 overflow-hidden min-h-[80px] grid place-items-center">
                        {idFront ? <Image src={idFront} alt="ID Front" fill className="object-cover" /> : <span className="text-xs text-slate-500 p-2">ID Front not available</span>}
                      </div>
                      <div className="relative rounded-md border bg-slate-50 overflow-hidden min-h-[80px] grid place-items-center">
                        {idBack ? <Image src={idBack} alt="ID Back" fill className="object-cover" /> : <span className="text-xs text-slate-500 p-2">ID Back not available</span>}
                      </div>
                      <div className="relative rounded-md border bg-slate-50 overflow-hidden min-h-[80px] grid place-items-center">
                        {selfie ? <Image src={selfie} alt="Selfie" fill className="object-cover" /> : <span className="text-xs text-slate-500 p-2">Selfie not available</span>}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
          <div className="p-4 border-t text-right">
            <Link href={`/kyc/${kycId}`} className="inline-flex items-center rounded-lg bg-blue-600 text-white px-3 py-1.5 text-sm hover:bg-blue-700">
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

function Section({ title, extra, children, className }: { title: React.ReactNode; extra?: React.ReactNode; children: React.ReactNode; className?: string; }) {
  return (
    <section className={`rounded-2xl border bg-white p-4 sm:p-5 ${className || ""}`}>
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
                {r.map((c, j) => (<td key={j} className="p-3 align-middle whitespace-nowrap">{c}</td>))}</tr>
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
