import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DateTime } from 'luxon';
import { openDb, book, cancel, reschedule, availableSlots, rejectStart, parseLocal, schedule } from '../db.mjs';

// Monday 5 Oct 2026, 08:00 in Austin.
const now = DateTime.fromISO('2026-10-05T08:00', { zone: 'America/Chicago' });
const customer = { name: 'Jane Doe', phone: '5125550199', address: '1 Main St, Austin TX 78704' };
const fresh = () => openDb(':memory:');

test('the same slot cannot be booked three times when two technicians exist', () => {
  const db = fresh();
  const tries = Array.from({ length: 20 }, () => book(db, { ...customer, service: 'tuneup', start: '2026-10-06T10:00' }, { now }));
  assert.equal(tries.filter((r) => r.ok).length, 2); // one per technician
  assert.ok(tries.slice(2).every((r) => r.reason === 'slot_taken'));
});

test('overlapping bookings of different lengths collide on the same technician', () => {
  const db = fresh();
  assert.ok(book(db, { ...customer, service: 'repair', start: '2026-10-06T10:00', techId: 1 }, { now }).ok); // 10:00–11:30
  const overlap = book(db, { ...customer, service: 'tuneup', start: '2026-10-06T11:00', techId: 1 }, { now });
  assert.equal(overlap.reason, 'slot_taken');
  assert.ok(book(db, { ...customer, service: 'tuneup', start: '2026-10-06T11:30', techId: 1 }, { now }).ok);
});

test('a retried booking with the same idempotency key returns the original', () => {
  const db = fresh();
  const a = book(db, { ...customer, service: 'estimate', start: '2026-10-07T09:00', idempotencyKey: 'conv1:t3' }, { now });
  const b = book(db, { ...customer, service: 'estimate', start: '2026-10-07T09:00', idempotencyKey: 'conv1:t3' }, { now });
  assert.equal(a.booking.reference, b.booking.reference);
  assert.equal(b.replayed, true);
  assert.equal(schedule(db, now, 7).length, 1);
});

test('business rules: lead time, hours, Sunday, slot boundary, horizon', () => {
  assert.equal(rejectStart(parseLocal('2026-10-05T09:00'), 'tuneup', now), 'too_soon');
  assert.equal(rejectStart(parseLocal('2026-10-06T17:30'), 'tuneup', now), 'outside_business_hours');
  assert.equal(rejectStart(parseLocal('2026-10-11T10:00'), 'tuneup', now), 'outside_business_hours'); // Sunday
  assert.equal(rejectStart(parseLocal('2026-10-06T10:15'), 'tuneup', now), 'not_on_slot_boundary');
  assert.equal(rejectStart(parseLocal('2026-10-25T10:00'), 'tuneup', now), 'too_far_ahead');
  assert.equal(rejectStart(parseLocal('2026-10-10T13:00'), 'tuneup', now), null); // Saturday, ends 14:00
  assert.equal(rejectStart(parseLocal('2026-10-10T13:00'), 'repair', now), 'outside_business_hours');
});

test('cancel and reschedule require the phone number', () => {
  const db = fresh();
  const { booking } = book(db, { ...customer, service: 'tuneup', start: '2026-10-06T10:00' }, { now });
  assert.equal(cancel(db, booking.reference, '0000').ok, false);
  assert.equal(reschedule(db, booking.reference, '0000', '2026-10-06T14:00', { now }).ok, false);
  assert.ok(reschedule(db, booking.reference, '0199', '2026-10-06T14:00', { now }).ok);
  assert.ok(cancel(db, booking.reference.toLowerCase(), '0199').ok);
  assert.equal(schedule(db, now, 7).length, 0);
});

test('a failed reschedule leaves the original slot held', () => {
  const db = fresh();
  const mine = book(db, { ...customer, service: 'tuneup', start: '2026-10-06T10:00', techId: 1 }, { now }).booking;
  book(db, { ...customer, service: 'tuneup', start: '2026-10-06T14:00', techId: 1 }, { now });
  book(db, { ...customer, service: 'tuneup', start: '2026-10-06T14:00', techId: 2 }, { now });
  assert.equal(reschedule(db, mine.reference, '0199', '2026-10-06T14:00', { now }).reason, 'slot_taken');
  const other = book(db, { ...customer, service: 'tuneup', start: '2026-10-06T10:00', techId: 1 }, { now });
  assert.equal(other.reason, 'slot_taken'); // still Jane's
});

test('availability skips taken slots and respects lead time', () => {
  const db = fresh();
  const before = availableSlots(db, 'tuneup', '2026-10-05', '2026-10-05', { now }).slots;
  assert.equal(before[0].start, '2026-10-05T09:30'); // 08:00 + 90 min lead
  book(db, { ...customer, service: 'tuneup', start: '2026-10-05T09:30', techId: 1 }, { now });
  book(db, { ...customer, service: 'tuneup', start: '2026-10-05T09:30', techId: 2 }, { now });
  const after = availableSlots(db, 'tuneup', '2026-10-05', '2026-10-05', { now }).slots;
  assert.equal(after[0].start, '2026-10-05T10:30'); // the 60-minute jobs hold 09:30 and 10:00
});

test('availability spreads across the day and can show afternoons only', () => {
  const db = fresh();
  const all = availableSlots(db, 'tuneup', '2026-10-06', '2026-10-06', { now }).slots;
  assert.equal(all.length, 4);
  assert.ok(Number(all.at(-1).start.slice(11, 13)) >= 14, 'last offer is late in the day');
  const pm = availableSlots(db, 'tuneup', '2026-10-06', '2026-10-06', { now, partOfDay: 'afternoon' }).slots;
  assert.ok(pm.length > 0 && pm.every((s) => Number(s.start.slice(11, 13)) >= 12));
});
