// Booking engine. Double-booking is prevented by the database itself: every booking
// claims each 30-minute block it covers in `slot_claims`, whose primary key is
// (tech_id, slot_utc). Two bookings that overlap for the same technician cannot both
// commit, no matter how many requests or server processes race for the slot.

import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { DateTime } from 'luxon';
import { BUSINESS, SERVICES, TECHNICIANS } from './config.mjs';

// SQLITE_CONSTRAINT_UNIQUE and SQLITE_CONSTRAINT_PRIMARYKEY
const CONFLICT_CODES = new Set([2067, 1555]);

export function openDb(path = process.env.DB_PATH ?? 'data/receptionist.db') {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS bookings (
      id INTEGER PRIMARY KEY,
      ref TEXT NOT NULL UNIQUE,
      service TEXT NOT NULL,
      tech_id INTEGER NOT NULL,
      start_utc TEXT NOT NULL,
      end_utc TEXT NOT NULL,
      customer_name TEXT NOT NULL,
      phone TEXT NOT NULL,
      address TEXT NOT NULL,
      notes TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'booked',
      source TEXT NOT NULL DEFAULT 'chat',
      conversation_id TEXT,
      idempotency_key TEXT UNIQUE,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS slot_claims (
      tech_id INTEGER NOT NULL,
      slot_utc TEXT NOT NULL,
      booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
      PRIMARY KEY (tech_id, slot_utc)
    );
    CREATE TABLE IF NOT EXISTS handoffs (
      id INTEGER PRIMARY KEY,
      conversation_id TEXT,
      reason TEXT NOT NULL,
      customer_name TEXT,
      phone TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS seeded_days (day TEXT PRIMARY KEY);
  `);
  return db;
}

// ---------- time helpers ----------

const zone = BUSINESS.zone;
export const nowLocal = (now = DateTime.now()) => now.setZone(zone);

function hoursFor(day) {
  const h = BUSINESS.hours[day.weekday];
  if (!h) return null;
  const [o, c] = h.map((t) => t.split(':').map(Number));
  return {
    open: day.set({ hour: o[0], minute: o[1], second: 0, millisecond: 0 }),
    close: day.set({ hour: c[0], minute: c[1], second: 0, millisecond: 0 }),
  };
}

function blocks(startLocal, minutes) {
  const out = [];
  for (let m = 0; m < minutes; m += BUSINESS.slotMinutes) {
    out.push(startLocal.plus({ minutes: m }).toUTC().toISO({ suppressMilliseconds: true }));
  }
  return out;
}

/** Parse a local "YYYY-MM-DDTHH:mm" (or ISO with offset) into business-zone time. */
export function parseLocal(value) {
  const dt = DateTime.fromISO(value, { zone, setZone: false }).setZone(zone);
  return dt.isValid ? dt : null;
}

/** Why a start time is not bookable for a service, or null when it is. */
export function rejectStart(start, serviceKey, now = nowLocal()) {
  const svc = SERVICES[serviceKey];
  if (!svc) return 'unknown_service';
  if (!start) return 'invalid_time';
  if (start.minute % BUSINESS.slotMinutes !== 0 || start.second !== 0) return 'not_on_slot_boundary';
  if (start < now.plus({ minutes: BUSINESS.leadMinutes })) return 'too_soon';
  if (start > now.startOf('day').plus({ days: BUSINESS.horizonDays })) return 'too_far_ahead';
  const h = hoursFor(start);
  if (!h || start < h.open || start.plus({ minutes: svc.minutes }) > h.close) return 'outside_business_hours';
  return null;
}

// ---------- availability ----------

function claimedSet(db, fromUtc, toUtc) {
  const rows = db.prepare('SELECT tech_id, slot_utc FROM slot_claims WHERE slot_utc >= ? AND slot_utc < ?').all(fromUtc, toUtc);
  return new Set(rows.map((r) => `${r.tech_id}|${r.slot_utc}`));
}

/** Open start times for a service between two local dates (inclusive). */
export function availableSlots(db, serviceKey, fromDate, toDate, { now = nowLocal(), limit = 12 } = {}) {
  const svc = SERVICES[serviceKey];
  if (!svc) return { error: 'unknown_service' };
  let day = (fromDate ? DateTime.fromISO(fromDate, { zone }) : now).startOf('day');
  const last = (toDate ? DateTime.fromISO(toDate, { zone }) : day.plus({ days: 6 })).startOf('day');
  if (!day.isValid || !last.isValid) return { error: 'invalid_date' };
  const lastAllowed = now.startOf('day').plus({ days: BUSINESS.horizonDays });
  const claimed = claimedSet(db, day.toUTC().toISO(), last.plus({ days: 1 }).toUTC().toISO());
  const slots = [];
  for (; day <= last && day <= lastAllowed && slots.length < limit; day = day.plus({ days: 1 })) {
    const h = hoursFor(day);
    if (!h) continue;
    let perDay = 0;
    for (let t = h.open; t.plus({ minutes: svc.minutes }) <= h.close; t = t.plus({ minutes: BUSINESS.slotMinutes })) {
      if (rejectStart(t, serviceKey, now)) continue;
      const need = blocks(t, svc.minutes);
      const tech = TECHNICIANS.find((tc) => need.every((b) => !claimed.has(`${tc.id}|${b}`)));
      if (!tech) continue;
      slots.push({ start: t.toFormat("yyyy-LL-dd'T'HH:mm"), label: t.toFormat('cccc d LLL, h:mm a'), technician: tech.name });
      if (++perDay >= 4 || slots.length >= limit) break;
    }
  }
  return { service: svc.label, duration_minutes: svc.minutes, slots };
}

// ---------- write operations ----------

const newRef = () => 'CL-' + randomBytes(3).toString('hex').toUpperCase();

function claimBlocks(db, techId, startLocal, minutes, bookingId) {
  const ins = db.prepare('INSERT INTO slot_claims (tech_id, slot_utc, booking_id) VALUES (?, ?, ?)');
  for (const b of blocks(startLocal, minutes)) ins.run(techId, b, bookingId);
}

function inTransaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

const isUnique = (e) => CONFLICT_CODES.has(e?.errcode);

/**
 * Book a service. Tries the requested technician, otherwise each technician in turn.
 * Returns { ok: true, booking } or { ok: false, reason }.
 */
export function book(db, input, { now = nowLocal(), seeding = false } = {}) {
  const svc = SERVICES[input.service];
  const start = parseLocal(input.start);
  const why = seeding ? (svc && start ? null : 'invalid') : rejectStart(start, input.service, now);
  if (why) return { ok: false, reason: why };

  // Retried tool calls carry the same key and get the original booking back.
  if (input.idempotencyKey) {
    const prior = db.prepare('SELECT * FROM bookings WHERE idempotency_key = ?').get(input.idempotencyKey);
    if (prior) return { ok: true, booking: present(prior), replayed: true };
  }

  const techs = input.techId ? TECHNICIANS.filter((t) => t.id === input.techId) : TECHNICIANS;
  for (const tech of techs) {
    try {
      const row = inTransaction(db, () => {
        const end = start.plus({ minutes: svc.minutes });
        const res = db.prepare(`INSERT INTO bookings (ref, service, tech_id, start_utc, end_utc, customer_name, phone, address, notes, source, conversation_id, idempotency_key, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          newRef(), input.service, tech.id, start.toUTC().toISO(), end.toUTC().toISO(),
          input.name, input.phone, input.address, input.notes ?? '', input.source ?? 'chat',
          input.conversationId ?? null, input.idempotencyKey ?? null, DateTime.utc().toISO(),
        );
        claimBlocks(db, tech.id, start, svc.minutes, res.lastInsertRowid);
        return db.prepare('SELECT * FROM bookings WHERE id = ?').get(res.lastInsertRowid);
      });
      return { ok: true, booking: present(row) };
    } catch (e) {
      if (!isUnique(e)) throw e;
      // Slot taken for this technician (or a duplicate idempotency key): try the next one.
      if (input.idempotencyKey) {
        const prior = db.prepare('SELECT * FROM bookings WHERE idempotency_key = ?').get(input.idempotencyKey);
        if (prior) return { ok: true, booking: present(prior), replayed: true };
      }
    }
  }
  return { ok: false, reason: 'slot_taken' };
}

