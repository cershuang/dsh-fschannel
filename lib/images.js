// @ts-check
/**
 * Feishu image holding: images are downloaded and staged per chat, then
 * delivered together with the NEXT text message as file paths plus a
 * recognition instruction (the vision tools are agent-scoped and accept
 * workspace paths). Pure logic only; transport calls stay in the plugin.
 * @module dsh-fschannel/images
 */

/** Media types the store accepts for images. */
export const ACCEPTED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

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
  if (mediaType === 'image/jpeg') return 'jpg'
  const subtype = mediaType.split('/')[1]
  return subtype === undefined || subtype === '' ? 'png' : subtype
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
 * The model-facing note appended to the user text: paths plus the
 * recognition instruction. The agent loads the vision-tools skill and runs
 * the visual tools itself, then answers combining results with the text.
 * @param {HeldImageFile[]} files
 * @returns {string}
 */
export function composeImageNote(files) {
  const lines = files.map((file) => '  ' + file.path)
  return [
    '—— 飞书图片附件 ——',
    `用户通过飞书发送了 ${files.length} 张图片，已保存为：`,
    ...lines,
    '请先通过 skill 工具加载 vision-tools 技能（若尚未加载），然后使用视觉识别工具（如 vision_glance、vision_ocr 等）逐一查看这些图片文件；',
    '结合识别结果与上面的文字信息，给出完整回答。若视觉工具不可用，请明确说明你无法查看图片。',
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
   */
  prune(ttlMs) {
    if (ttlMs <= 0) return
    const cutoff = Date.now() - ttlMs
    for (const [chatId, entry] of this.entries) {
      if (entry.receivedAt < cutoff) this.entries.delete(chatId)
    }
  }
}
