// The fictional business the receptionist works for. Everything the AI is allowed to say
// about the business comes from here, so prices and policies live in one place.

export const BUSINESS = {
  name: 'Copperline Heating & Air',
  city: 'Austin, TX',
  zone: 'America/Chicago',
  phone: '(512) 555-0143',
  slotMinutes: 30,
  leadMinutes: 90,      // earliest bookable time is now + 90 minutes
  horizonDays: 14,      // how far ahead customers can book
  // Luxon weekday: 1 = Monday … 7 = Sunday. Times are local.
  hours: {
    1: ['08:00', '18:00'], 2: ['08:00', '18:00'], 3: ['08:00', '18:00'],
    4: ['08:00', '18:00'], 5: ['08:00', '18:00'], 6: ['09:00', '14:00'],
  },
  serviceZips: /^(787\d\d|78613|78660|78664|78665|78681)$/,
  serviceAreaText: 'Austin (787xx ZIP codes), Cedar Park 78613, Pflugerville 78660, Round Rock 78664, 78665 and 78681',
};

export const SERVICES = {
  repair: { label: 'Heating or cooling repair visit', minutes: 90, price: '$89 diagnostic fee, credited toward the repair if you go ahead' },
  tuneup: { label: 'AC or furnace tune-up', minutes: 60, price: '$129' },
  estimate: { label: 'New system estimate', minutes: 60, price: 'free' },
  thermostat: { label: 'Smart thermostat install', minutes: 60, price: '$149 labor plus the thermostat (we can supply one or install yours)' },
};

export const TECHNICIANS = [
  { id: 1, name: 'Marcus' },
  { id: 2, name: 'Elena' },
];

// Facts the receptionist may use when answering questions.
export const POLICIES = [
  'Technicians arrive within the booked window and call 20 minutes ahead.',
  'Cancel or reschedule free of charge up to 2 hours before the appointment.',
  'We service all major brands of central AC, heat pumps and gas or electric furnaces.',
  'We do not service window units, commercial rooftop units, or boilers.',
  'Payment is by card or bank transfer after the visit. Financing is available on new systems.',
  'There is no after-hours or weekend emergency service; for urgent outages offer the earliest repair slot.',
  'If someone smells gas, they must leave the house now and call Texas Gas Service or 911 from outside. Do not book; hand off to staff.',
];
