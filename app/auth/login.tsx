"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { signInWithEmailAndPassword, getIdTokenResult, signOut } from "firebase/auth";
import { auth } from "../lib/firebase";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const cred = await signInWithEmailAndPassword(auth, email.trim(), password);
      const token = await getIdTokenResult(cred.user, true);
      const claims = token.claims as any;
      const allowed = claims?.admin === true || claims?.officer === true; // RBAC gate
      if (!allowed) {
        await signOut(auth);
        throw new Error("Your account doesn't have admin access. Contact a system admin.");
      }
      router.push("/admin");
    } catch (err: any) {
      const msg = mapFirebaseError(err);
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen w-full bg-gradient-to-br from-blue-50 via-white to-slate-100 flex">
      {/* Left brand panel (hidden on small screens) */}
      <aside className="hidden lg:flex w-[42%] min-h-full bg-gradient-to-br from-blue-700 via-blue-600 to-indigo-700 text-white p-10 flex-col justify-between">
        <div>
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-xl bg-white/15 backdrop-blur flex items-center justify-center font-bold">EL</div>
            <span className="text-xl font-semibold">ESSA Loans — Admin</span>
          </div>
          <p className="mt-10 text-white/80 leading-relaxed max-w-md">
            Review KYC, manage applications, approve or reject loans, and record payments from a single, secure dashboard.
          </p>
        </div>
        <div className="text-sm text-white/70">© {new Date().getFullYear()} ESSA Loans</div>
      </aside>

      {/* Right form area */}
      <main className="flex-1 grid place-items-center p-4">
        <div className="w-full max-w-md">
          <div className="bg-white/80 backdrop-blur shadow-xl rounded-2xl p-6 sm:p-8">
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-slate-900">Admin Sign In</h1>
            <p className="mt-2 text-slate-600 text-sm">Use your staff email and password.</p>

            {error && (
              <div className="mt-4 rounded-lg border border-red-200 bg-red-50 text-red-800 px-3 py-2 text-sm">
                {error}
              </div>
            )}

            <form onSubmit={handleSubmit} className="mt-6 space-y-4">
              <div>
                <label htmlFor="email" className="block text-sm font-medium text-slate-700">
                  Email
                </label>
                <input
                  id="email"
                  type="email"
                  autoComplete="email"
                  inputMode="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="mt-1 w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-slate-900 shadow-sm outline-none ring-0 focus:border-blue-500"
                  placeholder="you@company.com"
                />
              </div>

              <div>
                <div className="flex items-center justify-between">
                  <label htmlFor="password" className="block text-sm font-medium text-slate-700">
                    Password
                  </label>
                  <button
                    type="button"
                    onClick={() => setShowPw((s) => !s)}
                    className="text-xs text-blue-700 hover:underline"
                  >
                    {showPw ? "Hide" : "Show"}
                  </button>
                </div>
                <div className="mt-1 relative">
                  <input
                    id="password"
                    type={showPw ? "text" : "password"}
                    autoComplete="current-password"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 pr-10 text-slate-900 shadow-sm outline-none focus:border-blue-500"
                    placeholder="••••••••"
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={loading}
                className="mt-2 inline-flex w-full items-center justify-center rounded-xl bg-blue-600 px-4 py-2.5 text-white font-semibold shadow hover:bg-blue-700 disabled:opacity-60"
              >
                {loading ? (
                  <span className="inline-flex items-center gap-2">
                    <Spinner /> Signing in…
                  </span>
                ) : (
                  "Sign in"
                )}
              </button>

              <p className="text-xs text-slate-500 mt-2">
                By signing in you agree to the Acceptable Use Policy. Unauthorized access is prohibited.
              </p>
            </form>
          </div>

          {/* Mobile footer brand */}
          <div className="mt-6 flex items-center justify-center gap-2 text-slate-500 lg:hidden">
            <div className="h-8 w-8 rounded-lg bg-blue-600 text-white grid place-items-center font-bold">EL</div>
            <span className="text-sm">ESSA Loans — Admin</span>
          </div>
        </div>
      </main>
    </div>
  );
}

function Spinner() {
  return (
    <svg className="h-5 w-5 animate-spin" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"></path>
    </svg>
  );
}

function mapFirebaseError(err: any): string {
  const code = err?.code || err?.message || "unknown";
  if (typeof code === "string") {
    if (code.includes("auth/invalid-credential")) return "Invalid email or password.";
    if (code.includes("auth/user-not-found")) return "No user found with that email.";
    if (code.includes("auth/wrong-password")) return "Wrong password.";
    if (code.includes("auth/too-many-requests")) return "Too many attempts. Try again later.";
    if (code.includes("auth/network-request-failed")) return "Network error. Check your connection.";
  }
  return typeof err?.message === "string" ? err.message : "Sign-in failed.";
}
