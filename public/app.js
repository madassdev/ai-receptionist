const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const els = {
  messages: $('#messages'), input: $('#input'), send: $('#send'), composer: $('#composer'),
  suggestions: $('#suggestions'), statusDot: $('#statusDot'), statusText: $('#statusText'),
  timeline: $('#timeline'), events: $('#events'), meter: $('#meter'), fine: $('#fine'),
  raceBtn: $('#raceBtn'), raceResult: $('#raceResult'),
};

const DAY_START = 8 * 60, DAY_END = 18 * 60, SPAN = DAY_END - DAY_START;
const state = { config: null, session: null, busy: false, myRefs: new Set(), seen: new Set(), conversationCost: 0 };

// ---------- calendar ----------

const toMin = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
const pct = (min) => `${((min - DAY_START) / SPAN) * 100}%`;

function upcomingDays(count) {
  const days = [];
  const base = new Date(`${state.config.today}T12:00:00`);
  for (let i = 0; days.length < count; i++) {
    const d = new Date(base); d.setDate(base.getDate() + i);
    days.push(d);
  }
  return days;
}

const isoDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const luxonWeekday = (d) => (d.getDay() === 0 ? 7 : d.getDay());

function renderTimeline(bookings) {
  const { technicians, business } = state.config;
  const ticks = [8, 10, 12, 14, 16, 18].map((h) => `<span style="left:${pct(h * 60)}">${h > 12 ? h - 12 : h}${h >= 12 ? 'pm' : 'am'}</span>`).join('');
  let html = `<div class="hours"><span></span><div class="scale">${ticks}</div></div>`;
  for (const d of upcomingDays(7)) {
    const key = isoDay(d);
    const label = `<b>${d.toLocaleDateString('en-US', { weekday: 'short' })} ${d.getDate()}</b><small>${key === state.config.today ? 'Today' : d.toLocaleDateString('en-US', { month: 'short' })}</small>`;
    const hours = business.hours[luxonWeekday(d)];
    if (!hours) {
      html += `<div class="day closed"><div class="day-label">${label}</div><div class="closed-note">Closed</div></div>`;
      continue;
    }
    const [open, close] = hours.map(toMin);
    const lanes = technicians.map((t) => {
      const mine = bookings.filter((b) => b.day === key && b.technician === t.name);
      // Hatch closed hours, and on today also the hours that have already passed.
      const nowMin = key === state.config.today ? toMin(state.config.now) : 0;
      const shadeTo = Math.max(open, Math.min(nowMin, close));
      const hatch = 'background:repeating-linear-gradient(135deg,#eef1f3 0 4px,#fff 4px 8px)';
      const shade = [
        shadeTo > DAY_START ? `<div class="block" style="left:0;width:${pct(shadeTo)};${hatch}" aria-hidden="true"></div>` : '',
        close < DAY_END ? `<div class="block" style="left:${pct(close)};right:0;background:repeating-linear-gradient(135deg,#eef1f3 0 4px,#fff 4px 8px)" aria-hidden="true"></div>` : '',
      ].join('');
      const blocks = mine.map((b) => {
        const fresh = state.myRefs.has(b.ref);
        const just = fresh && !state.seen.has(b.ref);
        if (fresh) state.seen.add(b.ref);
        const w = `left:${pct(toMin(b.start))};width:calc(${pct(toMin(b.end))} - ${pct(toMin(b.start))})`;
        const title = `${b.start}–${b.end} ${b.service}, ${b.customer} (${b.phone})`;
        return `<div class="block${fresh ? ' fresh' : ''}${just ? ' just' : ''}" style="${w}" title="${esc(title)}">${fresh ? esc(b.customer) : ''}</div>`;
      }).join('');
      return `<div class="lane-row"><span class="who">${esc(t.name)}</span><div class="lane">${shade}${blocks}</div></div>`;
    }).join('');
    html += `<div class="day"><div class="day-label">${label}</div><div class="lanes">${lanes}</div></div>`;
  }
  els.timeline.innerHTML = html;
}

let lastAi = null;
async function refreshSchedule() {
  try {
    const r = await fetch('/api/schedule?days=8');
    if (!r.ok) return;
    const data = await r.json();
    lastAi = data.ai;
    renderTimeline(data.bookings);
    renderMeter();
  } catch { /* the next poll will retry */ }
}

function renderMeter() {
  if (!lastAi) return;
  const parts = [];
  if (state.conversationCost > 0) parts.push(`This chat has cost $${state.conversationCost.toFixed(3)} in AI usage.`);
  parts.push(`Demo spend today: $${lastAi.spentToday.toFixed(2)} of a $${lastAi.budget.toFixed(2)} daily cap.`);
  els.meter.textContent = parts.join(' ');
}

// ---------- activity log ----------

const TOOL_NAMES = {
  check_availability: 'Checked availability', book_appointment: 'Booking', find_booking: 'Lookup',
  reschedule_booking: 'Reschedule', cancel_booking: 'Cancellation', hand_off_to_staff: 'Handoff to staff',
};

