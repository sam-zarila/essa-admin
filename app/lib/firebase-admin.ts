// app/lib/firebase-admin.ts
import admin from "firebase-admin";
import path from "path";
import fs from "fs";

let app: admin.app.App | null = null;

function loadServiceAccount(): admin.credential.Credential {
  try {
    const p = path.join(process.cwd(), "service-account.json"); // relative path
    const json = JSON.parse(fs.readFileSync(p, "utf8"));
    return admin.credential.cert(json as admin.ServiceAccount);
  } catch (e) {
    // Fallback if file missing – will work if env/ADC is configured
    return admin.credential.applicationDefault();
  }
}

export function adminApp() {
  if (app) return app;
  if (admin.apps.length) app = admin.app();
  else {
    app = admin.initializeApp({
      credential: loadServiceAccount(),
    });
  }
  return app;
}

export function adminDb() {
  return adminApp().firestore();
}
