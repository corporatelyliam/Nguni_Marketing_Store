#!/usr/bin/env node
/* scripts/check.js: static checks over the whole project (no server or database needed).
 *   - no inline <script> blocks or on*="" handlers (the CSP would silently block them)
 *   - every local link / image / script / stylesheet in every HTML page exists
 *   - every public/*.js file parses
 *   - no server secret names or keys in anything served to the browser
 *   - every Api.* call in the frontend matches a route the server really registers
 *   - every server file parses
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const walk = (dir, filter, out = []) => {
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    if (f.name === 'node_modules') continue;
    const p = path.join(dir, f.name);
    if (f.isDirectory()) walk(p, filter, out); else if (filter(p)) out.push(p);
  }
  return out;
};
const rel = (p) => path.relative(ROOT, p);

function checkHtml(problems) {
  for (const file of walk(PUBLIC, (p) => p.endsWith('.html'))) {
    const src = fs.readFileSync(file, 'utf8');
    if (/<script(?![^>]*\bsrc=)[^>]*>/i.test(src)) problems.push(`${rel(file)}: inline <script> block (blocked by the CSP; move it to public/js)`);
    const handler = src.match(/\son[a-z]+\s*=\s*["']/i);
    if (handler) problems.push(`${rel(file)}: inline event handler "${handler[0].trim()}" (blocked by the CSP)`);
    for (const m of src.matchAll(/(?:href|src)="([^"#]+)(?:#[^"]*)?"/g)) {
      const t = m[1].split('?')[0];
      if (/^(https?:|mailto:|tel:|data:|javascript:)/.test(t)) { if (/^javascript:/.test(t)) problems.push(`${rel(file)}: javascript: URL`); continue; }
      const target = t.startsWith('/') ? path.join(PUBLIC, t) : path.join(path.dirname(file), t);
      if (!fs.existsSync(target) && !fs.existsSync(target + '.html')) problems.push(`${rel(file)}: broken link/asset -> ${t}`);
    }
  }
}

function checkJs(problems) {
  for (const file of [...walk(PUBLIC, (p) => p.endsWith('.js')), ...walk(path.join(ROOT, 'server'), (p) => p.endsWith('.js')), ...walk(path.join(ROOT, 'database'), (p) => p.endsWith('.js')), ...walk(path.join(ROOT, 'scripts'), (p) => p.endsWith('.js'))]) {
    const code = fs.readFileSync(file, 'utf8').replace(/^#!.*/, '');
    try { new vm.Script(`(function(exports, require, module, __filename, __dirname){${code}\n})`, { filename: file }); } catch (e) { problems.push(`${rel(file)}: syntax error: ${e.message}`); }
  }
}

function checkNoSecrets(problems) {
  const banned = [/SERVICE_ROLE/i, /SUPABASE_SERVICE/i, /\bsb_secret_/i, /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\./];
  for (const file of walk(PUBLIC, (p) => /\.(js|html|css|json|svg)$/.test(p))) {
    const src = fs.readFileSync(file, 'utf8');
    for (const re of banned) if (re.test(src)) problems.push(`${rel(file)}: looks like a server secret (${re})`);
  }
  if (!fs.existsSync(path.join(ROOT, '.env.example'))) problems.push('.env.example is missing');
  const gi = fs.existsSync(path.join(ROOT, '.gitignore')) ? fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8') : '';
  if (!/^\.env$/m.test(gi)) problems.push('.gitignore does not exclude .env');
}

// Build the table of routes the server registers by reading app.js mounts + each router file.
function serverRoutes() {
  const app = fs.readFileSync(path.join(ROOT, 'server/src/app.js'), 'utf8');
  const routes = [];
  for (const m of app.matchAll(/app\.use\('([^']+)',\s*require\('\.\/routes\/([^']+)'\)\)/g)) {
    const [, mount, file] = m;
    const src = fs.readFileSync(path.join(ROOT, 'server/src/routes', file + '.js'), 'utf8');
    for (const r of src.matchAll(/router\.(get|post|put|patch|delete)\(\s*'([^']*)'/g)) {
      routes.push({ method: r[1].toUpperCase(), path: (mount + (r[2] === '/' ? '' : r[2])).replace(/\/$/, '') });
    }
  }
  return routes;
}

function checkApiCalls(problems) {
  const routes = serverRoutes();
  // Segment-wise match: a dynamic segment in the frontend call (:p) matches any route segment,
  // and a :param in a route matches any call segment.
  const matches = (routePath, callPath) => {
    const rs = routePath.split('/'); const cs = callPath.split('/');
    return rs.length === cs.length && rs.every((seg, i) => seg === cs[i] || seg.startsWith(':') || cs[i] === ':p');
  };
  const verb = { get: 'GET', post: 'POST', patch: 'PATCH', put: 'PUT', del: 'DELETE', upload: 'POST' };
  let count = 0;
  for (const file of walk(PUBLIC, (p) => p.endsWith('.js'))) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/Api\.(get|post|patch|put|del|upload)\(\s*([`'"])((?:(?!\2).)*)\2/g)) {
      count += 1;
      let p = m[3].replace(/\$\{[^}]*\}/g, ':p').split('?')[0].replace(/'\s*\+\s*[^+']+(\s*\+\s*'[^']*')?/g, ':p');
      if (p.endsWith('/') && m[2] !== '`') p += ':p'; // 'prefix/' + id
      else if (p.endsWith('/')) p += ':p';
      const ok = routes.some((r) => r.method === verb[m[1]] && matches(r.path, p));
      if (!ok) problems.push(`${rel(file)}: ${verb[m[1]]} ${m[3]} has no matching server route`);
    }
  }
  return { routes: routes.length, calls: count };
}

function run() {
  const problems = [];
  checkHtml(problems); checkJs(problems); checkNoSecrets(problems);
  const stats = checkApiCalls(problems);
  return { problems, stats };
}

module.exports = { run, serverRoutes };

if (require.main === module) {
  const { problems, stats } = run();
  console.log(`Checked ${stats.calls} frontend API calls against ${stats.routes} server routes.`);
  if (problems.length) { console.error('\nProblems found:\n  - ' + problems.join('\n  - ')); process.exit(1); }
  console.log('All static checks passed.');
}
