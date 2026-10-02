import { $, $$, esc, sleep, loadIcons, hydrateIcons, icon, toast, Guide, reveal, startSession, postJson, reducedMotion } from './kit.js?v=7';

const state = { config: null, session: null, busy: false, playing: false, aiStatus: 'ok', myRefs: new Set(), seen: new Set(), example: null, bookings: [] };
const els = { messages: $('#messages'), input: $('#input'), send: $('#send'), composer: $('#composer'), quick: $('#quick'), live: $('#live'), cal: $('#cal'), log: $('#log'), logCount: $('#logCount'), notice: $('#aiNotice'), spend: $('#spend') };

// ---------- checklist ----------
const guide = new Guide({
  key: 'receptionist', title: 'Your demo checklist', openWhen: '#try',
  missions: [
    { id: 'watch', title: 'Watch the 30-second example', hint: 'See a customer book a repair, start to finish.', action: { label: 'Play it', run: () => playExample() } },
    { id: 'ask', title: 'Ask it a question', hint: 'Prices, opening hours, what you service.', action: { label: 'Ask about prices', run: () => send('How much is a tune-up?') } },
    { id: 'book', title: 'Book a visit', hint: 'Pick a time it offers and give made-up details.', action: { label: 'Start a booking', run: () => send('My AC stopped cooling, can someone come this week?') } },
    { id: 'test', title: 'Try to break it', hint: 'Send 20 bookings for one slot at the same time.', action: { label: 'Open the test', run: () => { selectTab('test'); $('#try').scrollIntoView({ behavior: 'smooth' }); } } },
  ],
  onComplete: () => toast('You saw everything it does. Want one for your business?', { icon: 'party-popper', ms: 6000 }),
});

// ---------- tabs ----------
function selectTab(name) {
  for (const b of $$('.tabs button')) b.setAttribute('aria-selected', String(b.dataset.tab === name));
  for (const p of $$('.tab-panel')) p.hidden = p.dataset.panel !== name;
  if (name === 'log') els.logCount.hidden = true;
}
$('.tabs').addEventListener('click', (e) => { const b = e.target.closest('button[data-tab]'); if (b) selectTab(b.dataset.tab); });

// ---------- calendar ----------
const DAY_START = 8 * 60, DAY_END = 18 * 60, SPAN = DAY_END - DAY_START;
const toMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const pct = (m) => `${((Math.min(Math.max(m, DAY_START), DAY_END) - DAY_START) / SPAN) * 100}%`;
const isoDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const SHORT = { 'Heating or cooling repair visit': 'Repair', 'AC or furnace tune-up': 'Tune-up', 'New system estimate': 'Estimate', 'Smart thermostat install': 'Thermostat' };

