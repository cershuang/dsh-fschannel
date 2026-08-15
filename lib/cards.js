// @ts-check
/**
 * Interactive model/effort settings card.
 *
 * When the user mentions adjusting the model or reasoning effort (or runs
 * /model), the bot publishes a Feishu interactive card showing the current
 * selection with compact buttons: one row for the model (from the catalog's
 * first provider group), one row for the reasoning effort. A click applies
 * the selection through the host apiProxy and the card updates in place.
 * @module dsh-fschannel/cards
 */

/** Card-action discriminator; only buttons this plugin placed are handled. */
export const MODEL_CARD_ACTION = 'dsh-fschannel/model'

/** Parsed card-button value for the model settings card. */
/** @typedef {{ kind: typeof MODEL_CARD_ACTION, sessionId: string, provider: string, model: string, effort?: string }} ModelCardValue */

/**
 * Natural-language trigger: the message mentions adjusting/viewing the model
 * or reasoning effort. Conservative on purpose — plain mentions of "模型"
 * inside ordinary work text do not trigger, only adjustment/view intent
 * around the keywords, or a bare short keyword message.
 */
export const MODEL_CARD_INTENT = /(调整|切换|换|改|设置|调一下|调成|看看|查看|查询|当前|什么|哪个|换到|换成|用)\s*(模型|model|推理|effort|思考强度)|(模型|model|推理|effort|思考强度)\s*(调整|切换|换成|改成|设置|调|看)/i

/**
 * Whether a bare short message is exactly a model/effort keyword.
 * @param {string} line - trimmed message text.
 * @returns {boolean}
 */
export function isBareKeyword(line) {
  return /^(模型|model|推理|effort|思考强度|推理等级|推理强度)$/i.test(line)
}

/**
 * Parse a card-button value into the model-card action, or undefined for
 * values this plugin did not place.
 * @param {unknown} value - the button's value object.
 * @returns {ModelCardValue | undefined}
 */
export function parseActionValue(value) {
  if (typeof value !== 'object' || value === null) return undefined
  const record = /** @type {Record<string, unknown>} */ (value)
  if (record.kind !== MODEL_CARD_ACTION) return undefined
  if (typeof record.sessionId !== 'string' || typeof record.provider !== 'string' || typeof record.model !== 'string') {
    return undefined
  }
  return {
    kind: MODEL_CARD_ACTION,
    sessionId: record.sessionId,
    provider: record.provider,
    model: record.model,
    ...(typeof record.effort === 'string' ? { effort: record.effort } : {}),
  }
}

/** One model entry as the catalog returns it. */
/** @typedef {{ id: string, name?: string, reasoning?: { efforts?: Array<{ id: string }>, defaultEffort?: string } }} CatalogModel */

/** One provider group as the catalog returns it. */
/** @typedef {{ id: string, name?: string, models?: CatalogModel[] }} CatalogGroup */

/** The session's current selection. */
/** @typedef {{ provider: string, model: string, reasoningEffort?: string }} CurrentSelection */

/**
 * Substitute {name} placeholders. Mirrors the plugin's fill(); duplicated here
 * so this module stays free of a dependency on the host half.
 * @param {string} template
 * @param {Record<string, string | number>} params
 * @returns {string}
 */
function fillCopy(template, params) {
  return template.replace(/\{(\w+)\}/g, (match, key) => key in params ? String(params[key]) : match)
}

/**
 * Compact button label for a model: the last id segment, capitalized
 * (deepseek-v4-flash → Flash). Falls back to the raw id.
 * @param {string} id - the model id.
 * @returns {string}
 */
function compactModelLabel(id) {
  const segment = id.split('-').pop()
  if (segment === undefined || segment === '') return id
  return segment.charAt(0).toUpperCase() + segment.slice(1)
}

/**
 * The effort ids a catalog advertises for one model, with the canonical
 * fallback used when the catalog is unavailable.
 * @param {CatalogModel | undefined} model
 * @returns {string[]}
 */
export function effortOptions(model) {
  const efforts = model?.reasoning?.efforts?.map((e) => e.id).filter((id) => typeof id === 'string')
  return efforts !== undefined && efforts.length > 0 ? efforts : ['off', 'high', 'max']
}

/**
 * Build the model settings card.
 * @param {object} input
 * @param {string} input.sessionId - bound session id (rides every button value).
 * @param {CurrentSelection} input.current - the current provider/model/effort.
 * @param {CatalogGroup[]} [input.groups] - catalog groups (first group feeds the model row).
 * @param {import('./locales.js').LocaleDict} input.dict - locale copy for the card chrome.
 * @returns {object} a Feishu card object for send({ card }) / updateCard.
 */
export function buildModelCard({ sessionId, current, groups, dict }) {
  const group = (groups ?? []).find((g) => g.models !== undefined && g.models.length > 0)
  const models = group?.models ?? []
  const currentModel = models.find((m) => m.id === current.model)
  const efforts = effortOptions(currentModel)
  const effortLabel = current.reasoningEffort === undefined ? dict.effortDefault : current.reasoningEffort

  /** @param {CatalogModel} model */
  const modelButton = (model) => ({
    tag: 'button',
    size: 'small',
    type: model.id === current.model ? 'primary' : 'default',
    text: { tag: 'plain_text', content: compactModelLabel(model.id) },
    value: {
      kind: MODEL_CARD_ACTION,
      sessionId,
      provider: current.provider,
      model: model.id,
    },
  })

  /** @param {string} effort */
  const effortButton = (effort) => ({
    tag: 'button',
    size: 'small',
    type: effort === (current.reasoningEffort ?? undefined) ? 'primary' : 'default',
    text: { tag: 'plain_text', content: effort.charAt(0).toUpperCase() + effort.slice(1) },
    value: {
      kind: MODEL_CARD_ACTION,
      sessionId,
      provider: current.provider,
      model: current.model,
      effort,
    },
  })

  return {
    config: { wide_screen_mode: true },
    header: { template: 'blue', title: { tag: 'plain_text', content: dict.cardTitle } },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: fillCopy(dict.cardCurrent, {
            model: `${current.provider}/${current.model}`,
            effort: effortLabel,
          }),
        },
      },
      {
        tag: 'action',
        actions: models.slice(0, 4).map(modelButton),
      },
      {
        tag: 'action',
        actions: efforts.slice(0, 5).map(effortButton),
      },
      { tag: 'note', elements: [{ tag: 'plain_text', content: dict.cardHint }] },
    ],
  }
}
