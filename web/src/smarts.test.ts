// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { findCards, findWhen, trust } from './smarts';

const ld = (o: unknown) => `<html><head><script type="application/ld+json">${JSON.stringify(o)}</script></head><body>hi from schema.org</body></html>`;

describe('cards from schema.org data', () => {
  it('package: tracking number, carrier link only over https, shown by its real host', () => {
    const [c] = findCards(ld({ '@context': 'https://schema.org', '@type': 'ParcelDelivery', carrier: { name: 'UPS' }, trackingNumber: '1Z999AA10123456784',
      trackingUrl: 'https://www.ups.com/track?tracknum=1Z999AA10123456784', expectedArrivalUntil: '2026-12-03' }));
    expect(c.kind).toBe('parcel');
    expect(c.name).toBe('UPS');
    expect(c.link).toEqual({ href: 'https://www.ups.com/track?tracknum=1Z999AA10123456784', host: 'www.ups.com' });
    expect(c.facts.find(([k]) => k === 'smarts.tracking')?.[1]).toBe('1Z999AA10123456784');
    expect(findCards(ld({ '@type': 'ParcelDelivery', trackingUrl: 'http://evil.example/x' }))[0].link).toBeUndefined();
    expect(findCards(ld({ '@type': 'ParcelDelivery', trackingUrl: 'javascript:alert(1)' }))[0].link).toBeUndefined();
  });

  it('flight: number, airports, times and a calendar event', () => {
    const [c] = findCards(ld({ '@context': 'http://schema.org', '@type': 'FlightReservation', reservationNumber: 'RXJ34P',
      reservationFor: { '@type': 'Flight', flightNumber: '110', airline: { name: 'United', iataCode: 'UA' },
        departureAirport: { name: 'San Francisco Airport', iataCode: 'SFO' }, departureTime: '2027-03-04T20:15:00-08:00',
        arrivalAirport: { name: 'John F. Kennedy International Airport', iataCode: 'JFK' }, arrivalTime: '2027-03-05T06:30:00-05:00' } }));
    expect(c.name).toBe('UA 110 · SFO → JFK');
    expect(c.event?.start.toISOString()).toBe('2027-03-05T04:15:00.000Z');
    expect(c.event?.end?.toISOString()).toBe('2027-03-05T11:30:00.000Z');
  });

  it('order total, hotel stay (all-day), @graph and microdata', () => {
    const [o] = findCards(ld({ '@graph': [{ '@type': 'Order', merchant: { name: 'Bookshop' }, orderNumber: 'B-1', price: '24.50', priceCurrency: 'EUR' }] }));
    expect(o.name).toBe('Bookshop');
    expect(o.facts.find(([k]) => k === 'smarts.total')?.[1]).toMatch(/24[.,]50/);
    const [s] = findCards(ld({ '@type': 'LodgingReservation', reservationFor: { name: 'Hotel Ríos', address: { streetAddress: '1 Calle', addressLocality: 'Madrid' } },
      checkinDate: '2027-05-01', checkoutDate: '2027-05-04' }));
    expect(s.event).toMatchObject({ title: 'Hotel Ríos', allDay: true, location: 'Hotel Ríos, 1 Calle, Madrid' });
    expect(s.event!.start.getDate()).toBe(1);
    const micro = '<div itemscope itemtype="http://schema.org/Order"><span itemprop="orderNumber">A-77</span>'
      + '<div itemprop="merchant" itemscope itemtype="http://schema.org/Organization"><span itemprop="name">Shop</span></div>'
      + '<link itemprop="url" href="https://shop.example/orders/77"></div>';
    const [m] = findCards(micro);
    expect(m).toMatchObject({ kind: 'order', name: 'Shop', link: { host: 'shop.example' } });
    expect(findCards('<p>no data</p>')).toEqual([]);
    expect(findCards(ld({ '@type': 'Person', name: 'x' }))).toEqual([]);
  });
});