function renderCalendar() {
  const { technicians, business, today, now } = state.config;
  const ticks = [8, 10, 12, 14, 16, 18].map((h) => `<span style="left:${pct(h * 60)}">${h > 12 ? h - 12 : h}${h >= 12 ? 'pm' : 'am'}</span>`).join('');
  let html = `<div class="cal-hours"><span></span><div class="scale" style="margin-left:28px">${ticks}</div></div>`;
  const base = new Date(`${today}T12:00:00`);
  for (let i = 0; i < 7; i++) {
    const d = new Date(base); d.setDate(base.getDate() + i);
    const key = isoDay(d);
    const label = `<div class="day-label"><b>${d.toLocaleDateString('en-US', { weekday: 'short' })} ${d.getDate()}</b><small class="${i === 0 ? 'today' : ''}">${i === 0 ? 'Today' : d.toLocaleDateString('en-US', { month: 'short' })}</small></div>`;
    const hours = business.hours[d.getDay() === 0 ? 7 : d.getDay()];
    if (!hours) { html += `<div class="day">${label}<div class="closed-row">Closed on Sundays</div></div>`; continue; }
    const [open, close] = hours.map(toMin);
    const pastTo = i === 0 ? Math.max(open, Math.min(toMin(now), close)) : open;
    const lanes = technicians.map((t) => {
      const cls = t.name.toLowerCase();
      const shade = `${pastTo > DAY_START ? `<div class="blk closed" style="left:0;width:${pct(pastTo)}"></div>` : ''}${close < DAY_END ? `<div class="blk closed" style="left:${pct(close)};right:0"></div>` : ''}`;
      const items = state.bookings.filter((b) => b.day === key && b.technician === t.name).map((b) => {
        const fresh = state.myRefs.has(b.ref), just = fresh && !state.seen.has(b.ref);
        if (fresh) state.seen.add(b.ref);
        return `<div class="blk ${fresh ? 'fresh' : ''} ${just ? 'just' : ''}" style="left:${pct(toMin(b.start))};width:calc(${pct(toMin(b.end))} - ${pct(toMin(b.start))})" title="${esc(`${b.start}–${b.end} ${b.service}, ${b.customer}`)}">${fresh ? esc(b.customer) : esc(SHORT[b.service] ?? '')}</div>`;
      });
      const ex = state.example && state.example.day === key && state.example.technician === t.name
        ? `<div class="blk example just" style="left:${pct(toMin(state.example.start))};width:calc(${pct(toMin(state.example.end))} - ${pct(toMin(state.example.start))})">Jane D. (example)</div>` : '';
      return `<div class="lane ${cls}"><span class="who">${esc(t.name[0])}</span>${shade}${items.join('')}${ex}</div>`;
    }).join('');
    html += `<div class="day">${label}<div class="lanes">${lanes}</div></div>`;
  }
  els.cal.innerHTML = html;
}

async function refreshSchedule() {
  try {
    const data = await (await fetch('/api/schedule?days=8')).json();
    state.bookings = data.bookings;
    state.aiStatus = data.ai.status;
    renderCalendar();
    renderAiNotice();
    els.spend.textContent = `Demo AI spend today: $${data.ai.spentToday.toFixed(2)} of a $${data.ai.budget.toFixed(2)} daily cap.`;
  } catch { /* next poll retries */ }
}

function renderAiNotice() {
  if (state.aiStatus === 'ok' || state.playing) { els.notice.innerHTML = ''; return; }
  els.notice.innerHTML = `<div class="notice warn">${icon('hourglass')}<div><b>The live AI is taking a break right now.</b> The calendar and the stress test still work, and the 30-second example shows exactly how a booking goes.<br><button type="button" class="btn btn-soft btn-sm" data-play>${icon('play')}Play the example</button></div></div>`;
}

// ---------- activity log ----------
const LOG = {
  check_availability: { icon: 'calendar-clock', title: 'Checked the calendar' },
  book_appointment: { icon: 'calendar-check', title: 'Booked a visit' },
  find_booking: { icon: 'search', title: 'Looked up a booking' },
  reschedule_booking: { icon: 'repeat', title: 'Moved a booking' },
  cancel_booking: { icon: 'calendar-x', title: 'Cancelled a booking' },
  hand_off_to_staff: { icon: 'headset', title: 'Passed to a person' },
};
function addLog(events) {
  if (!events.length) return;
  els.log.querySelector('.empty')?.remove();
  for (const e of events) {
    const meta = LOG[e.tool] ?? { icon: 'bot', title: e.tool };
    const li = document.createElement('li');
    li.className = e.handoff ? 'handoff' : !e.ok ? 'fail' : e.tool === 'book_appointment' || e.tool === 'reschedule_booking' ? 'book' : '';
    li.innerHTML = `<span class="ico">${icon(e.ok === false ? 'x' : meta.icon)}</span><div><b>${esc(e.ok === false ? `${meta.title}: refused` : meta.title)}</b><span>${esc(e.text)}${e.example ? ' (example)' : ''}</span></div>`;
    els.log.prepend(li);
  }
  if ($('.tabs [data-tab="log"]').getAttribute('aria-selected') !== 'true') {
    els.logCount.hidden = false;
    els.logCount.textContent = Number(els.logCount.textContent || 0) + events.length;
  }
}

