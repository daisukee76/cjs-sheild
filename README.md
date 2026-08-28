# cjs-shield

CommonJS-first module loader for Node.js.

## Usage

```js
const requireSafe = require('./src');

const fs = requireSafe('node:fs');
const syncEsm = requireSafe('./some-esm/index.js');

// ESM with top-level await:
(async () => {
  const asyncEsm = await requireSafe.async('some-async-esm');
})();
```

## Why

Your application stays CommonJS:

```js
const thing = require('thing');
module.exports = thing;
```

The bridge does not transpile or rewrite the dependency. It asks Node.js to load it as-is.

Synchronous ESM works through Node's native `require(ESM)` support. ESM using top-level await cannot be made synchronous safely, so the bridge exposes an explicit async path.
