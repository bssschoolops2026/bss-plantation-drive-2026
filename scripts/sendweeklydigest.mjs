// Sends the weekly plantation drive digest email.
// Reads the latest digest snapshot (subject + body) that the dashboard pushes
// to Firestore every time it syncs, then emails it via Gmail SMTP.
// Runs on a schedule via .github/workflows/weekly-digest.yml — no dependency
// on anyone having the dashboard open.

import nodemailer from 'nodemailer';

const { GMAIL_USER, GMAIL_APP_PASSWORD, DIGEST_RECIPIENTS, FIREBASE_PROJECT_ID } = process.env;

function requireEnv(name, value) {
  if (!value || !value.trim()) {
    console.error(`Missing required environment variable/secret: ${name}`);
    process.exit(1);
  }
}

requireEnv('GMAIL_USER', GMAIL_USER);
requireEnv('GMAIL_APP_PASSWORD', GMAIL_APP_PASSWORD);
requireEnv('DIGEST_RECIPIENTS', DIGEST_RECIPIENTS);
requireEnv('FIREBASE_PROJECT_ID', FIREBASE_PROJECT_ID);

const recipients = DIGEST_RECIPIENTS.split(/[\n,]/).map(s => s.trim()).filter(s => s.includes('@'));
if (!recipients.length) {
  console.error('DIGEST_RECIPIENTS did not contain any valid email addresses.');
  process.exit(1);
}

async function fetchDigest() {
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/meta/digest`;
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`Firestore read failed: HTTP ${resp.status} — ${await resp.text()}`);
  }
  const data = await resp.json();
  const fields = data.fields || {};
  const subject = fields.subject?.stringValue || '🌱 Weekly Plantation Drive Update';
  const body = fields.body?.stringValue ||
    'No digest data available yet — open the dashboard at least once before this runs to generate this week\'s summary.';
  return { subject, body };
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