// ---------- chat ----------
function bubble(kind, text, extra = '') {
  const div = document.createElement('div');
  div.className = `msg ${kind} ${extra}`;
  div.textContent = text;
  els.messages.append(div);
  els.messages.scrollTop = els.messages.scrollHeight;
  return div;
}
function typing() {
  const d = bubble('bot', '');
  d.innerHTML = '<span class="typing"><i></i><i></i><i></i></span>';
  return d;
}
function setReady() {
  const ready = !!state.session && !state.busy && !state.playing;
  els.input.disabled = !state.session || state.playing;
  els.send.disabled = !ready;
  $$('.chip', els.quick).forEach((b) => (b.disabled = !ready));
}

async function send(text) {
  text = String(text ?? '').trim();
  if (!text || state.busy || state.playing) return;
  if (!state.session) { toast('Still connecting, one moment…', { icon: 'hourglass', tone: 'warn' }); return; }
  $('#try').scrollIntoView({ behavior: 'smooth', block: 'start' });
  els.quick.hidden = true;
  bubble('me', text);
  els.input.value = '';
  autosize();
  state.busy = true; setReady();
  const t = typing();
  const { ok, data } = await postJson('/api/chat', { session: state.session, message: text }).catch(() => ({ ok: false, data: { error: 'Could not reach the server. Check your connection.' } }));
  t.remove();
  state.busy = false; setReady();
  if (!ok) {
    bubble('err', data.error ?? 'Something went wrong.');
    if (data.paused) { state.aiStatus = 'paused'; renderAiNotice(); }
    if (data.expired) state.session = null;
    return;
  }
  bubble('bot', data.reply);
  for (const e of data.events ?? []) if (e.ref) state.myRefs.add(e.ref);
  addLog(data.events ?? []);
  guide.complete('ask');
  const booked = (data.events ?? []).find((e) => e.ok && e.tool === 'book_appointment');
  if (booked) { guide.complete('book'); toast('New booking landed in the calendar', { icon: 'calendar-check', tone: 'ok' }); selectTab('cal'); }
  if (data.events?.length) await refreshSchedule();
  els.input.focus();
}

function autosize() { els.input.style.height = 'auto'; els.input.style.height = `${Math.min(els.input.scrollHeight, 110)}px`; }
els.composer.addEventListener('submit', (e) => { e.preventDefault(); send(els.input.value); });
els.input.addEventListener('input', autosize);
els.input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(els.input.value); } });
els.quick.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) send(b.textContent); });

