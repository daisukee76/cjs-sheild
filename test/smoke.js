const assert = require('node:assert/strict');
const path = require('node:path');
const requireSafe = require('../src');

const cjs = requireSafe(path.join(__dirname, 'cjs-fixture.cjs'));
assert.equal(cjs.value, 'cjs-ok');

const syncEsm = requireSafe(path.join(__dirname, 'fixtures/esm-sync/index.js'), { mode: 'namespace' });
assert.equal(syncEsm.answer, 42);

assert.throws(
  () => requireSafe(path.join(__dirname, 'fixtures/esm-tla/index.js')),
  error => error.code === 'ERR_CJS_SHIELD_ASYNC_ESM'
);

(async () => {
  const tla = await requireSafe.async('./fixtures/esm-tla/index.js', { mode: 'default', base: __dirname });
  assert.equal(tla.name, 'esm-tla');
  console.log('✅ cjs-shield smoke tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
