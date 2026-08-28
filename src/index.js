'use strict';

/**
 * cjs-shield
 *
 * CommonJS-first interoperability layer.
 *
 * Goals:
 *   - Keep application code in CommonJS.
 *   - Prefer native require().
 *   - Support synchronous ESM through require().
 *   - Bridge ESM-only packages through import().
 *   - Make default + named exports friendly to CommonJS consumers.
 */

const Module = require('node:module');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const nativeRequire = Module.createRequire(__filename);

const namespaceCache = new Map();
const valueCache = new Map();


// ============================================================
// UTILITIES
// ============================================================

function isPathSpecifier(specifier) {
  return (
    typeof specifier === 'string' &&
    (
      specifier.startsWith('./') ||
      specifier.startsWith('../') ||
      specifier.startsWith('/') ||
      specifier.startsWith('file:')
    )
  );
}


function toImportSpecifier(specifier, base = process.cwd()) {
  if (!isPathSpecifier(specifier)) {
    return specifier;
  }

  if (specifier.startsWith('file:')) {
    return specifier;
  }

  const parentURL = pathToFileURL(
    path.resolve(base) + path.sep
  );

  return new URL(specifier, parentURL).href;
}


function createError(code, message, cause) {
  const error = new Error(message);

  error.code = code;

  if (cause) {
    error.cause = cause;
  }

  return error;
}


// ============================================================
// ESM → COMMONJS INTEROP
// ============================================================

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}


/**
 * Convert an ESM namespace into a CJS-friendly value.
 *
 * Examples:
 *
 * ESM:
 *   export default chalk
 *
 * Result:
 *   chalk
 *
 *
 * ESM:
 *   export default foo
 *   export const bar = ...
 *
 * Result:
 *   foo.bar
 *   foo.default
 *
 *
 * ESM:
 *   export const foo = ...
 *   export const bar = ...
 *
 * Result:
 *   {
 *      foo,
 *      bar
 *   }
 */
function interop(namespace, options = {}) {
  const {
    mode = 'auto'
  } = options;

  if (
    !namespace ||
    typeof namespace !== 'object'
  ) {
    return namespace;
  }

  if (mode === 'namespace') {
    return namespace;
  }

  if (mode === 'default') {
    return hasOwn(namespace, 'default')
      ? namespace.default
      : namespace;
  }

  if (mode !== 'auto') {
    throw new TypeError(
      `Unknown interop mode "${mode}". ` +
      `Use "auto", "namespace", or "default".`
    );
  }

  const keys = Object.keys(namespace);

  // No default → plain namespace-style object
  if (!hasOwn(namespace, 'default')) {
    return namespace;
  }

  const defaultExport = namespace.default;

  // --------------------------------------------------------
  // IMPORTANT:
  // If default is an object/function, extend it with the
  // named exports.
  //
  // This is what makes packages such as Chalk behave nicely:
  //
  //   chalk.green(...)
  // --------------------------------------------------------

  if (
    typeof defaultExport === 'object' &&
    defaultExport !== null
  ) {
    for (const key of keys) {
      if (key === 'default') {
        continue;
      }

      if (!hasOwn(defaultExport, key)) {
        try {
          Object.defineProperty(
            defaultExport,
            key,
            {
              enumerable: true,
              configurable: true,
              get() {
                return namespace[key];
              }
            }
          );
        } catch {
          // Some ESM exports/default objects may be frozen.
        }
      }
    }

    return defaultExport;
  }

  // --------------------------------------------------------
  // Functions can also receive properties.
  //
  // Example:
  //
  //   export default function foo() {}
  //   export const bar = ...
  //
  // becomes:
  //
  //   foo()
  //   foo.bar
  // --------------------------------------------------------

  if (typeof defaultExport === 'function') {
    for (const key of keys) {
      if (key === 'default') {
        continue;
      }

      if (!hasOwn(defaultExport, key)) {
        try {
          Object.defineProperty(
            defaultExport,
            key,
            {
              enumerable: true,
              configurable: true,
              get() {
                return namespace[key];
              }
            }
          );
        } catch {
          // Ignore non-extensible functions.
        }
      }
    }

    return defaultExport;
  }

  // --------------------------------------------------------
  // Primitive default export.
  //
  // Can't attach properties to it, so return a CJS-style
  // wrapper object.
  // --------------------------------------------------------

  const result = {};

  for (const key of keys) {
    Object.defineProperty(
      result,
      key,
      {
        enumerable: true,
        configurable: false,
        get() {
          return namespace[key];
        }
      }
    );
  }

  Object.defineProperty(
    result,
    '__esModule',
    {
      enumerable: false,
      configurable: false,
      value: true
    }
  );

  return result;
}


// ============================================================
// RESOLUTION
// ============================================================

function resolve(specifier, base = process.cwd()) {
  const resolver = Module.createRequire(
    path.resolve(
      base,
      '__cjs_shield_resolver__.js'
    )
  );

  return resolver.resolve(specifier);
}


