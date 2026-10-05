// Loads a real page from the running test server into jsdom and executes its real scripts,
// bridging fetch() to the server with the signed-in user's cookies (like a browser would).
const { JSDOM, VirtualConsole, ResourceLoader } = require('jsdom');
const crypto = require('crypto');

async function openPage(t, browser, path, { local = {} } = {}) {
  const res = await fetch(t.base + path, { headers: { cookie: browser.cookieHeader }, redirect: 'manual' });
  if (res.status !== 200) throw new Error(`GET ${path} -> ${res.status} ${res.headers.get('location') || ''}`);
  const html = await res.text();
  const errors = []; const navigations = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => { if (/Not implemented: navigation/.test(e.message)) navigations.push(e.message); else errors.push(e.stack || e.message); });
  vc.on('error', (...a) => errors.push(a.join(' ')));
  // Only load assets from the app under test; never reach out to third parties (e.g. embedded Facebook reels).
  class Loader extends ResourceLoader { fetch(url, o) { return url.startsWith(t.base) ? super.fetch(url, o) : Promise.resolve(Buffer.from('')); } }
  const dom = new JSDOM(html, { url: t.base + path, runScripts: 'dangerously', resources: new Loader(), pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(w) {
      for (const [k, v] of Object.entries(local)) w.localStorage.setItem(k, JSON.stringify(v));
      w.crypto = crypto.webcrypto; w.confirm = () => true; w.prompt = () => null; w.alert = () => {};
      w.URL.createObjectURL = () => 'blob:x';
      w.fetch = async (url, init = {}) => {
        const abs = new URL(url, t.base).toString();
        const headers = { ...(init.headers || {}), cookie: browser.cookieHeader };
        const r = await fetch(abs, { method: init.method || 'GET', headers, body: init.body, redirect: 'manual' });
        browser.store(r); return r;
      };
      w.addEventListener('error', (e) => errors.push(String(e.error?.stack || e.message)));
      w.addEventListener('unhandledrejection', (e) => errors.push('unhandledrejection: ' + String(e.reason?.stack || e.reason)));
    } });
  const w = dom.window;
  if (w.document.readyState !== 'complete') await new Promise((r) => w.addEventListener('load', r)); // like a browser: scripts are loaded before the user can interact
  const until = async (fn, ms = 4000) => { const end = Date.now() + ms; for (;;) { try { const v = fn(); if (v) return v; } catch { /* keep waiting */ } if (Date.now() > end) throw new Error('timed out waiting for page condition'); await new Promise((r) => setTimeout(r, 25)); } };
  const $ = (s) => w.document.querySelector(s); const $$ = (s) => [...w.document.querySelectorAll(s)];
  const click = (el) => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
  const type = (el, v) => { el.value = v; el.dispatchEvent(new w.Event('input', { bubbles: true })); el.dispatchEvent(new w.Event('change', { bubbles: true })); };
  const submit = (form) => form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  const text = () => w.document.body.textContent.replace(/\s+/g, ' ');
  return { w, dom, errors, navigations, until, $, $$, click, type, submit, text, close: () => setTimeout(() => { try { w.close(); } catch { /* already closed */ } }, 400) };
}
module.exports = { openPage };