/** Find a live booking, but only for someone who knows its reference and the phone's last 4 digits. */
export function findOwned(db, ref, last4) {
  const row = db.prepare("SELECT * FROM bookings WHERE ref = ? AND status = 'booked'").get(String(ref).trim().toUpperCase());
  if (!row || !last4 || row.phone.slice(-4) !== String(last4).trim()) return null;
  return row;
}

export function cancel(db, ref, last4) {
  const row = findOwned(db, ref, last4);
  if (!row) return { ok: false, reason: 'not_found_or_phone_mismatch' };
  inTransaction(db, () => {
    db.prepare('DELETE FROM slot_claims WHERE booking_id = ?').run(row.id);
    db.prepare("UPDATE bookings SET status = 'cancelled' WHERE id = ?").run(row.id);
  });
  return { ok: true, booking: present({ ...row, status: 'cancelled' }) };
}

export function reschedule(db, ref, last4, newStart, { now = nowLocal() } = {}) {
  const row = findOwned(db, ref, last4);
  if (!row) return { ok: false, reason: 'not_found_or_phone_mismatch' };
  const start = parseLocal(newStart);
  const why = rejectStart(start, row.service, now);
  if (why) return { ok: false, reason: why };
  const svc = SERVICES[row.service];
  // Prefer the same technician, then anyone free. Old claims are released and new ones
  // taken in one transaction, so a failed move leaves the original booking intact.
  const order = [row.tech_id, ...TECHNICIANS.map((t) => t.id).filter((id) => id !== row.tech_id)];
  for (const techId of order) {
    try {
      const updated = inTransaction(db, () => {
        db.prepare('DELETE FROM slot_claims WHERE booking_id = ?').run(row.id);
        claimBlocks(db, techId, start, svc.minutes, row.id);
        db.prepare('UPDATE bookings SET tech_id = ?, start_utc = ?, end_utc = ? WHERE id = ?')
          .run(techId, start.toUTC().toISO(), start.plus({ minutes: svc.minutes }).toUTC().toISO(), row.id);
        return db.prepare('SELECT * FROM bookings WHERE id = ?').get(row.id);
      });
      return { ok: true, booking: present(updated) };
    } catch (e) {
      if (!isUnique(e)) throw e;
    }
  }
  return { ok: false, reason: 'slot_taken' };
}

