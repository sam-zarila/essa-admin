// app/lib/firebase-admin.ts
import admin from "firebase-admin";
import fs from "fs";
import path from "path";

// Keep a single app instance in dev/hot-reload
declare global {
  // eslint-disable-next-line no-var
  var __FIREBASE_ADMIN__: admin.app.App | undefined;
}

type ServiceAccountJson = {
  project_id: string;
  client_email: string;
  private_key: string;
  // other fields are fine, we only require the three above
};

function loadServiceAccount(): ServiceAccountJson {
  // Try a few common relative spots (project root preferred)
  const candidates = [
    path.join(process.cwd(), "service-account.json"),
    path.join(process.cwd(), "./service-account.json"),
    path.join(process.cwd(), "app", "service-account.json"),
  ];

  let lastErr: unknown = null;
  for (const p of candidates) {
    try {
      const raw = fs.readFileSync(p, "utf8");
      const json = JSON.parse(raw);

      if (typeof json?.private_key === "string") {
        // Fix escaped newlines common in env/file copies
        json.private_key = json.private_key.replace(/\\n/g, "\n");
      }

      if (!json?.project_id || !json?.client_email || !json?.private_key) {
        throw new Error(`Invalid key (missing project_id/client_email/private_key) at ${p}`);
      }

      // Helpful log to confirm which project we’re using
      console.log(`[firebase-admin] Loaded service-account from ${p} (project_id=${json.project_id})`);
      return json as ServiceAccountJson;
    } catch (e) {
      lastErr = e;
      // try next candidate
    }
  }

  // Hard fail — better than silently using ADC and getting UNAUTHENTICATED
  throw new Error(
    `[firebase-admin] service-account.json not found or invalid near project root. Last error: ${String(
      lastErr
    )}`
  );
}

function getAdminApp(): admin.app.App {
  if (global.__FIREBASE_ADMIN__) return global.__FIREBASE_ADMIN__;

  if (!admin.apps.length) {
    const svc = loadServiceAccount();

    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: svc.project_id,
        clientEmail: svc.client_email,
        privateKey: svc.private_key,
      }),
    });
  }

  global.__FIREBASE_ADMIN__ = admin.app();
  return global.__FIREBASE_ADMIN__;
}

export function adminDb() {
  return getAdminApp().firestore();
}

export function adminAuth() {
  return getAdminApp().auth();
}
