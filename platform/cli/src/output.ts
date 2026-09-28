/** Output helpers: aligned tables, colours (disabled when not a TTY or NO_COLOR), JSON mode. */
const color = process.stdout.isTTY && !process.env['NO_COLOR'];
const wrap = (code: number) => (s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
export const green = wrap(32), red = wrap(31), yellow = wrap(33), dim = wrap(2), bold = wrap(1), cyan = wrap(36);

export let jsonMode = false;
export function setJson(v: boolean) { jsonMode = v; }

export function print(data: unknown, columns?: string[]) {
  if (jsonMode) { console.log(JSON.stringify(data, null, 2)); return; }
  if (Array.isArray(data) && columns) return table(data, columns);
  if (data && typeof data === 'object') {
    for (const [k, v] of Object.entries(data)) console.log(`${bold(k.padEnd(22))} ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`);
    return;
  }
  console.log(String(data));
}

export function table(rows: any[], columns: string[]) {
  if (!rows.length) { console.log(dim('(no rows)')); return; }
  const cell = (v: unknown) => (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)).replace(/\n/g, ' ');
  const widths = columns.map((c) => Math.min(60, Math.max(c.length, ...rows.map((r) => cell(r[c]).length))));
  const line = (vals: string[]) => vals.map((v, i) => v.slice(0, widths[i]).padEnd(widths[i]!)).join('  ');
  console.log(bold(line(columns)));
  console.log(dim(widths.map((w) => '─'.repeat(w)).join('  ')));
  for (const r of rows) console.log(line(columns.map((c) => cell(r[c]))));
}

export function fail(err: unknown): never {
  const e = err as { message?: string; status?: number };
  console.error(red(`✗ ${e.message ?? String(err)}`) + (e.status ? dim(` (HTTP ${e.status})`) : ''));
  process.exit(1);
}

export async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

export async function prompt(question: string, hidden = false): Promise<string> {
  const rl = (await import('node:readline')).createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  if (hidden) {
    const out = rl as any;
    out._writeToOutput = (s: string) => { if (s.includes(question)) process.stdout.write(s); };
  }
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); if (hidden) process.stdout.write('\n'); resolve(a); }));
}
