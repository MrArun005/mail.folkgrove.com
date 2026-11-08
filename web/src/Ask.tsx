import { useEffect, useState } from 'react';
import { answerFromMail, citations, keywords, searchTerms, visibleText, type AskSource } from './ai';
import type { Jmap } from './jmap';
import { Icon } from './icons';
import { locale, t } from './i18n';

type Hit = AskSource & { threadId: string };

/** The normal server search (as the search box does it): newest 20 messages with any of the terms, Junk left out. */
async function find(client: Jmap, terms: string[]): Promise<Hit[]> {
  if (!terms.length) return [];
  const junk = (await client.mailboxes()).find((b) => b.role === 'junk');
  const any = { operator: 'OR', conditions: terms.map((text) => ({ text })) };
  const [, r] = await client.call([
    ['Email/query', { accountId: client.accountId, sort: [{ property: 'receivedAt', isAscending: false }], limit: 20,
      filter: junk ? { operator: 'AND', conditions: [any, { operator: 'NOT', conditions: [{ inMailbox: junk.id }] }] } : any }, 'q'],
    ['Email/get', { accountId: client.accountId, '#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' },
      properties: ['threadId', 'from', 'subject', 'receivedAt', 'textBody', 'htmlBody', 'bodyValues'],
      fetchTextBodyValues: true, fetchHTMLBodyValues: true, maxBodyValueBytes: 4000 }, 'g'],
  ]);
  type Part = { partId: string; type: string };
  return (r.list as { threadId: string; from: { name: string | null; email: string }[] | null; subject: string | null; receivedAt: string;
    textBody: Part[]; htmlBody: Part[]; bodyValues: Record<string, { value: string }> }[]).map((e) => {
    const plain = e.textBody.find((p) => p.type === 'text/plain'), html = e.htmlBody.find((p) => p.type === 'text/html');
    // Plain text as sent; HTML only as far as a reader can see it (hidden text could carry instructions).
    const text = plain ? e.bodyValues[plain.partId]?.value ?? '' : html ? visibleText(e.bodyValues[html.partId]?.value ?? '') : '';
    const f = e.from?.[0];
    return { threadId: e.threadId, from: f ? (f.name ? `${f.name} (${f.email})` : f.email) : '', subject: e.subject ?? '',
      date: new Date(e.receivedAt).toLocaleDateString(locale(), { dateStyle: 'medium' }), text };
  });
}

/** "Ask your inbox", inside the ⌘K palette: search on the server, answer on this device, cite what it used. */
export function AskInbox({ client, question, onOpen }: { client: Jmap; question: string; onOpen: (threadId: string) => void }) {
  const [step, setStep] = useState(t('ask.searching'));
  const [result, setResult] = useState<{ answer: string; cited: Hit[] } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    (async () => {
      const kw = keywords(question);
      const terms = await searchTerms(question).catch(() => []);
      let hits = await find(client, terms.length ? terms : kw);
      if (!hits.length && terms.length) hits = await find(client, kw);
      if (!live) return;
      if (!hits.length) return setResult({ answer: t('ask.nothingFound'), cited: [] });
      setStep(t('ask.reading', { count: hits.length }));
      const answer = await answerFromMail(question, hits);
      if (live) setResult({ answer, cited: citations(answer, hits.length).map((n) => hits[n - 1]) });
    })().catch((e) => live && setError((e as Error).message));
    return () => { live = false; };
  }, [client, question]);

  return (
    <div className="ask" aria-live="polite" aria-busy={!result && !error}>
      {error ? <p className="error" role="alert">{error}</p>
        : !result ? <p className="fine">{step}</p>
        : <>
          <p className="ask-answer">{result.answer}</p>
          {result.cited.length > 0 && (
            <ul className="ask-sources" aria-label={t('ask.sources')}>
              {result.cited.map((h, i) => (
                <li key={i}>
                  <button className="menu-item" onClick={() => onOpen(h.threadId)}>
                    <Icon name="inbox" size={16} /><span className="grow">{h.subject || t('reader.noSubject')}</span>
                    <span className="fine">{h.from.replace(/ \(.*\)$/, '')} · {h.date}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>}
      <p className="fine ask-note">{t('ask.onDevice')}</p>
    </div>
  );
}
