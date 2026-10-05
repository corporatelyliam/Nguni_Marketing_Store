const { test } = require('node:test');
const assert = require('node:assert/strict');
const check = require('../../../scripts/check');

test('project static checks: no inline scripts/handlers, no broken links, valid JS, no secrets in public/', () => {
  const { problems } = check.run();
  assert.deepEqual(problems, []);
});

test('every frontend API call maps to a real server route', () => {
  const { stats, problems } = check.run();
  assert.ok(stats.calls > 60 && stats.routes > 60, `${stats.calls} calls / ${stats.routes} routes`);
  assert.deepEqual(problems.filter((p) => /no matching server route/.test(p)), []);
});