describe('a date in plain text', () => {
  const ref = new Date(2026, 10, 8, 9, 0); // Sun 8 Nov 2026
  const at = (s: string) => { const w = findWhen(s, ref); return w && [w.start.getFullYear(), w.start.getMonth() + 1, w.start.getDate(), w.allDay ? null : `${w.start.getHours()}:${w.start.getMinutes()}`]; };
  it('reads common English forms', () => {
    expect(at('See you Friday 14 Dec at 3pm!')).toEqual([2026, 12, 14, '15:0']);
    expect(at('Dinner on December 3rd, 7:30 pm')).toEqual([2026, 12, 3, '19:30']);
    expect(at('Due 2 March 2027')).toEqual([2027, 3, 2, null]);
    expect(at('Party Jan 9 at 18:00')).toEqual([2027, 1, 9, '18:0']); // no year, already past this year: next year
    expect(at('call tomorrow at 10am')).toEqual([2026, 11, 9, '10:0']);
    expect(at('Wednesday at 2:15pm works')).toEqual([2026, 11, 11, '14:15']);
    expect(at('14 Dec 2026 3 people')).toEqual([2026, 12, 14, null]); // "3" is not a time
  });
  it('ignores what is not a date', () => {
    expect(at('Order 12 shipped')).toBeNull();
    expect(at('31 Feb')).toBeNull();
    expect(at('Version 3 March')).toEqual([2027, 3, 3, null]); // a real date; the caller hides it if past
  });
  it('knows month names in the UI language too', () => {
    const w = findWhen('Rendez-vous le 14 décembre', ref, 'fr');
    expect(w && [w.start.getMonth() + 1, w.start.getDate()]).toEqual([12, 14]);
  });
});

describe('who sent it', () => {
  const ar = (r: string) => `mail.ours.test; ${r}`, received = 'from x by mail.ours.test with ESMTPS';
  const m = (name: string, email: string, a?: string) => ({ from: [{ name, email }], authResults: a ? [a] : [], received: a ? received : null });
  it('verified only when DMARC passed for the From domain', () => {
    expect(trust(m('Ann', 'ann@example.org', ar('dmarc=pass header.from=example.org')), 'me@ours.test').verified).toBe(true);
    expect(trust(m('Ann', 'ann@example.org', ar('dkim=pass header.d=example.org')), 'me@ours.test').verified).toBe(false); // DKIM alone: no mark
    expect(trust(m('Bo', 'bo@ours.test'), 'me@ours.test').verified).toBe(false); // between accounts here: no outside check, no mark
  });
  it('a big brand in the name on unverified mail is a warning', () => {
    expect(trust(m('PayPal Security', 'service@paypa1.example', ar('dmarc=fail header.from=paypa1.example')), 'me@ours.test').brand).toBe('PayPal');
    expect(trust(m('PayPal', 'service@paypal.com', ar('dmarc=pass header.from=paypal.com')), 'me@ours.test').brand).toBeNull();
    expect(trust(m('Grapple Inc', 'x@grapple.example', ar('dmarc=fail')), 'me@ours.test').brand).toBeNull(); // word, not substring
    // A lookalike domain that passes its own DMARC still gets the warning; the brand's real domain doesn't.
    expect(trust(m('PayPal', 'help@paypal-support.example', ar('dmarc=pass header.from=paypal-support.example')), 'me@ours.test').brand).toBe('PayPal');
    expect(trust(m('PayPal', 'service@mail.paypal.com', ar('dmarc=pass header.from=mail.paypal.com')), 'me@ours.test').brand).toBeNull();
    // A colleague here naming themselves "PayPal" is warned about too (nothing outside checked it).
    expect(trust(m('PayPal Support', 'bo@ours.test'), 'me@ours.test').brand).toBe('PayPal');
    // "OpenMail" from anywhere but this server is a warning; our own notices aren't.
    expect(trust(m('OpenMail Security', 'alert@openmail-help.example', ar('dmarc=pass header.from=openmail-help.example')), 'me@ours.test').brand).toBe('OpenMail');
    expect(trust(m('OpenMail', 'noreply@ours.test'), 'me@ours.test').brand).toBeNull();
  });
});
