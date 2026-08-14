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
 * Resolve app credentials from entry config, falling back to an env file.
 * Recognized env keys: appid, secrect (project spelling), app_id, app_secret,
 * lark_app_id, lark_app_secret, feishu_app_id, feishu_app_secret.
 * @param {string | undefined} envFile - path to read; skipped when unreadable.
 * @param {{ appId?: string; appSecret?: string }} entry - direct config values.
 * @returns {{ appId: string; appSecret: string; fromEnvFile: boolean }}
 */
export function resolveCredentials(envFile, entry) {
  /** Read an environment variable by any of its aliases. */
  const pickEnv = (...keys) => {
    for (const key of keys) {
      const value = process.env[key]
      if (typeof value === 'string' && value !== '') return value.trim()
    }
    return ''
  }
  const direct = {
    appId: typeof entry.appId === 'string' ? entry.appId.trim() : '',
    appSecret: typeof entry.appSecret === 'string' ? entry.appSecret.trim() : '',
  }
  if (direct.appId !== '' && direct.appSecret !== '') {
    return { appId: direct.appId, appSecret: direct.appSecret, fromEnvFile: false }
  }
  // Environment first: dsh materializes the project/user .env files into
  // process.env at boot, so credentials work from any launch directory.
  const fromProcess = {
    appId: pickEnv('FEISHU_APP_ID', 'LARK_APP_ID', 'APP_ID'),
    appSecret: pickEnv('FEISHU_APP_SECRET', 'LARK_APP_SECRET', 'APP_SECRET'),
  }
  if (fromProcess.appId !== '' && fromProcess.appSecret !== '') {
    return { appId: fromProcess.appId, appSecret: fromProcess.appSecret, fromEnvFile: false }
  }
  /** @type {Record<string, string>} */
  let map = {}
  if (typeof envFile === 'string' && envFile !== '') {
    try {
      map = parseEnv(readFileSync(envFile, 'utf8'))
    } catch {
      map = {}
    }
  }
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
    fromEnvFile: true,
  }
}
