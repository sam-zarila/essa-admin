// scripts/set-claim.mjs
import admin from "firebase-admin";
import { readFileSync } from "fs";

// Uses your root file: ./service-account.json
const serviceAccount = JSON.parse(readFileSync("./service-account.json", "utf8"));

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const email = process.argv[2];            // e.g. admin@essa-loans.com
const claimKey = process.argv[3] || "admin"; // "admin" or "officer"
const claimVal = process.argv[4] ? process.argv[4] === "true" : true;

if (!email) {
  console.error("Usage: node scripts/set-claim.mjs <email> [claimKey] [true|false]");
  process.exit(1);
}

const user = await admin.auth().getUserByEmail(email);
const oldClaims = user.customClaims || {};
await admin.auth().setCustomUserClaims(user.uid, { ...oldClaims, [claimKey]: claimVal });

console.log(`✅ Set ${claimKey}=${claimVal} for ${email} (uid: ${user.uid})`);
process.exit(0);
