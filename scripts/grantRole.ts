// npx ts-node scripts/grantRole.ts admin somebody@company.com
import admin from "firebase-admin";

const [,, role, email] = process.argv;
if (!role || !email) {
  console.error("Usage: ts-node scripts/grantRole.ts <admin|officer> <email>");
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(require("../service-account.json")),
});

(async () => {
  const user = await admin.auth().getUserByEmail(email).catch(async () => {
    // (Optional) create user if not found; otherwise remove this block:
    return admin.auth().createUser({ email, password: Math.random().toString(36).slice(2) });
  });

  const claims: Record<string, boolean> = { [role]: true };
  // Merge with existing claims if needed
  const existing = (await admin.auth().getUser(user.uid)).customClaims || {};
  await admin.auth().setCustomUserClaims(user.uid, { ...existing, ...claims });

  // Force clients to refresh ID token and pick up the new claims
  await admin.auth().revokeRefreshTokens(user.uid);

  console.log(`✅ Set claim { ${role}: true } for ${email} (uid: ${user.uid}).`);
  process.exit(0);
})();
