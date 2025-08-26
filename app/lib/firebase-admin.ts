// lib/firebase-admin.ts
import admin from "firebase-admin";

let app: admin.app.App | null = null;

export function adminApp() {
  if (app) return app;
  if (admin.apps.length) {
    app = admin.app();
  } else {
    // Uses GOOGLE_APPLICATION_CREDENTIALS env var to your service-account.json
    app = admin.initializeApp({
      credential: admin.credential.applicationDefault(),
    });
  }
  return app;
}

export function adminAuth() {
  return adminApp().auth();
}

export function adminDb() {
  return adminApp().firestore();
}