function addEvents(events) {
  if (!events.length) return;
  els.events.querySelector('.empty')?.remove();
  for (const e of events) {
    if (e.ref) state.myRefs.add(e.ref);
    const li = document.createElement('li');
    li.className = e.handoff ? 'handoff' : e.ok ? 'ok' : 'fail';
    li.innerHTML = `<span class="tool">${esc(TOOL_NAMES[e.tool] ?? e.tool)}</span>${esc(e.text)}`;
    els.events.prepend(li);
  }
}

// ---------- chat ----------

function addMessage(kind, text) {
  const div = document.createElement('div');
  div.className = `msg ${kind}`;
  div.textContent = text;
  els.messages.append(div);
  els.messages.scrollTop = els.messages.scrollHeight;
  return div;
}

function setStatus(kind, text) {
  els.statusDot.className = `dot ${kind}`;
  els.statusText.textContent = text;
}

function setBusy(busy) {
  state.busy = busy;
  const ready = !!state.session && !busy;
  els.input.disabled = !state.session;
  els.send.disabled = !ready;
  els.suggestions.querySelectorAll('button').forEach((b) => (b.disabled = !ready));
}

async function send(text) {
  text = text.trim();
  if (!text || state.busy || !state.session) return;
  els.suggestions.hidden = true;
  addMessage('me', text);
  els.input.value = '';
  autosize();
  setBusy(true);
  const typing = addMessage('bot typing', '');
  typing.innerHTML = '<i></i><i></i><i></i>';
  try {
    const r = await fetch('/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session: state.session, message: text }) });
    const data = await r.json();
    typing.remove();
    if (!r.ok) {
      addMessage('error', data.error ?? 'Something went wrong.');
      if (data.expired) state.session = null;
      return;
    }
    addEvents(data.events ?? []);
    addMessage('bot', data.reply);
    state.conversationCost = data.conversationCost ?? state.conversationCost;
    if (data.messagesLeft <= 3) els.fine.textContent = `${data.messagesLeft} message${data.messagesLeft === 1 ? '' : 's'} left in this demo chat.`;
    if (data.events?.length) await refreshSchedule(); else renderMeter();
  } catch {
    typing.remove();
    addMessage('error', 'Could not reach the server. Check your connection and try again.');
  } finally {
    setBusy(false);
    els.input.focus();
  }
}

function autosize() {
  els.input.style.height = 'auto';
  els.input.style.height = `${Math.min(els.input.scrollHeight, 120)}px`;
}

els.composer.addEventListener('submit', (e) => { e.preventDefault(); send(els.input.value); });
els.input.addEventListener('input', autosize);
els.input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(els.input.value); }
});
els.suggestions.addEventListener('click', (e) => { if (e.target.tagName === 'BUTTON') send(e.target.textContent); });

// ---------- session: solve the proof-of-work puzzle, then open a chat ----------

async function startSession() {
  setStatus('', 'Connecting…');
  try {
    const ch = await (await fetch('/api/challenge')).json();
    const worker = new Worker('pow-worker.js');
    const { nonce } = await new Promise((resolve, reject) => {
      worker.onmessage = (e) => resolve(e.data);
      worker.onerror = reject;
      worker.postMessage({ salt: ch.salt, bits: ch.bits });
    });
    worker.terminate();
    const r = await fetch('/api/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: ch.token, nonce }) });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error);
    state.session = data.session;
    setStatus('on', 'Online, usually replies in a few seconds');
    setBusy(false);
  } catch (err) {
    setStatus('off', 'Chat unavailable');
    addMessage('error', err?.message || 'Could not start the chat. Reload the page to try again.');
  }
}

// ---------- double-booking test ----------

els.raceBtn.addEventListener('click', async () => {
  els.raceBtn.disabled = true;
  els.raceResult.hidden = false;
  els.raceResult.innerHTML = `<div class="dots">${'<span></span>'.repeat(20)}</div><p>Sending 20 requests…</p>`;
  try {
    const r = await fetch('/api/race', { method: 'POST' });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error);
    const dots = els.raceResult.querySelectorAll('.dots span');
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    data.attempts.forEach((a, i) => setTimeout(() => dots[i].classList.add(a.ok ? 'won' : 'lost'), reduce ? 0 : i * 45));
    const won = data.attempts.filter((a) => a.ok);
    setTimeout(() => {
      els.raceResult.querySelector('p').textContent =
        `${data.slot.label}: ${won.length} booked (${won.map((w) => w.technician).join(' and ')}), ${20 - won.length} refused because the slot was already taken. Test bookings are removed afterwards.`;
    }, reduce ? 0 : 20 * 45);
  } catch (err) {
    els.raceResult.innerHTML = `<p>${esc(err.message || 'The test could not run. Try again in a minute.')}</p>`;
  } finally {
    setTimeout(() => (els.raceBtn.disabled = false), 1500);
  }
});

// ---------- boot ----------

state.config = await (await fetch('/api/config')).json();
await refreshSchedule();
setInterval(refreshSchedule, 20_000);
setBusy(false);
startSession();
