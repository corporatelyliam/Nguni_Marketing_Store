// Runs the real public/js/api.js in a sandbox to test its pure helpers.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const src = fs.readFileSync(path.join(__dirname, '../../../public/js/api.js'), 'utf8');
const ctx = { location: { origin: 'https://nguni.example', pathname: '/', search: '' }, document: { createElement: () => { let t = ''; return { set textContent(v) { t = String(v ?? ''); }, get innerHTML() { return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); } }; } }, fetch: () => {}, URL, console };
vm.createContext(ctx); vm.runInContext(src + '\nthis.safeNext = safeNext; this.money = money; this.statusLabel = statusLabel; this.escapeHtml = escapeHtml;', ctx);

test('post-login redirect only accepts same-site paths (no open redirect)', () => {
  for (const ok of ['/account.html', '/order.html?id=abc-123', '/admin/index.html#orders']) assert.equal(ctx.safeNext(ok), ok);
  for (const bad of ['https://evil.example', '//evil.example', '/\\evil.example', 'javascript:alert(1)', 'evil.com', '', null, undefined, 42, 'http://nguni.example.evil.com/x'])
    assert.equal(ctx.safeNext(bad), null, String(bad));
});
test('formatting helpers', () => {
  assert.equal(ctx.money(1234.5), 'N$1,234.50'); assert.equal(ctx.money(null), 'N$0.00');
  assert.equal(ctx.statusLabel('payment_submitted'), 'Payment Submitted');
  assert.equal(ctx.escapeHtml('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;');
});
