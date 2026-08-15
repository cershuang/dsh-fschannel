// @ts-check
/**
 * Feishu image holding: images are downloaded and staged per chat, then
 * delivered together with the NEXT text message as file paths plus a
 * recognition instruction (the vision tools are agent-scoped and accept
 * workspace paths). Pure logic only; transport calls stay in the plugin.
 * @module dsh-fschannel/images
 */

/**
 * Single source of truth for the image types this plugin handles: each media
 * type with the file extensions it may appear as, the first being the one used
 * on disk. The accepted set, {@link extFor}, {@link contentTypeFor} and the
 * staged-name pattern in the plugin are all derived from this — adding a fifth
 * type used to require four separate edits that could silently disagree.
 * @type {ReadonlyArray<{ mediaType: string, extensions: string[] }>}
 */
const IMAGE_TYPES = [
  { mediaType: 'image/png', extensions: ['png'] },
  { mediaType: 'image/jpeg', extensions: ['jpg', 'jpeg'] },
  { mediaType: 'image/webp', extensions: ['webp'] },
  { mediaType: 'image/gif', extensions: ['gif'] },
]

/** Media types the store accepts for images. */
export const ACCEPTED_IMAGE_TYPES = IMAGE_TYPES.map((entry) => entry.mediaType)

/** Every extension a staged file may carry, for the image route's validation. */
export const STAGED_EXTENSIONS = IMAGE_TYPES.flatMap((entry) => entry.extensions)

/**
 * Resolve the media type to declare for stored bytes.
 * @param {string | undefined} contentType - transport-reported type, possibly parameterized.
 * @param {string | undefined} fileName - the sender's file name.
 * @param {string[]} [accepted] - accepted media types.
 * @returns {string | undefined}
 */
export function mediaTypeOf(contentType, fileName, accepted = ACCEPTED_IMAGE_TYPES) {
  const declared = contentType?.split(';')[0]?.trim().toLowerCase()
  if (declared !== undefined && accepted.includes(declared)) return declared
  const extension = fileName?.toLowerCase().split('.').pop()
  const fromName = extension === 'jpg' || extension === 'jpeg'
    ? 'image/jpeg'
    : extension === undefined ? undefined : `image/${extension}`
  return fromName !== undefined && accepted.includes(fromName) ? fromName : undefined
}

/**
 * File extension for a media type.
 * @param {string} mediaType
 * @returns {string}
 */
export function extFor(mediaType) {
  const entry = IMAGE_TYPES.find((candidate) => candidate.mediaType === mediaType)
  return entry === undefined ? 'png' : entry.extensions[0]
}

/**
 * HTTP content type for a staged file name (derived from its extension).
 * The accepted set mirrors {@link ACCEPTED_IMAGE_TYPES}; unknown extensions
 * fall back to a generic binary type.
 * @param {string} name - staged file name.
 * @returns {string}
 */
export function contentTypeFor(name) {
  const ext = name.toLowerCase().split('.').pop()
  const entry = ext === undefined ? undefined : IMAGE_TYPES.find((candidate) => candidate.extensions.includes(ext))
  return entry === undefined ? 'application/octet-stream' : entry.mediaType
}

/**
 * Validate one downloaded image against type and size bounds.
 * @param {Uint8Array} buffer
 * @param {string | undefined} contentType
 * @param {string | undefined} fileName
 * @param {number} maxBytes
 * @returns {{ ok: true, mediaType: string } | { ok: false, reason: string }}
 */
export function validateImage(buffer, contentType, fileName, maxBytes) {
  const mediaType = mediaTypeOf(contentType, fileName)
  if (mediaType === undefined) {
    return { ok: false, reason: `unsupported image type (${contentType ?? fileName ?? 'unknown'})` }
  }
  if (buffer.byteLength > maxBytes) return { ok: false, reason: 'image exceeds size limit' }
  return { ok: true, mediaType }
}

/**
 * One held image file.
 * @typedef {{ path: string, name?: string, bytes: number, mediaType: string }} HeldImageFile
 */

/**
 * Strip the SDK's image-only markdown placeholder; an image-only message
 * leaves empty text (so it must not wake the agent).
 * @param {string | undefined} text
 * @returns {string}
 */
export function textWithoutImageMarkup(text) {
  return (text ?? '').replace(/!\[image\]\([^)]*\)/g, '').trim()
}


/**
 * The model-facing note appended to the user text: paths plus the
 * recognition instruction. The agent loads the vision-tools skill and runs
 * the visual tools itself, then answers combining results with the text.
 * @param {HeldImageFile[]} files
 * @param {{ imageNoteTitle: string, imageNoteIntro: string, imageNoteInstruction: string }} dict -
 *   locale copy; {n} in imageNoteIntro is replaced with the file count.
 * @returns {string}
 */
export function composeImageNote(files, dict) {
  const lines = files.map((file) => '  ' + file.path)
  const intro = dict.imageNoteIntro.replace('{n}', String(files.length))
  return [
    dict.imageNoteTitle,
    intro,
    ...lines,
    dict.imageNoteInstruction,
  ].join('\n')
}

/**
 * Per-chat held-image buffer. Images accumulate until the next text message
 * takes them; optional TTL prunes stale holdings.
 */
export class HeldImageBuffer {
  constructor() {
    /** @type {Map<string, { files: HeldImageFile[], receivedAt: number }>} */
    this.entries = new Map()
  }

  /**
   * @param {string} chatId
   * @returns {HeldImageFile[]} the current holdings (copy).
   */
  list(chatId) {
    return this.entries.get(chatId)?.files ?? []
  }

  /**
   * Add one image to a chat's holdings; replaces the receivedAt clock.
   * @param {string} chatId @param {HeldImageFile} file
   */
  add(chatId, file) {
    const entry = this.entries.get(chatId) ?? { files: [], receivedAt: 0 }
    entry.files.push(file)
    entry.receivedAt = Date.now()
    this.entries.set(chatId, entry)
  }

  /**
   * Take and clear a chat's holdings (returns the files).
   * @param {string} chatId
   * @returns {HeldImageFile[]}
   */
  take(chatId) {
    const entry = this.entries.get(chatId)
    if (entry === undefined) return []
    this.entries.delete(chatId)
    return entry.files
  }

  /** @param {string} chatId */
  clear(chatId) {
    this.entries.delete(chatId)
  }

  /**
   * Prune holdings older than ttlMs (0 disables).
   * @param {number} ttlMs
   * @returns {string[]} paths of the pruned image files — they never entered
   *   the durable index, so the caller should delete them (best effort).
   */
  prune(ttlMs) {
    if (ttlMs <= 0) return []
    const cutoff = Date.now() - ttlMs
    const pruned = []
    for (const [chatId, entry] of this.entries) {
      if (entry.receivedAt < cutoff) {
        this.entries.delete(chatId)
        pruned.push(...entry.files.map((file) => file.path))
      }
    }
    return pruned
  }
}
