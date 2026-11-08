// Emoji reactions, RFC 9078: a reply whose body is one text/plain part marked "Content-Disposition: reaction" holding
// just the emoji. Mail apps that don't know reactions show it as a tiny reply with the emoji in it (the RFC's fallback).
import type { Address, Draft, EmailFull } from './jmap';
import { draftFor } from './mailutil';

export const COMMON_REACTIONS = ['👍', '❤\ufe0f', '😂', '😮', '😢', '🙏'];

/** One emoji (with skin tone, ZWJ sequence or flag), nothing else: what RFC 9078 allows in a reaction part. */
export const isReaction = (s: string) => {
  const x = s.trim();
  return x.length > 0 && x.length <= 32 && /^[\p{Extended_Pictographic}\p{Emoji_Component}\p{Emoji_Modifier}\u200d\ufe0f\u20e3]+$/u.test(x)
    && /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3/u.test(x);
};

/** The reaction a fetched message carries (its body part marked "reaction"), or null for ordinary mail. */
export function reactionOf(e: { textBody?: { partId: string; disposition?: string | null }[]; bodyValues?: Record<string, { value: string }>; inReplyTo?: string[] | null }): string | null {
  const part = e.textBody?.find((p) => p.disposition?.toLowerCase() === 'reaction');
  const v = part && e.bodyValues?.[part.partId]?.value.trim();
  return v && e.inReplyTo?.length && isReaction(v) ? v : null; // a reaction without In-Reply-To has nothing to attach to
}

/** The reaction as a draft: addressed like Reply all, threaded under the message, body = the emoji. */
export function reactionDraft(m: EmailFull, emoji: string, me: string, mine: string[] = []): Draft {
  const d = draftFor('replyAll', { ...m, html: null, text: '', attachments: [] }, me, mine); // no quote: just the addresses and threading
  return { to: d.to, cc: d.cc, from: d.from, subject: d.subject, inReplyTo: d.inReplyTo, references: d.references,
    html: '', text: emoji, attachments: [], reaction: emoji };
}

/** Email/set body for a reaction: a single text/plain part with Content-Disposition: reaction. */
export const reactionBody = (emoji: string) => ({
  bodyValues: { t: { value: emoji } },
  bodyStructure: { partId: 't', type: 'text/plain', disposition: 'reaction' },
});

/** Reactions in a conversation, by the Message-ID they answer: emoji → who. */
export function groupReactions(messages: EmailFull[]): Map<string, Map<string, Address[]>> {
  const out = new Map<string, Map<string, Address[]>>();
  for (const m of messages) {
    if (!m.reaction) continue;
    const target = m.inReplyTo![0], by = out.get(target) ?? new Map<string, Address[]>();
    const who = m.from?.[0];
    // One reaction per person per emoji, however many times it was sent.
    if (who && !(by.get(m.reaction) ?? []).some((a) => a.email.toLowerCase() === who.email.toLowerCase())) by.set(m.reaction, [...(by.get(m.reaction) ?? []), who]);
    out.set(target, by);
  }
  return out;
}
