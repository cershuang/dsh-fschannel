// Offline test runner for `npm test`.
//
// Every script listed here must pass without network access, without a running
// dsh, and without credentials — so it works on a fresh clone and in CI. The
// scripts that need a live Feishu app (integration-test.mjs) or a real
// ~/.dsh/sessions tree (audit-sessions.mjs) are deliberately excluded; run
// those by hand.
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const SUITES = [
  'smoke-errors.mjs',
  'smoke-env-example.mjs',
  'smoke-test.mjs',
  'smoke-bindings-concurrency.mjs',
  'smoke-locales.mjs',
  'smoke-cards.mjs',
  'smoke-render.mjs',
  'smoke-stream.mjs',
  'smoke-images.mjs',
  'smoke-repair.mjs',
  // These two require() the built bundle, so `npm run build` must have run.
  'smoke-client.mjs',
  'smoke-settings-render.mjs',
]

// A suite that hangs must fail, not stall the run forever. Without this a
// leaked timer — an uncleared setInterval in a component test, say — keeps the
// child alive and `npm test` never returns.
const SUITE_TIMEOUT_MS = 60_000

const failures = []
for (const suite of SUITES) {
  const path = fileURLToPath(new URL(suite, import.meta.url))
  const result = spawnSync(process.execPath, [path], {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    timeout: SUITE_TIMEOUT_MS,
    killSignal: 'SIGKILL',
  })
  const timedOut = result.error !== undefined && /** @type {{ code?: string }} */ (result.error).code === 'ETIMEDOUT'
  const ok = !timedOut && result.status === 0
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${suite}${timedOut ? ` (timed out after ${SUITE_TIMEOUT_MS / 1000}s)` : ''}\n`)
  if (!ok) {
    failures.push(suite)
    const detail = ((result.stdout ?? '') + (result.stderr ?? '')).trimEnd()
    if (detail !== '') process.stdout.write(detail.split('\n').map((line) => '      ' + line).join('\n') + '\n')
  }
}

if (failures.length > 0) {
  process.stdout.write(`\n${failures.length} of ${SUITES.length} suites failed: ${failures.join(', ')}\n`)
  process.exit(1)
}
process.stdout.write(`\nall ${SUITES.length} suites passed\n`)
