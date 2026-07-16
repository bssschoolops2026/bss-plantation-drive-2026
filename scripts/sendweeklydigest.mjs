// Sends the weekly plantation drive digest email.
// Reads clusters + dispatches directly from Firestore and builds the summary
// itself, at send time — no dependency on anyone having opened the dashboard
// or logged a dispatch recently. Runs on a schedule via
// .github/workflows/weeklydigest.yml, independent of the dashboard entirely.
//
// Reads Firestore with a service account (via firebase-admin), not a plain
// unauthenticated request — the Firestore rules require a signed-in
// @bh.edu.pk or @beaconhouse.net Google account, which GitHub Actions can't
// do, so this job needs its own machine credential instead.

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

// ─── Same math the dashboard uses (kept in sync by hand — see index.html) ────
function fmt(n) { return Math.round(n).toLocaleString(); }
function fmtD(d) { return d ? new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—'; }
function daysUntil(d, today) { return d ? Math.floor((new Date(d) - today) / 86400000) : null; }
function status(s) { if (s.dispatched >= s.required) return 'done'; if (s.dispatched > 0) return 'partial'; return 'pending'; }
function remaining(s) { return Math.max(0, s.required - s.dispatched); }

async function loadSchools() {
  const [clustersSnap, dispatchesSnap] = await Promise.all([
    db.collection('clusters').get(),
    db.collection('dispatches').get(),
  ]);
  const schools = clustersSnap.docs
    .map(doc => { const data = doc.data(); return { ...data, id: parseInt(data.id, 10) }; })
    .filter(s => !s.deleted);
  const totals = new Map();
  dispatchesSnap.docs.forEach(doc => {
    const d = doc.data();
    if (d.deleted) return;
    const key = String(d.schoolId);
    totals.set(key, (totals.get(key) || 0) + (d.qty || 0));
  });
  schools.forEach(s => { s.dispatched = totals.get(String(s.id)) || 0; });
  return schools;
}

async function loadProjectName() {
  try {
    const doc = await db.collection('meta').doc('settings').get();
    return (doc.exists && doc.data().projectName) || 'BHS Plantation Drive';
  } catch (e) {
    return 'BHS Plantation Drive';
  }
}

function buildDigestBody(schools, projectName, today) {
  const tot = schools.reduce((a, s) => a + s.required, 0);
  const dis = schools.reduce((a, s) => a + s.dispatched, 0);
  const rem = schools.reduce((a, s) => a + remaining(s), 0);
  const thisWeek = schools.filter(s => { const d = daysUntil(s.plantingDate, today); return d !== null && d >= 0 && d <= 7 && status(s) !== 'done'; })
    .sort((a, b) => new Date(a.plantingDate) - new Date(b.plantingDate));
  const next7 = schools.filter(s => { const d = daysUntil(s.plantingDate, today); return d !== null && d > 7 && d <= 14 && status(s) !== 'done'; })
    .sort((a, b) => new Date(a.plantingDate) - new Date(b.plantingDate));
  const overdue = schools.filter(s => { const d = daysUntil(s.plantingDate, today); return d !== null && d < 0 && status(s) !== 'done'; });
  const top5 = schools.filter(s => status(s) !== 'done').sort((a, b) => remaining(b) - remaining(a)).slice(0, 5);

  let body = `🌱 WEEKLY PLANTATION DRIVE UPDATE\n${'='.repeat(36)}\nWeek of ${today.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}\n\n`;
  body += `OVERALL PROGRESS\n${'─'.repeat(20)}\nTotal ordered:  ${fmt(tot)}\nDispatched:     ${fmt(dis)} (${tot > 0 ? Math.round(dis / tot * 100) : 0}%)\nRemaining:      ${fmt(rem)}\nClusters done:  ${schools.filter(s => status(s) === 'done').length} of ${schools.length}\n\n`;
  if (overdue.length) {
    body += `⚠️  OVERDUE (missed planting date)\n${'─'.repeat(36)}\n`;
    overdue.forEach(s => { const d = Math.abs(daysUntil(s.plantingDate, today)); body += `• ${s.cluster} (${s.city}) — ${fmt(remaining(s))} plants — ${d}d overdue\n`; });
    body += '\n';
  }
  if (thisWeek.length) {
    body += `📅 THIS WEEK'S DISPATCHES (0–7 days)\n${'─'.repeat(36)}\n`;
    thisWeek.forEach(s => {
      const d = daysUntil(s.plantingDate, today);
      body += `• ${s.cluster} (${s.city}) — ${fmt(remaining(s))} plants — Planting ${fmtD(s.plantingDate)} (${d === 0 ? 'today' : d === 1 ? 'tomorrow' : d + 'd'})\n  Contact: ${s.convenor || '—'} · ${s.contact || '—'}\n`;
    });
    body += '\n';
  } else {
    body += `✅  No planting dates this week.\n\n`;
  }
  if (next7.length) {
    body += `🗓️  UPCOMING (8–14 days)\n${'─'.repeat(36)}\n`;
    next7.forEach(s => { body += `• ${s.cluster} (${s.city}) — ${fmt(remaining(s))} plants — ${fmtD(s.plantingDate)}\n`; });
    body += '\n';
  }
  body += `TOP 5 PENDING (by quantity)\n${'─'.repeat(36)}\n`;
  top5.forEach((s, i) => { body += `${i + 1}. ${s.cluster} (${s.city}) — ${fmt(remaining(s))} plants remaining\n`; });
  body += `\nPrepared by: ${projectName} System`;
  return body;
}

async function main() {
  const today = new Date();
  const [schools, projectName] = await Promise.all([loadSchools(), loadProjectName()]);
  const subject = `🌱 ${projectName} Weekly Update — ${today.toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })}`;
  const body = buildDigestBody(schools, projectName, today);

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
