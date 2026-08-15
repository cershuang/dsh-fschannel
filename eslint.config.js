// Flat ESLint config. The point of this file is `no-undef`.
//
// A missing top-level import is a free variable: it parses fine, links fine,
// and only throws when the line that reads it executes. `node --check` cannot
// see it, an ESM link check cannot see it, and a smoke test only sees it if it
// happens to run that path. `no-undef` is whole-file scope analysis, so it is
// independent of which branches run — a free variable inside an HTTP route
// handler is caught exactly as well as one in the plugin's apply().
import globals from 'globals'

export default [
  {
    ignores: [
      'node_modules/**',
      // esbuild output and the copies smoke tests make of it.
      'lib/client.js',
      'lib/client.js.map',
      'lib/*.smoke.cjs',
      'lib/*.settings-smoke.cjs',
    ],
  },
  {
    // Host half and the offline test scripts: Node ESM.
    files: ['lib/**/*.js', 'scripts/**/*.mjs', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
    },
    rules: {
      'no-undef': 'error',
      // `catch {}` blocks and intentional throwaways are common here; only
      // flag genuinely unused declarations.
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
    },
  },
  {
    // Client half: browser globals, bundled by esbuild.
    files: ['src/client/**/*.jsx', 'src/client/**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
    },
  },
]
