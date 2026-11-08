import { describe, expect, it } from 'vitest';
import { confidentialIds, confidentialUrl, parseFragment, seal, unseal } from './seal';

const msg = { subject: 'Offer letter', sent: '2026-11-08T10:00:00.000Z', text: 'Salary: 100\nStart: Monday' };

describe('confidential messages', () => {
  it('opens with the key from the link, and with nothing else', async () => {
    const { blob, key } = await seal(msg);
    expect(new TextDecoder().decode(blob)).not.toContain('Salary'); // stored bytes are ciphertext
    expect(await unseal(blob, key)).toEqual(msg);
    const other = (await seal(msg)).key;
    await expect(unseal(blob, other)).rejects.toThrow();
    const tampered = blob.slice(); tampered[20] ^= 1;
    await expect(unseal(tampered, key)).rejects.toThrow();
  });

  it('a passcode is needed as well as the key', async () => {
    const { blob, key } = await seal(msg, 'purple river lamp');
    expect(await unseal(blob, key, ' purple river lamp ')).toEqual(msg); // trimmed, as typed
    await expect(unseal(blob, key)).rejects.toThrow();
    await expect(unseal(blob, key, 'purple river')).rejects.toThrow();
  });

  it('links keep the key after "#" and are recognised only for this server', async () => {
    const id = 'A'.repeat(24), { key } = await seal(msg);
    const url = confidentialUrl('https://mail.example', id, key, true);
    const u = new URL(url);
    expect(u.pathname).toBe('/confidential.html');
    expect(u.search).toBe('');
    expect(parseFragment(u.hash)).toEqual({ id, key, passcode: true });
    expect(parseFragment('#id=short&k=x')).toBeNull();
    expect(confidentialIds(`<a href="${url.replace(/&/g, '&amp;')}">open</a>`, 'https://mail.example')).toEqual([id]);
    expect(confidentialIds(url, 'https://evil.example')).toEqual([]);
  });
});
