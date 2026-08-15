// Smoke test for the server-side locale dictionaries: zh/en key parity,
// placeholder parity, and the fallback behavior of dictFor().
import { zh, en, dictFor } from '../lib/locales.js'

const zhKeys = Object.keys(zh).sort()
const enKeys = Object.keys(en).sort()

// Key parity: every zh key must exist in en (en may omit keys, which fall
// back to zh — but a missing key means untranslated copy, so fail loudly).
const missingInEn = zhKeys.filter((key) => !(key in en))
if (missingInEn.length > 0) throw new Error('en missing keys: ' + missingInEn.join(', '))
const extraInEn = enKeys.filter((key) => !(key in zh))
if (extraInEn.length > 0) throw new Error('en has unknown keys: ' + extraInEn.join(', '))

// Placeholder parity: the same {name} placeholders in both languages.
const placeholders = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',')
for (const key of zhKeys) {
  const zhPh = placeholders(zh[key])
  const enPh = placeholders(en[key])
  if (zhPh !== enPh) throw new Error(`placeholder mismatch in "${key}": zh(${zhPh}) vs en(${enPh})`)
}

// dictFor: 'en' -> en, everything else -> zh (fallback semantics).
if (dictFor('en') !== en) throw new Error('dictFor(en) must return en')
if (dictFor('zh') !== zh) throw new Error('dictFor(zh) must return zh')
if (dictFor(undefined) !== zh) throw new Error('dictFor(undefined) must fall back to zh')
if (dictFor('fr') !== zh) throw new Error('dictFor(unknown) must fall back to zh')

// All zh values are non-empty strings (no accidental empty copy).
for (const key of zhKeys) {
  if (typeof zh[key] !== 'string' || zh[key] === '') throw new Error(`zh["${key}"] is empty`)
  if (typeof en[key] !== 'string' || en[key] === '') throw new Error(`en["${key}"] is empty`)
}

console.log(`LOCALES SMOKE OK (${zhKeys.length} keys, zh/en parity + placeholders verified)`)