// ---------- the 30-second example (pre-written, uses real free times, books nothing) ----------
async function playExample() {
  if (state.playing) return;
  state.playing = true; setReady(); renderAiNotice();
  $('#try').scrollIntoView({ behavior: 'smooth', block: 'start' });
  selectTab('cal');
  els.quick.hidden = true;
  els.messages.innerHTML = '';
  const tag = document.createElement('div');
  tag.className = 'example-tag';
  tag.innerHTML = `${icon('play')}Example conversation, written for this demo`;
  els.messages.append(tag);
  const speed = reducedMotion() ? 0.2 : 1;
  const say = async (who, text, wait = 900) => {
    if (who === 'bot') { const t = typing(); await sleep(wait * speed); t.remove(); }
    else await sleep(wait * 0.6 * speed);
    bubble(who === 'bot' ? 'bot' : 'me', text, 'example');
  };
  try {
    const { slots } = await (await fetch('/api/slots?service=repair')).json();
    const pickA = slots[0], pickB = slots[2] ?? slots[1] ?? slots[0];
    await say('me', 'Hi, my AC stopped cooling. Can someone come out this week?', 800);
    addLog([{ tool: 'check_availability', ok: true, text: `Found ${slots.length} open repair times`, example: true }]);
    await say('bot', `Sorry to hear that! A repair visit takes 90 minutes and the $89 call-out fee goes toward the repair. I can do ${pickA.label} or ${pickB.label}. Which suits you?`, 1700);
    await say('me', `${pickB.label.split(',')[0]} works.`, 1200);
    await say('bot', 'Great. What is your name, phone number and address with ZIP code?', 1200);
    await say('me', 'Jane Doe, 512 555 0199, 1 Main St, Austin 78704', 1500);
    await say('bot', `Thanks Jane. To confirm: repair visit on ${pickB.label} at 1 Main St, Austin 78704, with ${pickB.technician}. Shall I book it?`, 1500);
    await say('me', 'Yes please!', 900);
    const t = typing(); await sleep(1100 * speed); t.remove();
    const [day, time] = pickB.start.split('T');
    const endMin = toMin(time) + 90;
    state.example = { day, start: time, end: `${String(Math.floor(endMin / 60)).padStart(2, '0')}:${String(endMin % 60).padStart(2, '0')}`, technician: pickB.technician };
    renderCalendar();
    addLog([{ tool: 'book_appointment', ok: true, text: `Repair visit, ${pickB.label}, ${pickB.technician}`, example: true }]);
    toast(`New booking: ${pickB.label} (example)`, { icon: 'bell', tone: 'ok' });
    bubble('bot', `You're booked! Your reference is CL-7Q2K9P. ${pickB.technician} will call you 20 minutes before arriving. Anything else?`, 'example');
    guide.complete('watch');
    await sleep(1800 * speed);
    const end = document.createElement('div');
    end.className = 'example-tag';
    end.innerHTML = `${icon('check')}End of example. The yellow dashed slot is not saved.`;
    els.messages.append(end);
    els.messages.scrollTop = els.messages.scrollHeight;
  } catch {
    bubble('err', 'The example could not load. Reload the page to try again.');
  } finally {
    state.playing = false; setReady(); renderAiNotice();
    setTimeout(() => { state.example = null; renderCalendar(); }, 20000);
  }
}
document.addEventListener('click', (e) => { if (e.target.closest('[data-play]')) playExample(); });

// ---------- try to break it ----------
$('#raceBtn').addEventListener('click', async () => {
  const btn = $('#raceBtn'), grid = $('#raceGrid'), result = $('#raceResult');
  btn.disabled = true;
  grid.innerHTML = Array.from({ length: 20 }, (_, i) => `<span class="p go">${i + 1}</span>`).join('');
  result.textContent = 'Sending 20 bookings at the same moment…';
  const { ok, data } = await postJson('/api/race', {});
  if (!ok) { result.textContent = data.error ?? 'The test could not run. Try again in a minute.'; btn.disabled = false; return; }
  await sleep(reducedMotion() ? 0 : 700);
  const people = $$('.p', grid);
  data.attempts.forEach((a, i) => setTimeout(() => {
    people[i].className = `p ${a.ok ? 'won' : 'lost'}`;
    people[i].innerHTML = icon(a.ok ? 'check' : 'x');
  }, reducedMotion() ? 0 : i * 60));
  setTimeout(() => {
    const won = data.attempts.filter((a) => a.ok);
    result.innerHTML = `${icon('shield-check')} ${esc(data.slot.label)}: <b>${won.length} booked</b> (${esc(won.map((w) => w.technician).join(' and '))}), <b>${20 - won.length} turned away</b> because the slot was taken. No double-booking. Test bookings are removed straight after.`;
    guide.complete('test');
    btn.disabled = false;
  }, reducedMotion() ? 0 : 20 * 60 + 200);
});

// ---------- boot ----------
await loadIcons();
hydrateIcons();
reveal();
state.config = await (await fetch('/api/config')).json();
await refreshSchedule();
setInterval(refreshSchedule, 20_000);
bubble('bot', "Hi! I'm the Copperline assistant. I can book a repair, tune-up or estimate, answer questions, or change an existing appointment. How can I help?");
setReady();
try {
  const s = await startSession();
  state.session = s.session;
  els.live.textContent = 'Online';
  els.live.className = 'pill-live on';
} catch (err) {
  els.live.textContent = 'Offline';
  els.live.className = 'pill-live off';
  bubble('err', err.message);
}
setReady();
