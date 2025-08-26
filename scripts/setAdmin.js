// scripts/setAdmin.js
import admin from "firebase-admin";
import fs from "fs";

// path to your downloaded service account key
const serviceAccount = JSON.parse(
  fs.readFileSync("./serviceAccountKey.json", "utf8")
);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const email = process.argv[2]; // pass email as arg: node scripts/setAdmin.js admin@essa-loans.com

async function run() {
  if (!email) throw new Error("Pass an email: node scripts/setAdmin.js email");
  const user = await admin.auth().getUserByEmail(email);
  await admin.auth().setCustomUserClaims(user.uid, { admin: true });
  console.log(`✅ Set admin=true for ${email} (uid: ${user.uid})`);
  process.exit(0);
}

run().catch((e) => { console.error(e); process.exit(1); });
