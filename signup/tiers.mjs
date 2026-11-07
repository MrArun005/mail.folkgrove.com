// Sending tiers. A new account sits on the "new-accounts" list (Stalwart x:MemoryLookupKey, namespace "new-accounts",
// key = full address) for its first days: install.sh's rules then give it Zoho-like limits (50 recipients per
// message, 50 outside recipients an hour). An hourly job promotes accounts that have aged out.
// ponytail: promotion is by age only. Next: hold back accounts with bounces or spam complaints (ARF reports).

export const NEW_ACCOUNT_DAYS = 14;

export function tiers({ jmap, getDomainId, cfg }) {
  const days = cfg.newAccountDays ?? NEW_ACCOUNT_DAYS;

  const reload = () => jmap([['x:Action/set', { create: { r: { '@type': 'ReloadLookupStores' } } }, 'r']]);

  async function markNew(address) {
    await jmap([['x:MemoryLookupKey/set', { create: { k: { namespace: 'new-accounts', key: address.toLowerCase() } } }, 'k']]);
    await reload();
  }

  /** Remove accounts older than `days` from the list. Returns the promoted addresses. */
  async function promote(now = Date.now()) {
    const ids = (await jmap([['x:MemoryLookupKey/query', { filter: { namespace: 'new-accounts' } }, 'q']])).ids;
    const keys = ids.length ? (await jmap([['x:MemoryLookupKey/get', { ids }, 'g']])).list : [];
    const accIds = (await jmap([['x:Account/query', { filter: { domainId: await getDomainId() } }, 'q']])).ids;
    const accounts = accIds.length ? (await jmap([['x:Account/get', { ids: accIds, properties: ['emailAddress', 'createdAt', 'description'] }, 'g']])).list : [];
    // Fail safe: a self-signed-up account still inside the window that isn't on the list (a failed mark at sign-up) is added.
    const listed = new Set(keys.map((k) => k.key));
    for (const a of accounts) {
      const addr = String(a.emailAddress).toLowerCase();
      if (String(a.description ?? '').startsWith('Self sign-up') && now - Date.parse(a.createdAt) <= days * 86400e3 && !listed.has(addr)) await markNew(addr);
    }
    const created = new Map(accounts.map((a) => [String(a.emailAddress).toLowerCase(), Date.parse(a.createdAt)]));
    // Only accounts we can see and that have aged out. (A brand-new account can be missing from the search index for a
    // moment; a deleted one's entry is harmless, since addresses are never reused.)
    const due = keys.filter((k) => { const c = created.get(k.key); return c !== undefined && now - c > days * 86400e3; });
    if (!due.length) return [];
    await jmap([['x:MemoryLookupKey/set', { destroy: due.map((k) => k.id) }, 'd']]);
    await reload();
    return due.map((k) => k.key);
  }

  return { markNew, promote };
}
