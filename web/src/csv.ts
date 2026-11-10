// CSV for the admin console's bulk add (Admin.tsx): read a pasted or uploaded list, write the new passwords back out.
// RFC 4180: commas, "quoted" fields with "" for a quote and line breaks inside. No dependency for ~30 lines.

/** Rows of fields; blank lines are dropped. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { f += '"'; i++; } else if (c === '"') q = false; else f += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(f); rows.push(row); row = []; f = '';
    } else f += c;
  }
  row.push(f); rows.push(row);
  return rows.filter((r) => r.some((x) => x.trim()));
}

export const toCsv = (rows: string[][]) =>
  rows.map((r) => r.map((x) => (/[",\r\n]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x)).join(',')).join('\r\n') + '\r\n';

export interface ImportRow { name: string; description: string; password: string; quotaBytes?: number | string }

/** The columns: username, display name, password, storage limit in GB (all but the first optional). A first line
 *  starting "username" is a header. An unreadable limit goes to the server as written, so it's reported, not dropped. */
export function importRows(table: string[][]): ImportRow[] {
  const body = /^\s*user/i.test(table[0]?.[0] ?? '') ? table.slice(1) : table;
  return body.map(([name = '', description = '', password = '', gb = '']) => {
    const g = gb.trim(), n = Number(g.replace(',', '.'));
    return { name: name.trim(), description: description.trim(), password: password.trim(), ...(g && { quotaBytes: n >= 0 ? Math.round(n * 1024 ** 3) : g }) };
  });
}