export function handoff(db, { conversationId, reason, name, phone }) {
  db.prepare('INSERT INTO handoffs (conversation_id, reason, customer_name, phone, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(conversationId ?? null, reason, name ?? null, phone ?? null, DateTime.utc().toISO());
  return { ok: true };
}

// ---------- presentation ----------

const techName = (id) => TECHNICIANS.find((t) => t.id === id)?.name ?? '?';

/** Booking as the customer and the AI see it. */
export function present(row) {
  const start = DateTime.fromISO(row.start_utc).setZone(zone);
  return {
    reference: row.ref,
    status: row.status,
    service: SERVICES[row.service]?.label ?? row.service,
    when: `${start.toFormat('cccc d LLLL')}, ${start.toFormat('h:mm a')}–${DateTime.fromISO(row.end_utc).setZone(zone).toFormat('h:mm a')}`,
    start_local: start.toFormat("yyyy-LL-dd'T'HH:mm"),
    technician: techName(row.tech_id),
    customer_name: row.customer_name,
    address: row.address,
  };
}

/** Public, privacy-masked schedule for the staff panel. */
export function schedule(db, fromLocal, days) {
  const from = fromLocal.startOf('day');
  const rows = db.prepare("SELECT * FROM bookings WHERE status = 'booked' AND start_utc >= ? AND start_utc < ? ORDER BY start_utc")
    .all(from.toUTC().toISO(), from.plus({ days }).toUTC().toISO());
  return rows.map((r) => {
    const s = DateTime.fromISO(r.start_utc).setZone(zone);
    const e = DateTime.fromISO(r.end_utc).setZone(zone);
    const [first, ...rest] = r.customer_name.trim().split(/\s+/);
    return {
      id: r.id, ref: r.ref, day: s.toISODate(), start: s.toFormat('HH:mm'), end: e.toFormat('HH:mm'),
      technician: techName(r.tech_id), service: SERVICES[r.service]?.label ?? r.service,
      customer: rest.length ? `${first} ${rest.at(-1)[0]}.` : first,
      phone: `•••• ${r.phone.slice(-4)}`, source: r.source, created_at: r.created_at,
    };
  });
}

export function recentHandoffs(db, limit = 8) {
  return db.prepare('SELECT reason, customer_name, phone, created_at FROM handoffs ORDER BY id DESC LIMIT ?').all(limit)
    .map((h) => ({ ...h, customer_name: h.customer_name?.split(/\s+/)[0] ?? null, phone: h.phone ? `•••• ${h.phone.slice(-4)}` : null }));
}

// ---------- demo data ----------

const FAKE = ['Dana Whitfield', 'Luis Ortega', 'Priya Raman', 'Tom Becker', 'Grace Kim', 'Andre Wallace', 'Molly Shaw', 'Ken Ito', 'Rosa Delgado', 'Sam Sullivan'];

function seededRandom(seed) {
  let s = [...seed].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

/** Fill upcoming days with believable existing bookings, once per day. */
export function seedUpcoming(db, now = nowLocal()) {
  for (let i = 0; i <= BUSINESS.horizonDays; i++) {
    const day = now.startOf('day').plus({ days: i });
    const key = day.toISODate();
    if (db.prepare('SELECT 1 FROM seeded_days WHERE day = ?').get(key)) continue;
    db.prepare('INSERT INTO seeded_days (day) VALUES (?)').run(key);
    const h = hoursFor(day);
    if (!h) continue;
    const rand = seededRandom(key);
    const keys = Object.keys(SERVICES);
    for (const tech of TECHNICIANS) {
      for (let t = h.open; t < h.close; t = t.plus({ minutes: BUSINESS.slotMinutes })) {
        if (rand() > 0.22) continue;
        const service = keys[Math.floor(rand() * keys.length)];
        if (t.plus({ minutes: SERVICES[service].minutes }) > h.close) continue;
        const name = FAKE[Math.floor(rand() * FAKE.length)];
        book(db, {
          service, start: t.toISO(), techId: tech.id, name, source: 'existing',
          phone: '512555' + String(1000 + Math.floor(rand() * 8999)), address: 'Austin, TX 78704',
        }, { seeding: true }); // a failure just means that slot is already busy
        t = t.plus({ minutes: SERVICES[service].minutes - BUSINESS.slotMinutes });
      }
    }
  }
}

/** Drop old demo data so the database stays small. */
export function purgeOld(db, now = nowLocal()) {
  const cutoff = now.minus({ days: 2 }).toUTC().toISO();
  db.prepare('DELETE FROM bookings WHERE end_utc < ?').run(cutoff);
  db.prepare('DELETE FROM handoffs WHERE created_at < ?').run(now.minus({ days: 7 }).toUTC().toISO());
}
