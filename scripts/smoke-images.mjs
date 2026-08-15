// Smoke test: image validation, note composition, held buffer.
import { composeImageNote, extFor, HeldImageBuffer, mediaTypeOf, validateImage } from '../lib/images.js'

if (mediaTypeOf('image/jpeg; charset=utf-8', undefined) !== 'image/jpeg') throw new Error('contentType parsing')
if (mediaTypeOf(undefined, 'photo.JPG') !== 'image/jpeg') throw new Error('extension fallback')
if (mediaTypeOf(undefined, 'photo.png') !== 'image/png') throw new Error('png extension')
if (mediaTypeOf('application/pdf', 'x.pdf') !== undefined) throw new Error('pdf must be rejected')
if (extFor('image/jpeg') !== 'jpg') throw new Error('ext jpeg')
if (extFor('image/webp') !== 'webp') throw new Error('ext webp')

const ok = validateImage(new Uint8Array(100), 'image/png', undefined, 1024)
if (!ok.ok || ok.mediaType !== 'image/png') throw new Error('valid image rejected')
const big = validateImage(new Uint8Array(2000), 'image/png', undefined, 1024)
if (big.ok) throw new Error('oversized image accepted')

const note = composeImageNote([{ path: '/w/.dsh-fschannel-images/a.png', bytes: 1, mediaType: 'image/png' }])
if (!note.includes('/w/.dsh-fschannel-images/a.png')) throw new Error('path missing in note')
if (!note.includes('vision-tools') || !note.includes('vision_glance')) throw new Error('instruction missing')

const buffer = new HeldImageBuffer()
buffer.add('oc_a', { path: '/w/i1.png', bytes: 1, mediaType: 'image/png' })
buffer.add('oc_a', { path: '/w/i2.png', bytes: 1, mediaType: 'image/png' })
buffer.add('oc_b', { path: '/w/i3.png', bytes: 1, mediaType: 'image/png' })
if (buffer.list('oc_a').length !== 2) throw new Error('accumulate failed')
const taken = buffer.take('oc_a')
if (taken.length !== 2 || buffer.list('oc_a').length !== 0) throw new Error('take failed')
buffer.prune(0)
if (buffer.list('oc_b').length !== 1) throw new Error('prune disabled should keep')
buffer.prune(-1)
if (buffer.list('oc_b').length !== 1) throw new Error('negative ttl should keep')
console.log('IMAGES SMOKE OK')
