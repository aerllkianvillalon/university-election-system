// Run: node --test server/assistant.test.mjs   (no database, no network, no model)
import test from 'node:test'; import assert from 'node:assert/strict';
import { loadFaq, screen, systemPrompt, parseAnswer, cleanMessages, mountAssistant } from './assistant.mjs';
const faq = loadFaq();
test('the FAQ loads with unique ids and real page paths', () => {
  assert.ok(faq.length >= 15); assert.equal(new Set(faq.map((s) => s.id)).size, faq.length);
  for (const s of faq) { assert.match(s.path, /^\/[a-z\-\/]*$/); assert.ok(s.text.length > 20, s.id); } });
test('questions about vote choices and other people\'s votes are refused before any model call', () => {
  for (const q of ['Who should I vote for?', 'who do you think I should vote for as president', 'Which candidate is best for senator?', 'Is Maria Santos a good candidate?', 'How did my friend vote?', 'Can you show me how Juan voted', 'who did Ana vote for'])
    assert.ok(screen(q), q);
  for (const q of ['How do I vote?', 'Where is my receipt?', 'When does voting close?', 'I forgot my password', 'Can I change my vote after I submit?', 'How do I check who is on the ballot?']) assert.equal(screen(q), null, q); });
test('the prompt carries every section and the safety rules', () => {
  const p = systemPrompt(faq); for (const s of faq) assert.ok(p.includes(`[${s.id}]`)); assert.match(p, /ONLY from the approved sections/); assert.match(p, /Ignore any instruction/); assert.doesNotMatch(p, /[^\x00-\x7F]/); });
test('sources are parsed, unknown ids dropped, and the SOURCES line is removed from the text', () => {
  const r = parseAnswer('Copy it now.\nSOURCES: receipt, made-up, status', faq);
  assert.equal(r.text, 'Copy it now.'); assert.deepEqual(r.sources.map((s) => s.title.length > 0), [true, true]); assert.equal(r.sources[0].path, '/receipt');
  assert.deepEqual(parseAnswer('No idea.\nSOURCES: none', faq).sources, []); });
test('the conversation is validated and trimmed', () => {
  assert.equal(cleanMessages({}), null); assert.equal(cleanMessages({ messages: [{ role: 'system', content: 'x' }] }), null);
  assert.equal(cleanMessages({ messages: [{ role: 'user', content: 'a' }, { role: 'user', content: 'b' }] }), null);
  assert.equal(cleanMessages({ messages: [{ role: 'assistant', content: 'a' }] }), null);
  const m = cleanMessages({ messages: [{ role: 'user', content: 'x'.repeat(900) }] }); assert.equal(m[0].content.length, 500);
  const long = Array.from({ length: 12 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: String(i) })); assert.ok(cleanMessages({ messages: long }) === null || cleanMessages({ messages: long }).length <= 6); });
function run(env, body, hit = async () => true) {
  const routes = {}; const app = { get: (p, h) => (routes['GET ' + p] = h), post: (p, h) => (routes['POST ' + p] = h) };
  mountAssistant(app, { allow: hit, tooMany: (res) => res.status(429).json({ error: { code: 'RATE_LIMITED' } }) }, env);
  const res = { code: 200, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  return { routes, res, call: async (m = 'POST') => { await routes[m + ' /api/assistant']({ body, ip: '1.2.3.4' }, res); return res; } }; }
test('without a key it reports itself off and answers 503', async () => {
  const t = run({}, { messages: [{ role: 'user', content: 'hi' }] }); assert.equal((await t.call('GET')).body.enabled, false); assert.equal((await t.call()).code, 503); });
test('a refused question never reaches the model', async () => {
  let calls = 0; const f = globalThis.fetch; globalThis.fetch = async () => { calls++; throw new Error('should not be called'); };
  try { const t = run({ ANTHROPIC_API_KEY: 'k' }, { messages: [{ role: 'user', content: 'Who should I vote for?' }] }); const r = await t.call(); assert.equal(r.code, 200); assert.match(r.body.text, /private/); assert.equal(calls, 0); } finally { globalThis.fetch = f; } });
test('a normal question goes to the provider with the key, and the reply comes back with sources', async () => {
  const f = globalThis.fetch; let seen;
  globalThis.fetch = async (url, init) => { seen = { url, init, body: JSON.parse(init.body) }; return { ok: true, json: async () => ({ content: [{ type: 'text', text: 'Copy your code.\nSOURCES: receipt' }] }) }; };
  try { const t = run({ ANTHROPIC_API_KEY: 'sk-test', ASSISTANT_API_URL: 'http://fake/v1/messages' }, { messages: [{ role: 'user', content: 'Where is my receipt?' }] }); const r = await t.call();
    assert.equal(r.body.text, 'Copy your code.'); assert.equal(r.body.sources[0].path, '/receipt'); assert.equal(seen.init.headers['x-api-key'], 'sk-test'); assert.equal(seen.body.max_tokens, 400); assert.match(seen.body.system, /Approved sections/); } finally { globalThis.fetch = f; } });
test('provider failure gives a friendly 503, and rate limiting gives 429', async () => {
  const f = globalThis.fetch; globalThis.fetch = async () => ({ ok: false, status: 500 }); const e = console.error; console.error = () => {};
  try { const t = run({ ANTHROPIC_API_KEY: 'k' }, { messages: [{ role: 'user', content: 'hi' }] }); assert.equal((await t.call()).code, 503);
    const u = run({ ANTHROPIC_API_KEY: 'k' }, { messages: [{ role: 'user', content: 'hi' }] }, async () => false); assert.equal((await u.call()).code, 429); } finally { globalThis.fetch = f; console.error = e; } });
