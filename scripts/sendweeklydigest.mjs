// Sends the weekly plantation drive digest email.
// Reads the latest digest snapshot (subject + body) that the dashboard pushes
// to Firestore every time it syncs, then emails it via Gmail SMTP.
// Runs on a schedule via .github/workflows/weeklydigest.yml — no dependency
// on anyone having the dashboard open.
//
// Reads Firestore with a service account (via firebase-admin), not a plain
// unauthenticated request — the Firestore rules require a signed-in
// @bh.edu.pk Google account, which GitHub Actions can't do, so this job
// needs its own machine credential instead.

import nodemailer from 'nodemailer';
import admin from 'firebase-admin';

const { GMAIL_USER, GMAIL_APP_PASSWORD, DIGEST_RECIPIENTS, FIREBASE_SERVICE_ACCOUNT_KEY } = process.env;

function requireEnv(name, value) {
  if (!value || !value.trim()) {
    console.error(`Missing required environment variable/secret: ${name}`);
    process.exit(1);
  }
}

requireEnv('GMAIL_USER', GMAIL_USER);
requireEnv('GMAIL_APP_PASSWORD', GMAIL_APP_PASSWORD);
requireEnv('DIGEST_RECIPIENTS', DIGEST_RECIPIENTS);
requireEnv('FIREBASE_SERVICE_ACCOUNT_KEY', FIREBASE_SERVICE_ACCOUNT_KEY);

const recipients = DIGEST_RECIPIENTS.split(/[\n,]/).map(s => s.trim()).filter(s => s.includes('@'));
if (!recipients.length) {
  console.error('DIGEST_RECIPIENTS did not contain any valid email addresses.');
  process.exit(1);
}

let serviceAccount;
try {
  serviceAccount = JSON.parse(FIREBASE_SERVICE_ACCOUNT_KEY);
} catch (e) {
  console.error('FIREBASE_SERVICE_ACCOUNT_KEY is not valid JSON — paste the full contents of the downloaded service account key file.');
  process.exit(1);
}

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

async function fetchDigest() {
  const doc = await db.collection('meta').doc('digest').get();
  if (!doc.exists) {
    return {
      subject: '🌱 Weekly Plantation Drive Update',
      body: 'No digest data available yet — open the dashboard at least once before this runs to generate this week\'s summary.',
    };
  }
  const data = doc.data();
  return {
    subject: data.subject || '🌱 Weekly Plantation Drive Update',
    body: data.body || 'No digest data available yet — open the dashboard at least once before this runs to generate this week\'s summary.',
  };
}

async function main() {
  const { subject, body } = await fetchDigest();

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
  });

  await transporter.sendMail({
    from: GMAIL_USER,
    to: recipients.join(','),
    subject,
    text: body,
  });

  console.log(`Digest sent to ${recipients.length} recipient(s): ${recipients.join(', ')}`);
}

main().catch(err => {
  console.error('Failed to send weekly digest:', err.message);
  process.exit(1);
});
