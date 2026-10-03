import { mkdirSync } from 'node:fs';
import express from 'express';
import rateLimit from 'express-rate-limit';
import { probe, classifyError, PROVIDER } from './llm.mjs';
import { BUSINESS, SERVICES, TECHNICIANS } from './config.mjs';
import { openDb, seedUpcoming, purgeOld, schedule, recentHandoffs, book, nowLocal, availableSlots } from './db.mjs';
import { respond, AiUnavailable, MODEL } from './agent.mjs';
import { LIMITS, issueChallenge, verifyChallenge, createSession, getSession, initUsage, usageToday, aiBlocked, recordUsage } from './guard.mjs';

const PORT = Number(process.env.PORT ?? 5190);
mkdirSync('data', { recursive: true });
const db = openDb();
initUsage(db);
seedUpcoming(db);
purgeOld(db);
setInterval(() => { seedUpcoming(db); purgeOld(db); }, 60 * 60_000).unref();

// Is the AI provider usable? A 1-token probe at start and every 15 minutes. With no credit
// the request is refused and costs nothing; with credit it costs a fraction of a cent.
const aiHealth = { ok: null };
async function probeAi() { aiHealth.ok = await probe(); }
if (LIMITS.aiEnabled) { probeAi(); setInterval(probeAi, 15 * 60_000).unref(); }
const aiStatus = () => aiBlocked(db) ?? (aiHealth.ok === false ? 'paused' : 'ok');

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '16kb' }));
// Small files, frequent redeploys: always revalidate (ETags keep repeat loads cheap).
app.use(express.static('public', { setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') }));

const limiter = (limit, windowMinutes) => rateLimit({
  windowMs: windowMinutes * 60_000, limit, standardHeaders: 'draft-8', legacyHeaders: false,
  message: { error: 'Too many requests from your connection. Please wait a few minutes.' },
});

app.get('/health', (_req, res) => res.json({ ok: true }));

// Static facts the page needs to draw the schedule.
app.get('/api/config', (_req, res) => {
  const now = nowLocal();
  res.json({
    business: { name: BUSINESS.name, city: BUSINESS.city, phone: BUSINESS.phone, hours: BUSINESS.hours },
    technicians: TECHNICIANS,
    services: Object.fromEntries(Object.entries(SERVICES).map(([k, s]) => [k, { label: s.label, minutes: s.minutes }])),
    today: now.toISODate(), now: now.toFormat('HH:mm'),
    limits: { messagesPerSession: LIMITS.messagesPerSession, maxMessageChars: LIMITS.maxMessageChars },
  });
});

app.get('/api/schedule', limiter(120, 1), (req, res) => {
  const days = Math.min(Math.max(Number(req.query.days) || 6, 1), 14);
  const u = usageToday(db);
  res.json({
    bookings: schedule(db, nowLocal(), days),
    handoffs: recentHandoffs(db),
    ai: { status: aiStatus(), spentToday: Number(u.cost_usd.toFixed(4)), budget: LIMITS.dailyBudgetUsd },
  });
});

// Real open times for a service (no AI involved). The example conversation uses these.
app.get('/api/slots', limiter(60, 10), (req, res) => {
  const service = SERVICES[req.query.service] ? req.query.service : 'repair';
  res.json(availableSlots(db, service, null, null, { limit: 6 }));
});

// Step 1: the browser asks for a proof-of-work puzzle.
app.get('/api/challenge', limiter(20, 10), (_req, res) => res.json(issueChallenge()));

// Step 2: it returns the answer and gets a chat session.
app.post('/api/session', limiter(20, 10), (req, res) => {
  const problem = verifyChallenge(req.body?.token, req.body?.nonce);
  if (problem) return res.status(403).json({ error: 'Verification failed. Reload the page to try again.', reason: problem });
  const s = createSession(req.ip);
  if (s.error) return res.status(429).json({ error: 'You have started several chats recently. Please come back in an hour.' });
  res.json({ session: s.id, messagesLeft: LIMITS.messagesPerSession });
});

const UNAVAILABLE = {
  disabled: 'The live AI is switched off right now. The schedule and the double-booking test still work.',
  daily_call_limit: 'The demo has reached its daily limit. The schedule and the double-booking test still work; try the chat again tomorrow.',
  daily_budget: 'The demo has reached its daily limit. The schedule and the double-booking test still work; try the chat again tomorrow.',
  no_credit: 'The live AI is paused right now. The schedule and the double-booking test still work.',
};

app.post('/api/chat', limiter(40, 60), async (req, res) => {
  const session = getSession(String(req.body?.session ?? ''));
  if (!session) return res.status(401).json({ error: 'Your chat expired. Reload the page to start a new one.', expired: true });
  const text = String(req.body?.message ?? '').trim();
  if (!text) return res.status(400).json({ error: 'Type a message first.' });
  if (text.length > LIMITS.maxMessageChars) return res.status(400).json({ error: `Keep messages under ${LIMITS.maxMessageChars} characters.` });
  if (session.turns >= LIMITS.messagesPerSession) {
    return res.status(429).json({ error: 'This demo chat has reached its message limit. Reload the page to start a new one.' });
  }
  if (session.busy) return res.status(409).json({ error: 'Still answering your last message.' });
  session.busy = true;
  try {
    const out = await respond(db, session, text, {
      beforeCall: () => aiBlocked(db),
      onCost: (c) => { recordUsage(db, c); session.cost += c; },
    });
    session.turns++;
    res.json({ ...out, messagesLeft: LIMITS.messagesPerSession - session.turns, conversationCost: session.cost });
  } catch (err) {
    if (err instanceof AiUnavailable) return res.status(503).json({ error: UNAVAILABLE[err.message] ?? UNAVAILABLE.disabled });
    const kind = classifyError(err);
    if (kind === 'no_credit') {
      console.error(`${PROVIDER}: key rejected or out of credit`);
      aiHealth.ok = false;
      return res.status(503).json({ error: UNAVAILABLE.no_credit, paused: true });
    }
    if (kind === 'busy') return res.status(503).json({ error: 'The AI service is busy. Try again in a minute.' });
    if (kind === 'api') {
      console.error(`${PROVIDER} error`, err.status, err.message);
      return res.status(502).json({ error: 'The AI service returned an error. Try sending that again.' });
    }
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on our side. Try again.' });
  } finally {
    session.busy = false;
  }
});

// The double-booking test: 20 simultaneous requests for one slot, straight to the booking
// engine (no AI involved, so it costs nothing). Two technicians means at most two can win.
app.post('/api/race', limiter(6, 10), async (_req, res) => {
  const target = availableSlots(db, 'tuneup', null, null, { limit: 1 }).slots[0];
  if (!target) return res.status(409).json({ error: 'No free slot to test right now.' });
  const attempts = await Promise.all(Array.from({ length: 20 }, (_, i) => Promise.resolve().then(() =>
    book(db, { service: 'tuneup', start: target.start, name: `Test request ${i + 1}`, phone: '5125550000', address: 'Test', source: 'race' }))));
  // The test bookings are removed straight away so they don't fill the demo calendar.
  db.prepare("DELETE FROM bookings WHERE source = 'race'").run();
  res.json({
    slot: target,
    attempts: attempts.map((a, i) => ({ n: i + 1, ok: a.ok, reason: a.ok ? null : a.reason, technician: a.ok ? a.booking.technician : null })),
  });
});

app.listen(PORT, () => console.log(`receptionist on :${PORT} using ${PROVIDER} ${MODEL}; AI ${LIMITS.aiEnabled ? 'on' : 'off'}`));
