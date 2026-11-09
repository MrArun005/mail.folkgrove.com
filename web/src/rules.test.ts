import { describe, expect, it } from 'vitest';
import { categorize, matchesRule, parseRules, toSieve, validateRule, type Rule } from './rules';

const rules: Rule[] = [
  { id: '1', from: 'news@shop.example', action: 'move', folder: 'Shopping' },
  { id: '2', from: 'spammer.example', action: 'block' },
  { id: '3', subject: 'invoice "Q4"', to: 'billing@', action: 'star' },
  { id: '4', from: 'boss@x.org', action: 'forward', forwardTo: 'me@phone.example' },
  { id: '5', action: 'trash' }, // invalid: no condition, must be skipped
];

it('compiles rules to Sieve with escaping and stops after moves', () => {
  const s = toSieve({ rules, vacation: { enabled: false }, categories: false }, { trash: 'Deleted Items', junk: 'Junk Mail' });
  expect(s).toContain('require ["fileinto", "imap4flags", "mailbox", "copy", "vacation", "date", "relational", "spamtest", "body"];');
  expect(s).toContain('if allof(address :contains "from" "news@shop.example") { fileinto :create "Shopping"; stop; }');
  expect(s).toContain('if allof(address :contains "from" "spammer.example") { fileinto "Junk Mail"; addflag "\\\\Seen"; stop; }');
  expect(s).toContain('if allof(address :contains ["to", "cc"] "billing@", header :contains "subject" "invoice \\"Q4\\"") { addflag "\\\\Flagged"; }');
  expect(s).toContain('redirect :copy "me@phone.example";');
  expect(s.match(/^if /gm)).toHaveLength(5); // the four rules and the purchases mark
});

it('round-trips the rules through the script', () => {
  expect(parseRules(toSieve({ rules, vacation: { enabled: false } }, { trash: 'Trash', junk: 'Junk' }))).toEqual(rules);
  expect(parseRules('require "fileinto";')).toEqual([]);
});

it('explains what is missing', () => {
  expect(validateRule({ id: 'x', action: 'move', from: 'a' })).toMatch(/folder/);
  expect(validateRule({ id: 'x', action: 'forward', from: 'a', forwardTo: 'nope' })).toMatch(/valid address/);
  expect(validateRule({ id: 'x', action: 'read' })).toMatch(/condition/);
});

it('out-of-office lives in the same script: after blocks, before other rules, with dates', async () => {
  const { parseScript } = await import('./rules');
  const vacation = { enabled: true, from: '2026-12-20', to: '2027-01-02', subject: 'Away', body: 'Back on the 3rd.' };
  const s = toSieve({ rules, vacation }, { trash: 'Deleted Items', junk: 'Junk Mail' });
  const at = (t: string) => s.indexOf(`if allof(address :contains "from" "${t}")`);
  const block = at('spammer.example'), reply = s.indexOf('vacation :days 1'), move = at('news@shop.example');
  expect(block).toBeGreaterThan(0);
  expect(reply).toBeGreaterThan(block);
  expect(move).toBeGreaterThan(reply);
  expect(s).toContain('if allof(currentdate :value "ge" "date" "2026-12-20", currentdate :value "le" "date" "2027-01-02") { vacation :days 1 :subject "Away" "Back on the 3rd."; }');
  expect(parseScript(s)).toEqual({ rules, vacation });
  expect(toSieve({ rules, vacation: { enabled: false } }, { trash: 'T', junk: 'J' })).not.toContain('vacation :days');
  // Scripts saved before out-of-office moved in still read back.
  expect(parseScript('# openmail-rules: [{"id":"9","from":"a","action":"star"}]').rules).toHaveLength(1);
});

it('Block sender matches the exact address only', () => {
  const s = toSieve({ rules: [{ id: 'b', from: 'bob@x.com', fromExact: true, action: 'block' }], vacation: { enabled: false } }, { trash: 'T', junk: 'J' });
  expect(s).toContain('if allof(address :is "from" "bob@x.com")');
  expect(s).not.toContain(':contains "from" "bob@x.com"');
});

