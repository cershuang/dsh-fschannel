// @ts-check
/**
 * Build the client bundle with esbuild into the factory-form CJS the dsh
 * client module loader expects (window.__ModuleLoader__.load({ id, factory })).
 * All external requires (react) stay inside the factory body so the loader's
 * own require resolves them at runtime.
 */
import { build, context } from 'esbuild'
import { fileURLToPath } from 'node:url'

const entry = fileURLToPath(new URL('../src/client/index.jsx', import.meta.url))
const outfile = fileURLToPath(new URL('../lib/client.js', import.meta.url))

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: [entry],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: ['es2020'],
  jsx: 'transform',
  jsxFactory: 'h',
  jsxFragment: 'Fragment',
  external: ['react'],
  outfile,
  sourcemap: true,
  // Do not inline the entry source into the map. It made the map a second
  // copy of src/client/index.jsx, and since `src` is no longer published the
  // package was carrying that source twice over. Line mappings survive; a
  // developer debugging locally still has the real file on disk.
  sourcesContent: false,
  logLevel: 'info',
}

const watching = process.argv.includes('--watch')
if (watching) {
  const ctx = await context(options)
  await ctx.watch()
  console.log('dsh-fschannel: watching client bundle (Ctrl+C to stop)')
} else {
  await build(options)
  console.log('dsh-fschannel: client bundle written to', outfile)
}