// ============================================================
// ESM LOADER
// ============================================================

function loadNamespace(specifier, options = {}) {
  const {
    base = process.cwd(),
    cache = true
  } = options;

  let importSpecifier = toImportSpecifier(
    specifier,
    base
  );

  try {
    const resolved = resolve(
      specifier,
      base
    );

    if (
      resolved &&
      !resolved.startsWith('node:')
    ) {
      importSpecifier =
        pathToFileURL(resolved).href;
    }
  } catch {
    // Let ESM resolver handle packages that cannot use
    // CommonJS resolution.
  }

  const cacheKey =
    `${base}\0${importSpecifier}`;

  if (cache && namespaceCache.has(cacheKey)) {
    return namespaceCache.get(cacheKey);
  }

  const promise = import(importSpecifier);

  if (cache) {
    namespaceCache.set(
      cacheKey,
      promise
    );

    promise.catch(() => {
      namespaceCache.delete(cacheKey);
    });
  }

  return promise;
}


async function loadESM(
  specifier,
  options = {}
) {
  const {
    mode = 'auto'
  } = options;

  const namespace =
    await loadNamespace(
      specifier,
      options
    );

  return interop(
    namespace,
    { mode }
  );
}


// ============================================================
// MAIN REQUIRE
// ============================================================

function requireSafe(
  specifier,
  options = {}
) {
  if (
    typeof specifier !== 'string' ||
    !specifier.trim()
  ) {
    throw new TypeError(
      'requireSafe(specifier): ' +
      'specifier must be a non-empty string'
    );
  }

  const {
    mode = 'auto'
  } = options;

  // --------------------------------------------------------
  // 1. Native CommonJS / synchronous ESM
  // --------------------------------------------------------

  try {
    const value =
      nativeRequire(specifier);

    /**
     * IMPORTANT:
     *
     * Node's require(ESM) returns a namespace object.
     *
     * Do NOT blindly unwrap every object with .default.
     * Instead, run the same interop layer.
     */

    if (
      value &&
      typeof value === 'object' &&
      hasOwn(value, 'default')
    ) {
      return interop(
        value,
        { mode }
      );
    }

    return value;
  } catch (error) {

    // ----------------------------------------------------
    // 2. Async ESM / TLA
    // ----------------------------------------------------

    if (
      error?.code ===
      'ERR_REQUIRE_ASYNC_MODULE'
    ) {
      throw createError(
        'ERR_CJS_SHIELD_ASYNC_ESM',
        [
          `Cannot synchronously load async ESM: ${specifier}`,
          'The module graph uses top-level await.',
          'Use: await requireSafe.async(specifier)'
        ].join('\n'),
        error
      );
    }

    // ----------------------------------------------------
    // 3. ESM-only package
    // ----------------------------------------------------

    if (
      error?.code ===
      'ERR_REQUIRE_ESM'
    ) {
      throw createError(
        'ERR_CJS_SHIELD_ESM_ASYNC',
        [
          `ESM-only package: ${specifier}`,
          'CommonJS remains unchanged.',
          'Use: await requireSafe.async(specifier)'
        ].join('\n'),
        error
      );
    }

    throw error;
  }
}


// ============================================================
// ASYNC API
// ============================================================

requireSafe.async = async function (
  specifier,
  options = {}
) {
  return loadESM(
    specifier,
    options
  );
};


// ============================================================
// EXPLICIT CONVERSION
// ============================================================

requireSafe.convert = async function (
  specifier,
  options = {}
) {
  const namespace =
    await loadNamespace(
      specifier,
      options
    );

  return interop(
    namespace,
    {
      mode: 'auto'
    }
  );
};


// ============================================================
// RESOLVE
// ============================================================

requireSafe.resolve = function (
  specifier,
  options = {}
) {
  const {
    base = process.cwd()
  } = options;

  return resolve(
    specifier,
    base
  );
};


// ============================================================
// NATIVE REQUIRE
// ============================================================

requireSafe.native =
  nativeRequire;


// ============================================================
// CACHE
// ============================================================

requireSafe.clearCache =
  function () {
    namespaceCache.clear();
    valueCache.clear();
  };


// ============================================================
// ERROR DETECTION
// ============================================================

requireSafe.isESMError =
  function (error) {
    return !!error && (
      error.code ===
      'ERR_REQUIRE_ESM' ||

      error.code ===
      'ERR_REQUIRE_ASYNC_MODULE' ||

      error.code ===
      'ERR_CJS_SHIELD_ESM_ASYNC' ||

      error.code ===
      'ERR_CJS_SHIELD_ASYNC_ESM'
    );
  };


// ============================================================
// VERSION
// ============================================================

requireSafe.version =
  '0.1.1';


// ============================================================
// EXPORT
// ============================================================

module.exports =
  requireSafe;