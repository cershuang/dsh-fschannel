import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseEnv, resolveCredentials } from '../lib/env.js'

const path = fileURLToPath(new URL('../example.env', import.meta.url))
const map = parseEnv(readFileSync(path, 'utf8'))
console.log('parsed keys:', Object.keys(map).join(','))
const creds = await resolveCredentials(path, {}, async () => undefined)
console.log('resolved appId:', JSON.stringify(creds.appId), '| secret:', JSON.stringify(creds.appSecret), '| source:', creds.source)
if (creds.appId !== '' || creds.appSecret !== '') throw new Error('example.env must not carry credentials')
if (map.fschannel_repo !== '/path/to/dsh-fschannel') throw new Error('path keys missing')
console.log('EXAMPLE ENV OK')
