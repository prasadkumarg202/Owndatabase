// OwnDatabase function runner.
//
// Runs ONE invocation of user code in a separate Node.js process started with
// the Node permission model (no file writes, no child processes, no worker
// threads, no native addons) and a stripped environment. Network access is
// allowed so functions can call APIs. This is process-level isolation with a
// hard timeout and memory cap — not a hardened multi-tenant sandbox.
//
// Protocol: stdin = JSON { codeFile, request, env }, stdout = JSON result on the
// last line prefixed with "__ODB_RESULT__".

const logs = [];
const push = (level) => (...args) => {
  const line = args.map((a) => (typeof a === 'string' ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })())).join(' ');
  if (logs.length < 500) logs.push(`[${level}] ${line}`.slice(0, 4000));
};
console.log = push('log'); console.info = push('info'); console.warn = push('warn'); console.error = push('error'); console.debug = push('debug');

function emit(obj) {
  process.stdout.write('\n__ODB_RESULT__' + JSON.stringify({ ...obj, logs }) + '\n');
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', async () => {
  try {
    const { codeFile, request, env } = JSON.parse(input);
    globalThis.Deno = undefined;
    const envObj = Object.freeze({ ...env });
    globalThis.env = envObj;
    const mod = await import(codeFile);
    const handler = mod.default ?? mod.handler;
    if (typeof handler !== 'function') throw new Error('Function must export a default handler: export default async function (req) {}');

    const req = {
      method: request.method,
      url: request.url,
      path: request.path,
      headers: request.headers,
      query: request.query,
      body: request.body,
      env: envObj,
      json: async () => (typeof request.body === 'string' ? JSON.parse(request.body) : request.body),
      text: async () => (typeof request.body === 'string' ? request.body : JSON.stringify(request.body ?? null)),
    };
    const out = await handler(req, { env: envObj });

    if (out instanceof Response) {
      const headers = {};
      out.headers.forEach((v, k) => { headers[k] = v; });
      emit({ ok: true, status: out.status, headers, body: await out.text() });
    } else if (out && typeof out === 'object' && ('status' in out || 'body' in out) && Object.keys(out).every((k) => ['status', 'headers', 'body'].includes(k))) {
      const body = typeof out.body === 'string' ? out.body : JSON.stringify(out.body ?? null);
      emit({ ok: true, status: out.status ?? 200, headers: { 'content-type': typeof out.body === 'string' ? 'text/plain; charset=utf-8' : 'application/json', ...(out.headers ?? {}) }, body });
    } else {
      emit({ ok: true, status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(out ?? null) });
    }
  } catch (err) {
    emit({ ok: false, status: 500, error: (err && err.stack) ? String(err.stack).split('\n').slice(0, 5).join('\n') : String(err) });
  }
});
