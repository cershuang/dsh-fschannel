import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseEnv, resolveCredentials } from '../lib/env.js'

const path = fileURLToPath(new URL('../example.env', import.meta.url))
const map = parseEnv(readFileSync(path, 'utf8'))
console.log('parsed keys:', Object.keys(map).join(','))
const creds = resolveCredentials(path, {})
console.log('resolved appId:', creds.appId, '| secret:', creds.appSecret)
if (creds.appId !== 'cli_xxxxxxxxxxxxxxxxxxxx') throw new Error('example parse failed')
if (creds.appSecret !== 'your_app_secret_here') throw new Error('example secret failed')
console.log('EXAMPLE ENV OK')
