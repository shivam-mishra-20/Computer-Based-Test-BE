/* Verify the empty-body-skip middleware: body-less POSTs pass through,
 * valid JSON still parses, malformed non-empty JSON still rejected. */
const express = require('express');

const BODY_LIMIT = '10mb';
const app = express();

// --- the exact middleware from app.ts ---
const jsonParser = express.json({ limit: BODY_LIMIT });
app.use((req, res, next) => {
  const contentLength = req.headers['content-length'];
  const hasBody =
    (contentLength !== undefined && contentLength !== '0') ||
    req.headers['transfer-encoding'] !== undefined;
  if (!hasBody) {
    if (req.body === undefined) req.body = {};
    return next();
  }
  return jsonParser(req, res, next);
});
// ----------------------------------------

app.post('/enroll', (req, res) => {
  // mimic a body-less route that doesn't read req.body
  res.json({ ok: true, body: req.body });
});
app.post('/login', (req, res) => {
  // mimic a route that destructures req.body
  const { email } = req.body;
  res.json({ ok: true, email: email || null });
});

// error handler (so parse errors surface as JSON like the real app)
app.use((err, req, res, _next) => {
  res.status(err.status || 500).json({ error: err.message });
});

const server = app.listen(0, async () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  const cases = [
    ['enroll, application/json + NO body', '/enroll', { 'Content-Type': 'application/json' }, undefined],
    ['enroll, NO content-type + NO body', '/enroll', {}, undefined],
    ['login, valid JSON body', '/login', { 'Content-Type': 'application/json' }, JSON.stringify({ email: 'a@b.com' })],
    ['login, application/json + empty body', '/login', { 'Content-Type': 'application/json' }, ''],
    ['login, MALFORMED non-empty JSON', '/login', { 'Content-Type': 'application/json' }, '{bad json'],
  ];
  for (const [label, path, headers, body] of cases) {
    try {
      const res = await fetch(`${base}${path}`, { method: 'POST', headers, ...(body !== undefined ? { body } : {}) });
      const text = await res.text();
      console.log(`${res.status}  ${label}\n      → ${text.slice(0, 120)}`);
    } catch (e) {
      console.log(`ERR ${label}: ${e.message}`);
    }
  }
  server.close();
});
