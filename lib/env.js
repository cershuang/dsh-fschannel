// @ts-check
/**
 * Minimal .env reader for the plugin's credential file. Supports both
 * `KEY=VALUE` and `KEY VALUE` line forms (the project .env uses the latter
 * with the historical `appid` / `secrect` spellings). Comments and blank
 * lines are skipped; values keep their raw form (no quote processing beyond
 * stripping a matching pair of surrounding quotes).
 * @module dsh-fschannel/env
 */

import { readFileSync } from 'node:fs'

/**
 * Parse a .env text into a lower-cased key map.
 * @param {string} text - the raw file content.
 * @returns {Record<string, string>} keys lower-cased, values trimmed.
 */
export function parseEnv(text) {
  /** @type {Record<string, string>} */
  const out = {}
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const match = /^([A-Za-z][A-Za-z0-9_.-]*)\s*(?:=|\s)\s*(.*)$/.exec(line)
    if (match === null) continue
    let value = match[2].trim()
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1)
    }
    out[match[1].toLowerCase()] = value
  }
  return out
}

/**
 * Read an env file into a key map; unreadable files yield an empty map.
 * @param {string | undefined} envFile - path to read.
 * @returns {Record<string, string>} lower-cased key map.
 */
export function readEnvMap(envFile) {
  if (typeof envFile !== 'string' || envFile === '') return {}
  try {
    return parseEnv(readFileSync(envFile, 'utf8'))
  } catch {
    return {}
  }
}

/**
 * Mask a credential for display: first 6 chars, ellipsis, last 4 chars.
 * @param {string | undefined} value
 * @returns {string} masked form, or '' when the value is empty.
 */
export function maskSecret(value) {
  if (typeof value !== 'string' || value === '') return ''
  if (value.length <= 8) return '••••••'
  return value.slice(0, 6) + '…' + value.slice(-4)
}

/**
 * Resolve app credentials through the layered credential service.
 * Precedence: entry config > credential service (process env > dsh
 * credential store > project/user .env layers) > the plugin's own env file.
 * Recognized credential refs: FEISHU_APP_ID/LARK_APP_ID/APP_ID and
 * FEISHU_APP_SECRET/LARK_APP_SECRET/APP_SECRET; env-file keys additionally
 * accept the historical appid / secrect spellings.
 * @param {string | undefined} envFile - fallback file to read; skipped when unreadable.
 * @param {{ appId?: string; appSecret?: string }} entry - direct config values.
 * @param {(name: string) => Promise<string | undefined>} storeResolver - layered
 *   credential resolver; receives a ref name and returns its value or undefined.
 * @returns {Promise<{ appId: string; appSecret: string; source: string }>}
 *   source is 'entry' | 'credentials' | 'envFile' ('' when nothing resolved).
 */
export async function resolveCredentials(envFile, entry, storeResolver) {
  const direct = {
    appId: typeof entry.appId === 'string' ? entry.appId.trim() : '',
    appSecret: typeof entry.appSecret === 'string' ? entry.appSecret.trim() : '',
  }
  if (direct.appId !== '' && direct.appSecret !== '') {
    return { appId: direct.appId, appSecret: direct.appSecret, source: 'entry' }
  }
  /** Pick the first non-empty value among credential refs. */
  const storePick = async (...keys) => {
    for (const key of keys) {
      const value = await storeResolver(key)
      if (typeof value === 'string' && value !== '') return value.trim()
    }
    return ''
  }
  const fromStore = {
    appId: await storePick('FEISHU_APP_ID', 'LARK_APP_ID', 'APP_ID'),
    appSecret: await storePick('FEISHU_APP_SECRET', 'LARK_APP_SECRET', 'APP_SECRET'),
  }
  if (fromStore.appId !== '' && fromStore.appSecret !== '') {
    return { appId: fromStore.appId, appSecret: fromStore.appSecret, source: 'credentials' }
  }
  const map = readEnvMap(envFile)
  const pick = (...keys) => {
    for (const key of keys) {
      const value = map[key]
      if (typeof value === 'string' && value !== '') return value
    }
    return ''
  }
  return {
    appId: direct.appId !== '' ? direct.appId : pick('appid', 'app_id', 'lark_app_id', 'feishu_app_id'),
    appSecret: direct.appSecret !== '' ? direct.appSecret : pick('secrect', 'app_secret', 'lark_app_secret', 'feishu_app_secret'),
    source: direct.appId !== '' || direct.appSecret !== '' ? 'entry' : 'envFile',
  }
}