it('sorts newsletters and automated senders into Updates unless turned off', () => {
  const on = toSieve({ rules: [], vacation: { enabled: false } }, { trash: 'T', junk: 'J' });
  expect(on).toContain('if anyof(exists "list-unsubscribe", exists "list-id", address :localpart :contains "from" ["noreply", "no-reply", "donotreply", "notifications", "mailer-daemon"]) { addflag "$updates"; }');
  expect(on).not.toContain('$promotions'); // saved before the other tabs existed: only Updates
  expect(toSieve({ rules: [], vacation: { enabled: false }, categories: false }, { trash: 'T', junk: 'J' })).not.toContain('$updates');
});

it('sorts into the chosen tabs, one per message, and marks purchases either way', () => {
  const s = toSieve({ rules: [], vacation: { enabled: false }, tabs: ['updates', 'social', 'promotions'] }, { trash: 'T', junk: 'J' });
  expect(s).toMatch(/^if address :domain :matches "from" \[.*"\*\.facebookmail\.com".*\] \{ addflag "\$social"; \}\nelsif allof\(not hasflag "\$purchase", .*\{ addflag "\$promotions"; \}\nelsif anyof\(exists "list-unsubscribe".*\$updates/m);
  expect(s).not.toContain('$forums');
  expect(s).toContain('"body"];');
  expect(toSieve({ rules: [], vacation: { enabled: false }, categories: false }, { trash: 'T', junk: 'J' })).toContain('addflag "$purchase"');
});

it('sorts old mail the way the server rule does', () => {
  const all = ['promotions', 'social', 'updates', 'forums'] as const;
  expect(categorize({ from: 'x@mail.linkedin.com', listUnsubscribe: '<u>' }, all)).toBe('social');
  expect(categorize({ from: 'x@lists.example.org', listId: '<dev.example.org>', listPost: '<mailto:dev@example.org>' }, all)).toBe('forums');
  expect(categorize({ from: 'deals@shop.example', precedence: 'bulk' }, all)).toBe('promotions');
  expect(categorize({ from: 'noreply@bank.example', listUnsubscribe: '<u>' }, all)).toBe('updates');
  expect(categorize({ from: 'deals@shop.example', listUnsubscribe: '<u>' }, ['updates'])).toBe('updates'); // tab off: falls through
  expect(categorize({ from: 'ann@example.org' }, all)).toBeNull();
});

it('Screener holds unknown senders after your own filters', () => {
  const s = toSieve({ rules: [{ id: '1', from: 'bank.example', action: 'move', folder: 'Bank' }], vacation: { enabled: false },
    screener: { on: true, allow: ['Ann@X.org', 'ann@x.org', 'bad"quote@x.org', 'not-an-address'] } }, { trash: 'T', junk: 'J' });
  expect(s).toContain('if allof(not spamtest :value "ge" :comparator "i;ascii-numeric" "6", not address :is "from" ["ann@x.org"]) { fileinto :create "Screener"; stop; }');
  expect(s.indexOf('Screener: first-time')).toBeGreaterThan(s.indexOf('fileinto :create "Bank"'));
  expect(toSieve({ rules: [], vacation: { enabled: false }, screener: { on: false, allow: [] } }, { trash: 'T', junk: 'J' })).not.toContain('Screener"');
});

describe('matchesRule (the preview before saving)', () => {
  const m = { from: [{ email: 'News@Shop.example' }], to: [{ email: 'alice@openmail.test' }], subject: 'Your ORDER has shipped' };
  it('matches like the server: contains, ignoring case; every filled field must match', () => {
    expect(matchesRule({ from: 'shop.example' }, m)).toBe(true);
    expect(matchesRule({ subject: 'order' }, m)).toBe(true);
    expect(matchesRule({ from: 'shop.example', subject: 'invoice' }, m)).toBe(false);
    expect(matchesRule({ to: 'alice@' }, m)).toBe(true);
    expect(matchesRule({ to: 'bob@' }, { ...m, cc: [{ email: 'bob@x.example' }] })).toBe(true);
  });
  it('exact sender does not over-match; an empty rule matches nothing', () => {
    expect(matchesRule({ from: 'shop.example', fromExact: true }, m)).toBe(false);
    expect(matchesRule({ from: 'news@shop.example', fromExact: true }, m)).toBe(true);
    expect(matchesRule({}, m)).toBe(false);
    expect(matchesRule({ from: '  ' }, m)).toBe(false);
  });
});
