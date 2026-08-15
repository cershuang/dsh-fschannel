/**
 * dsh-fschannel — browser half.
 *
 * Renders the Feishu surfaces in the Web GUI:
 *   - a session-header chip to connect/disconnect the current session
 *   - a General-settings row with bot status, binding list, and the
 *     "auto-connect new sessions" preference
 *
 * All state rides the host's loopback HTTP API (/feishu/*), so this half has
 * no transport of its own. The bundle is the factory-form CJS the client
 * module loader expects (window.__ModuleLoader__.load).
 */

window.__ModuleLoader__.load({
  id: 'dsh-fschannel',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    const React = require('react')
    const { useState, useEffect, useCallback } = React
    const h = React.createElement
    const Fragment = React.Fragment

// ── locale ────────────────────────────────────────────────────────────────

const zh = {
  seatUnbound: '连接飞书',
  seatPending: '待绑定',
  seatPendingHint: '给飞书机器人发一条消息即可完成绑定（点此取消）',
  seatBound: '已连接',
  seatBoundHint: '此会话已连接到飞书聊天：{chat}（点此断开）',
  seatLoading: '…',
  confirmUnbind: '断开此会话与飞书的连接？',
  nav: '飞书机器人',
  sectionStatus: '状态',
  sectionPreference: '偏好设置',
  sectionBindings: '绑定管理',
  sectionHelp: '飞书侧命令与反馈',
  quickAction: '快捷操作',
  rowOutputLabel: '输出方式',
  sectionHelpText: '/model — 查询/弹出模型卡片 · /model list · /model use <provider>/<model> · /model effort <off|high|max> · /status · /stop · /help\n收到消息自动加 👍，回合完成变 ✅，失败变 ☹️；回复以流式卡片呈现，结束时保留最终结果。',
  rowTitle: '飞书机器人',
  rowDescConnected: '机器人已连接 · 绑定 {bound} 个会话 · 待绑定 {pending} 个',
  rowDescDisconnected: '机器人未连接：{reason}',
  rowDescConnecting: '机器人连接中…',
  rowDescUnconfigured: '未配置凭据（appId/appSecret）',
  rowAutoBind: '新会话默认连接飞书',
  rowCreateSession: '新建会话并连接飞书',
  rowCreateSessionHint: '立即新建一个会话并进入待绑定状态（在飞书发一条消息完成绑定；60 秒内未创建会话将自动取消）',
  pendingTitle: '待绑定会话（给机器人发一条消息完成绑定）',
  pendingDelete: '取消待绑定',
  pendingBadge: '待绑定',
  pendingTimePrefix: '创建于 ',
  pendingJustNow: '刚刚',
  pendingTime: '{n} 分钟前',
  pendingTimeHours: '{n} 小时前',
  rowOutput: '输出方式：{mode}',
  outputStream: '流式卡片',
  outputPlain: '普通消息',
  rowRefresh: '刷新',
  rowBindingsTitle: '绑定列表',
  rowNoBindings: '还没有绑定任何会话',
  detach: '断开',
  chatUnknown: '未知聊天',
  sessionShort: '会话',
  // bindings table
  thChatId: '聊天 ocID',
  thSession: '会话',
  thName: '会话名称（DSH）',
  thAction: '操作',
  // credentials block
  credTitle: '连接凭据',
  credAppId: 'App ID',
  credAppSecret: 'App Secret',
  credSave: '保存',
  credSaving: '保存中…',
  credUnchanged: '留空则不修改',
  credSourceFile: '凭据库',
  credSourceEnv: '环境变量（只读）',
  credSourceDotenv: '.env',
  credSourceEntry: '入口配置',
  credUnconfigured: '未配置',
  credReadonly: '由启动环境提供，只读',
  credResultOk: '设置已保存，立即生效',
  credResultFail: '保存失败：{error}',
  credMaskedHint: '仅显示首尾，完整值不回显',
  // staging preferences
  sectionStaging: '图片暂存',
  holdTtlLabel: '暂存过期时间（秒，0 = 不过期）',
  maxHeldImagesLabel: '每聊天暂存图片上限（张）',
  maxHeldImageBytesLabel: '单张图片大小上限（MB）',
  showImagesLabel: '会话内显示图片',
  // image node
  imgNodeMissing: '图片文件已不存在',
  imgOpen: '点击打开原图',
  // gallery
  galleryOpen: '飞书图片',
  galleryTitle: '飞书图片（{n}）',
  galleryEmpty: '此会话暂无飞书图片',
  galleryLoading: '加载中…',
  galleryClose: '关闭',
}

const en = {
  seatUnbound: 'Connect Feishu',
  seatPending: 'Awaiting bind',
  seatPendingHint: 'Send the bot a message in Feishu to finish binding (click to cancel)',
  seatBound: 'Connected',
  seatBoundHint: 'This session is connected to Feishu chat: {chat} (click to disconnect)',
  seatLoading: '…',
  confirmUnbind: 'Disconnect this session from Feishu?',
  nav: 'Feishu Bot',
  sectionStatus: 'Status',
  sectionPreference: 'Preferences',
  sectionBindings: 'Bindings',
  sectionHelp: 'Feishu commands & feedback',
  quickAction: 'Quick actions',
  rowOutputLabel: 'Output',
  sectionHelpText: '/model — show/model card · /model list · /model use <provider>/<model> · /model effort <off|high|max> · /status · /stop · /help\nInbound messages get a 👍 reaction, ✅ on completion, ☹️ on failure; replies stream into a card that keeps the final result.',
  rowTitle: 'Feishu bot',
  rowDescConnected: 'Bot connected · {bound} sessions bound · {pending} pending',
  rowDescDisconnected: 'Bot offline: {reason}',
  rowDescConnecting: 'Bot connecting…',
  rowDescUnconfigured: 'Credentials not configured (appId/appSecret)',
  rowAutoBind: 'Auto-connect new sessions to Feishu',
  rowCreateSession: 'New session and connect to Feishu',
  rowCreateSessionHint: 'Create a session right away and mark it pending (send the bot a message in Feishu to bind; auto-cancelled when no session appears within 60s)',
  pendingTitle: 'Pending sessions (send the bot a message to bind)',
  pendingDelete: 'Cancel',
  pendingBadge: 'pending',
  pendingTimePrefix: 'created ',
  pendingJustNow: 'just now',
  pendingTime: '{n} min ago',
  pendingTimeHours: '{n} h ago',
  rowOutput: 'Output: {mode}',
  outputStream: 'streaming cards',
  outputPlain: 'plain messages',
  rowRefresh: 'Refresh',
  rowBindingsTitle: 'Bindings',
  rowNoBindings: 'No sessions bound yet',
  detach: 'Detach',
  chatUnknown: 'unknown chat',
  sessionShort: 'Session',
  // bindings table
  thChatId: 'Chat ocID',
  thSession: 'Session',
  thName: 'Session title (DSH)',
  thAction: 'Action',
  // credentials block
  credTitle: 'Credentials',
  credAppId: 'App ID',
  credAppSecret: 'App Secret',
  credSave: 'Save',
  credSaving: 'Saving…',
  credUnchanged: 'leave blank to keep',
  credSourceFile: 'credential store',
  credSourceEnv: 'environment (read-only)',
  credSourceDotenv: '.env',
  credSourceEntry: 'entry config',
  credUnconfigured: 'not configured',
  credReadonly: 'supplied by the launch environment, read-only',
  credResultOk: 'Settings saved and applied',
  credResultFail: 'Save failed: {error}',
  credMaskedHint: 'head/tail only; full value never echoed',
  // staging preferences
  sectionStaging: 'Image staging',
  holdTtlLabel: 'Staging expiry (seconds, 0 = never)',
  maxHeldImagesLabel: 'Max held images per chat',
  maxHeldImageBytesLabel: 'Max image size (MB)',
  showImagesLabel: 'Show images in session',
  // image node
  imgNodeMissing: 'image file no longer exists',
  imgOpen: 'click to open original',
  // gallery
  galleryOpen: 'Feishu images',
  galleryTitle: 'Feishu images ({n})',
  galleryEmpty: 'No Feishu images in this session',
  galleryLoading: 'Loading…',
  galleryClose: 'Close',
}

const NS = 'feishu'

// ── shared helpers ────────────────────────────────────────────────────────

/** @returns {Promise<object>} parsed JSON from /feishu/<path>. */
async function api(path, options) {
  const res = await fetch('/feishu/' + path, {
    cache: 'no-store',
    headers: options && options.body !== undefined ? { 'content-type': 'application/json' } : undefined,
    ...options,
  })
  return res.json().catch(() => ({ ok: false }))
}

const chipStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  height: 26,
  padding: '0 10px',
  borderRadius: 999,
  border: '1px solid var(--dsw-alias-border-l2, #444)',
  background: 'transparent',
  color: 'var(--dsw-alias-label-secondary, #bbb)',
  cursor: 'pointer',
  fontSize: 12,
  lineHeight: '26px',
  whiteSpace: 'nowrap',
}

const dotStyle = (color) => ({
  width: 8,
  height: 8,
  borderRadius: '50%',
  background: color,
  display: 'inline-block',
  flex: 'none',
})

// ── session header seat ───────────────────────────────────────────────────

function FeishuSeat({ sessionId, t }) {
  const [phase, setPhase] = useState('loading') // loading | unbound | pending | bound
  const [record, setRecord] = useState(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    const data = await api('status')
    if (!data.ok) {
      setPhase('unbound')
      setRecord(null)
      return
    }
    const found = (data.bindings || []).find((entry) => entry.sessionId === sessionId)
    if (found !== undefined) {
      setRecord(found)
      setPhase('bound')
    } else if ((data.pending || []).some((entry) => entry.sessionId === sessionId)) {
      setPhase('pending')
      setRecord(null)
    } else {
      setPhase('unbound')
      setRecord(null)
    }
  }, [sessionId])

  useEffect(() => { void refresh() }, [refresh])

  const act = useCallback(async (path, payload) => {
    setBusy(true)
    try {
      await api(path, { method: 'POST', body: JSON.stringify(payload) })
      await refresh()
    } finally {
      setBusy(false)
    }
  }, [refresh])

  const onClick = () => {
    if (busy) return
    if (phase === 'unbound') void act('bind', { sessionId })
    else if (phase === 'pending') void act('unbind', { sessionId })
    else if (phase === 'bound') {
      if (window.confirm(t('confirmUnbind'))) void act('unbind', { sessionId })
    }
  }

  let label = t('seatLoading')
  let title = undefined
  let color = undefined
  if (phase === 'unbound') {
    label = t('seatUnbound')
    color = '#8a8f98'
  } else if (phase === 'pending') {
    label = t('seatPending')
    title = t('seatPendingHint')
    color = '#e5b65c'
  } else if (phase === 'bound') {
    label = t('seatBound')
    title = t('seatBoundHint').replace('{chat}', record && (record.chatName || record.chatId) || '?')
    color = '#4caf7d'
  }

  return h('button', {
    style: { ...chipStyle, opacity: busy ? 0.6 : 1 },
    title,
    onClick,
    'data-testid': 'feishu-seat',
  }, h('span', { style: dotStyle(color) }), label)
}

// ── settings section (dedicated tab) ─────────────────────────────────────

function FeishuSection({ t, createSession, sessionTitles }) {
  const [status, setStatus] = useState(null)
  const [cfg, setCfg] = useState(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(null) // { ok, text } | null
  const [appId, setAppId] = useState('')
  const [appSecret, setAppSecret] = useState('')
  const [holdTtl, setHoldTtl] = useState('')
  const [maxCount, setMaxCount] = useState('')
  const [maxMb, setMaxMb] = useState('')
  // DSH-side session titles, refreshed whenever the section re-renders.
  const titles = typeof sessionTitles === 'function' ? sessionTitles() : (sessionTitles || {})

  const refresh = useCallback(async () => {
    const [s, c] = await Promise.all([api('status'), api('config')])
    setStatus(s.ok ? s : null)
    if (c.ok) {
      setCfg(c)
      setHoldTtl(String(c.holdTtlSeconds ?? 0))
      setMaxCount(String(c.maxHeldImages ?? 10))
      setMaxMb(String(c.maxHeldImageBytes ?? 10))
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const saveConfig = async (patch) => {
    setBusy(true)
    setMsg(null)
    try {
      const res = await api('config', { method: 'POST', body: JSON.stringify(patch) })
      if (res.ok) {
        setMsg({ ok: true, text: t('credResultOk') })
        await refresh()
      } else {
        setMsg({ ok: false, text: t('credResultFail').replace('{error}', res.error || '?') })
      }
    } catch {
      setMsg({ ok: false, text: t('credResultFail').replace('{error}', 'network') })
    } finally {
      setBusy(false)
    }
  }

  const toggleAuto = async (value) => {
    const res = await api('config', { method: 'POST', body: JSON.stringify({ autoBindNewSession: value }) })
    if (res.ok) await refresh()
  }

  const saveCredentials = async () => {
    const patch = {}
    if (appId.trim() !== '') patch.appId = appId.trim()
    if (appSecret.trim() !== '') patch.appSecret = appSecret.trim()
    if (Object.keys(patch).length === 0) return
    await saveConfig(patch)
    setAppId('')
    setAppSecret('')
  }

  const saveHoldTtl = () => { if (holdTtl.trim() !== '') void saveConfig({ holdTtlSeconds: Number(holdTtl) }) }
  const saveMaxCount = () => { if (maxCount.trim() !== '') void saveConfig({ maxHeldImages: Number(maxCount) }) }
  const saveMaxMb = () => { if (maxMb.trim() !== '') void saveConfig({ maxHeldImageBytes: Number(maxMb) }) }

  const detach = async (sessionId) => {
    setBusy(true)
    try {
      await api('unbind', { method: 'POST', body: JSON.stringify({ sessionId }) })
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  const createAndConnect = async () => {
    if (busy || typeof createSession !== 'function') return
    setBusy(true)
    try {
      await createSession()
    } finally {
      setBusy(false)
    }
  }

  let desc = t('rowDescUnconfigured')
  if (status !== null) {
    if (status.connected) {
      desc = t('rowDescConnected')
        .replace('{bound}', String(status.bindings ? status.bindings.length : 0))
        .replace('{pending}', String(status.pending ? status.pending.length : 0))
    } else {
      desc = t('rowDescDisconnected').replace('{reason}', status.reason || '?')
    }
  }

  const pageStyle = { maxWidth: 720, padding: '2px 0', display: 'flex', flexDirection: 'column', gap: 16 }
  const cardStyle = {
    background: 'var(--dsw-alias-bg-l2, #1a1a1c)',
    border: '1px solid var(--dsw-alias-border-l2, #333)',
    borderRadius: 10,
    padding: '14px 16px',
  }
  const blockTitleStyle = { fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-label-primary, #eee)', marginBottom: 10 }
  const cardHeadStyle = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }
  const lineStyle = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 16,
    padding: '9px 0',
    borderBottom: '1px solid var(--dsw-alias-border-l2, #2a2a2a)',
    fontSize: 13,
  }
  const labelStyle = { color: 'var(--dsw-alias-label-secondary, #bbb)', minWidth: 0 }
  const valueStyle = { color: 'var(--dsw-alias-label-primary, #eee)', minWidth: 0, textAlign: 'right' }
  const inputStyle = {
    background: 'var(--dsw-alias-bg-l1, #141416)',
    border: '1px solid var(--dsw-alias-border-l2, #444)',
    borderRadius: 6,
    color: 'var(--dsw-alias-label-primary, #eee)',
    padding: '5px 9px',
    fontSize: 12,
    width: 220,
    height: 30,
    boxSizing: 'border-box',
  }
  const numInputStyle = { ...inputStyle, width: 92 }
  const segStyle = {
    border: '1px solid var(--dsw-alias-border-l2, #444)',
    borderRadius: 6,
    padding: '5px 12px',
    fontSize: 12,
    cursor: 'pointer',
    background: 'transparent',
  }
  const primaryButtonStyle = {
    background: 'var(--dsw-alias-state-business-primary, #6b9bff)',
    border: 'none',
    borderRadius: 6,
    color: '#fff',
    cursor: 'pointer',
    padding: '6px 16px',
    fontSize: 12,
    fontWeight: 600,
    height: 30,
  }
  const msgStyle = (ok) => ({ fontSize: 12, color: ok ? '#4caf7d' : '#e06c6c', alignItems: 'center' })
  // Bindings table.
  const tableGridCols = 'minmax(120px, 1.1fr) minmax(150px, 1.3fr) minmax(140px, 1.8fr) 64px'
  const tableHeadStyle = {
    display: 'grid',
    gridTemplateColumns: tableGridCols,
    gap: 10,
    padding: '5px 0',
    borderBottom: '1px solid var(--dsw-alias-border-l2, #333)',
    color: 'var(--dsw-alias-label-tertiary, #999)',
    fontSize: 11,
    fontWeight: 600,
  }
  const tableRowStyle = {
    display: 'grid',
    gridTemplateColumns: tableGridCols,
    gap: 10,
    alignItems: 'center',
    padding: '8px 0',
    borderBottom: '1px solid var(--dsw-alias-border-l2, #2a2a2a)',
    fontSize: 12.5,
  }
  const cellMonoStyle = {
    fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
    fontSize: 11.5,
    color: 'var(--dsw-alias-label-secondary, #bbb)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  }
  const cellNameStyle = {
    color: 'var(--dsw-alias-label-primary, #eee)',
    wordBreak: 'break-word',
    minWidth: 0,
  }
  const cellNameFallbackStyle = {
    ...cellNameStyle,
    color: 'var(--dsw-alias-label-tertiary, #999)',
    fontStyle: 'italic',
  }
  const actionCellStyle = { textAlign: 'right' }
  const pendingBadgeStyle = {
    background: 'rgba(229, 182, 92, 0.14)',
    color: '#e5b65c',
    borderRadius: 999,
    padding: '2px 9px',
    fontSize: 11,
    whiteSpace: 'nowrap',
    justifySelf: 'start',
  }

  // Credential source labels; never exposes the secret itself.
  const effectiveSource = status !== null ? status.credentialSource : undefined
  const credSourceOf = (info) => {
    if (effectiveSource === 'entry') return t('credSourceEntry')
    if (info && info.configured) {
      if (info.source === 'env') return t('credSourceEnv')
      if (info.source === 'file') return t('credSourceFile')
      if (info.source === 'project-env' || info.source === 'user-env') return t('credSourceDotenv')
    }
    return t('credUnconfigured')
  }
  const credInfo = cfg !== null && cfg.credentials !== undefined ? cfg.credentials : null
  const appIdInfo = credInfo !== null ? credInfo.appId : null
  const secretInfo = credInfo !== null ? credInfo.appSecret : null
  const readonlyNote = (info) => (info && info.writable === false ? '（' + t('credReadonly') + '）' : '')
  const sourceLine = t('credAppId') + ': ' + credSourceOf(appIdInfo) + readonlyNote(appIdInfo)
    + ' · ' + t('credAppSecret') + ': ' + credSourceOf(secretInfo) + readonlyNote(secretInfo)

  const outputButton = (mode, label) => h('button', {
    key: mode,
    style: {
      ...segStyle,
      background: cfg !== null && cfg.output === mode ? 'var(--dsw-alias-state-business-primary, #6b9bff)' : 'transparent',
      color: cfg !== null && cfg.output === mode ? '#fff' : 'var(--dsw-alias-label-secondary, #bbb)',
      ...(cfg !== null && cfg.output === mode ? { borderColor: 'var(--dsw-alias-state-business-primary, #6b9bff)' } : {}),
    },
    disabled: busy || cfg === null,
    onClick: () => { if (cfg !== null && cfg.output !== mode) void saveConfig({ output: mode }) },
  }, label)

  const numberRow = (label, value, onChange, onSave, min) =>
    h('div', { key: label, style: lineStyle },
      h('span', { style: labelStyle }, label),
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
        h('input', { type: 'number', min, step: 'any', style: numInputStyle, value, onChange: (e) => onChange(e.target.value) }),
        h('button', { style: linkButtonStyle, disabled: busy, onClick: () => void onSave() }, t('credSave')),
      ),
    )

  /**
   * One bound-chat table row: chat ocID (short) | session (short) | DSH
   * session title (full) | detach action. Full ids are exposed via title
   * tooltips. The name column shows the DSH workspace title (the session list
   * row, e.g. "继续开发插件"); the Feishu chat name is a fallback when the
   * session has no title yet.
   * @param {{ chatId: string, chatName?: string, sessionId: string }} entry
   */
  const bindingRow = (entry, actionLabel, onAction) => {
    const dshTitle = typeof titles[entry.sessionId] === 'string' && titles[entry.sessionId] !== '' ? titles[entry.sessionId] : undefined
    const name = dshTitle !== undefined
      ? h('span', { style: cellNameStyle, title: dshTitle }, dshTitle)
      : typeof entry.chatName === 'string' && entry.chatName !== ''
        ? h('span', { style: cellNameStyle, title: entry.chatName }, entry.chatName)
        : h('span', { style: cellNameFallbackStyle, title: t('chatUnknown') + ' — ' + entry.chatId },
            shortId(entry.chatId, 14, 6))
    return h('div', { key: entry.sessionId, style: tableRowStyle },
      h('span', { style: cellMonoStyle, title: entry.chatId }, shortId(entry.chatId, 6, 4)),
      h('span', { style: cellMonoStyle, title: entry.sessionId }, shortId(entry.sessionId, 10, 4)),
      name,
      h('span', { style: actionCellStyle },
        h('button', { style: linkButtonStyle, onClick: () => void onAction() }, actionLabel)),
    )
  }

  /**
   * One pending-session table row: a "pending" badge | session (short) |
   * relative created time | cancel action.
   * @param {{ sessionId: string, at: number }} entry
   */
  const pendingRow = (entry) => h('div', { key: entry.sessionId, style: tableRowStyle },
    h('span', { style: pendingBadgeStyle }, t('pendingBadge')),
    h('span', { style: cellMonoStyle, title: entry.sessionId }, shortId(entry.sessionId, 10, 4)),
    h('span', { style: { ...cellNameStyle, color: 'var(--dsw-alias-label-tertiary, #999)' } },
      t('pendingTimePrefix') + pendingTimeLabel(entry.at, t)),
    h('span', { style: actionCellStyle },
      h('button', { style: linkButtonStyle, onClick: () => void detach(entry.sessionId) }, t('pendingDelete'))),
  )

  return h('div', { style: pageStyle },
    // Status card
    h('div', { style: cardStyle },
      h('div', { style: cardHeadStyle },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
          h('span', { style: dotStyle(status !== null && status.connected ? '#4caf7d' : status !== null ? '#e06c6c' : '#8a8f98') }),
          h('div', { style: blockTitleStyle }, t('sectionStatus')),
        ),
        h('button', { style: linkButtonStyle, onClick: () => void refresh() }, t('rowRefresh')),
      ),
      h('div', { style: lineStyle },
        h('span', { style: labelStyle }, t('rowTitle')),
        h('span', { style: valueStyle }, desc),
      ),
    ),
    // Credentials card
    h('div', { style: cardStyle },
      h('div', { style: blockTitleStyle }, t('credTitle')),
      h('div', { style: lineStyle },
        h('span', { style: labelStyle }, t('credAppId')),
        h('input', {
          type: 'text',
          style: inputStyle,
          placeholder: appIdInfo !== null && appIdInfo.masked ? appIdInfo.masked : undefined,
          value: appId,
          spellCheck: false,
          onChange: (e) => setAppId(e.target.value),
        }),
      ),
      h('div', { style: lineStyle },
        h('span', { style: labelStyle }, t('credAppSecret')),
        h('input', {
          type: 'password',
          style: inputStyle,
          placeholder: secretInfo !== null && secretInfo.configured ? t('credUnchanged') : undefined,
          value: appSecret,
          onChange: (e) => setAppSecret(e.target.value),
        }),
      ),
      h('div', { style: lineStyle },
        h('span', { style: labelStyle }, t('credTitle') + ' ' + t('credMaskedHint')),
        h('span', { style: { ...valueStyle, fontSize: 12, color: 'var(--dsw-alias-label-tertiary, #999)' } }, sourceLine),
      ),
      h('div', { style: { display: 'flex', justifyContent: 'flex-end', padding: '8px 0' } },
        h('button', {
          style: primaryButtonStyle,
          disabled: busy,
          onClick: () => void saveCredentials(),
        }, busy ? t('credSaving') : t('credSave')),
      ),
    ),
    // Preferences card
    h('div', { style: cardStyle },
      h('div', { style: blockTitleStyle }, t('sectionPreference')),
      h('div', { style: lineStyle },
        h('span', { style: labelStyle }, t('rowAutoBind')),
        h('input', {
          type: 'checkbox',
          checked: cfg !== null && cfg.autoBindNewSession === true,
          disabled: busy || cfg === null,
          onChange: (event) => void toggleAuto(event.target.checked),
        }),
      ),
      h('div', { style: lineStyle },
        h('span', { style: labelStyle }, t('rowOutputLabel')),
        h('div', { style: { display: 'flex', gap: 6 } },
          outputButton('stream', t('outputStream')),
          outputButton('plain', t('outputPlain')),
        ),
      ),
      h('div', { style: lineStyle },
        h('span', { style: labelStyle }, t('showImagesLabel')),
        h('input', {
          type: 'checkbox',
          checked: cfg !== null && cfg.showImages === true,
          disabled: busy || cfg === null,
          onChange: (event) => void saveConfig({ showImages: event.target.checked }),
        }),
      ),
      h('div', { style: { marginTop: 10, borderTop: '1px solid var(--dsw-alias-border-l2, #333)', paddingTop: 6 } },
        h('div', { style: { color: 'var(--dsw-alias-label-tertiary, #999)', fontSize: 12, marginBottom: 2 } }, t('sectionStaging')),
        numberRow(t('holdTtlLabel'), holdTtl, setHoldTtl, saveHoldTtl, 0),
        numberRow(t('maxHeldImagesLabel'), maxCount, setMaxCount, saveMaxCount, 1),
        numberRow(t('maxHeldImageBytesLabel'), maxMb, setMaxMb, saveMaxMb, 0.001),
      ),
      h('div', { style: lineStyle },
        h('span', { style: labelStyle }, t('quickAction') + '：' + t('rowCreateSession')),
        h('button', {
          style: { ...linkButtonStyle, fontWeight: 600 },
          title: t('rowCreateSessionHint'),
          disabled: busy,
          onClick: () => void createAndConnect(),
        }, t('rowCreateSession')),
      ),
    ),
    // Bindings card with table
    h('div', { style: cardStyle },
      h('div', { style: blockTitleStyle }, t('sectionBindings')),
      status !== null && status.bindings && status.bindings.length === 0 && (!status.pending || status.pending.length === 0)
        ? h('div', { style: { padding: '6px 0', fontSize: 12, color: 'var(--dsw-alias-label-tertiary, #999)' } }, t('rowNoBindings'))
        : h('div', {},
            h('div', { style: tableHeadStyle },
              h('span', {}, t('thChatId')),
              h('span', {}, t('thSession')),
              h('span', {}, t('thName')),
              h('span', { style: { textAlign: 'right' } }, t('thAction')),
            ),
            (status ? status.bindings : []).map((entry) => bindingRow(entry, t('detach'), () => detach(entry.sessionId))),
            status !== null && status.pending && status.pending.length > 0
              ? status.pending.map(pendingRow)
              : null,
          ),
    ),
    // Help card
    h('div', { style: cardStyle },
      h('div', { style: blockTitleStyle }, t('sectionHelp')),
      h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary, #bbb)', lineHeight: 1.9, whiteSpace: 'pre-wrap' } }, t('sectionHelpText')),
    ),
    msg !== null
      ? h('div', { style: { display: 'flex', gap: 6, padding: '2px 0' } },
          h('span', { style: dotStyle(msg.ok ? '#4caf7d' : '#e06c6c') }),
          h('span', { style: msgStyle(msg.ok) }, msg.text))
      : null,
  )
}

// ── in-session image node (feishu/image session events) ───────────────────

const imageNodeStyle = {
  maxWidth: '100%',
  maxHeight: 320,
  borderRadius: 8,
  display: 'block',
  cursor: 'zoom-in',
}

// ── session image gallery (API-driven; no session-log events) ─────────────

const galleryOverlayStyle = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0, 0, 0, 0.55)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 1000,
  padding: 24,
}
const galleryPanelStyle = {
  background: 'var(--dsw-surface, #1e1f24)',
  border: '1px solid var(--dsw-alias-border-default, #333)',
  borderRadius: 12,
  maxWidth: 860,
  width: '100%',
  maxHeight: '80vh',
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
}
const galleryHeaderStyle = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '10px 14px',
  borderBottom: '1px solid var(--dsw-alias-border-default, #333)',
  fontSize: 14,
  fontWeight: 600,
  flex: 'none',
}
const galleryCloseStyle = {
  background: 'none',
  border: 'none',
  color: 'var(--dsw-alias-label-secondary, #bbb)',
  cursor: 'pointer',
  fontSize: 13,
  padding: '2px 6px',
}
const galleryBodyStyle = {
  padding: 24,
  textAlign: 'center',
  color: 'var(--dsw-alias-label-secondary, #bbb)',
  fontSize: 13,
}
const galleryGridStyle = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
  gap: 10,
  padding: 14,
  overflowY: 'auto',
}
const galleryCellStyle = {
  borderRadius: 8,
  overflow: 'hidden',
}
const galleryImageStyle = {
  width: '100%',
  height: 120,
  objectFit: 'cover',
  display: 'block',
  cursor: 'zoom-in',
  borderRadius: 8,
}

/** @param {number} bytes @returns {string} human-readable size. */
function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return ''
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' KB'
  return Math.round((bytes / 1024 / 1024) * 10) / 10 + ' MB'
}

/**
 * Loopback URL for a staged image (shared by the inline node and the gallery).
 * @param {string} sessionId @param {string} name
 * @returns {string}
 */
function imageUrl(sessionId, name) {
  return '/feishu/image/' + encodeURIComponent(sessionId) + '/' + encodeURIComponent(name)
}

/**
 * Caption for a staged image: original file name (or staged name) + size.
 * @param {string} fileName @param {string} name @param {number} bytes
 * @returns {string}
 */
function imageCaption(fileName, name, bytes) {
  return [String(fileName || name), formatBytes(bytes)].filter(Boolean).join(' · ')
}

/**
 * Conversation node Definition for host-appended feishu/image events. Each
 * staged file is unique, so every event starts its own node; the renderer
 * streams the bytes from the host loopback route.
 */
const feishuImageDefinition = {
  kind: 'feishu-image',
  target: 'chat',
  match: (event) => (event !== null && event !== undefined && event.type === 'feishu/image'
    && event.data !== null && typeof event.data === 'object' && typeof event.data.name === 'string')
    ? { id: event.data.name, role: 'start' }
    : null,
  start: (_context, match) => ({
    name: String(match.event.data.name || ''),
    mediaType: String(match.event.data.mediaType || ''),
    bytes: typeof match.event.data.bytes === 'number' ? match.event.data.bytes : 0,
    fileName: String(match.event.data.fileName || ''),
    sessionId: String(match.event.data.sessionId || ''),
  }),
  update: (context) => context.state,
  publication: () => 'immediate',
  buildViewNode: (context) => {
    const start = context.start !== undefined ? context.start : (context.matches && context.matches[0])
    return {
      key: context.key,
      kind: 'feishu-image',
      id: context.id,
      target: 'chat',
      anchorSeq: (start && start.event && start.event.seq) || 0,
      location: (start && start.location) || { kind: 'session' },
      visibility: 'visible',
      data: context.state,
    }
  },
}

/** Relative time label for a pending entry. */
function pendingTimeLabel(at, t) {
  if (!at || at <= 0) return t('pendingJustNow')
  const minutes = Math.floor((Date.now() - at) / 60000)
  if (minutes < 1) return t('pendingJustNow')
  if (minutes < 60) return t('pendingTime').replace('{n}', String(minutes))
  return t('pendingTimeHours').replace('{n}', String(Math.floor(minutes / 60)))
}

/**
 * Shorten a long id for table cells: keep head + tail around an ellipsis.
 * Short values (<= head+tail+1 chars) pass through untouched.
 * @param {string | undefined} id
 * @param {number} [head] chars kept from the start.
 * @param {number} [tail] chars kept from the end.
 * @returns {string}
 */
function shortId(id, head = 8, tail = 4) {
  if (typeof id !== 'string' || id === '') return ''
  return id.length > head + tail + 1 ? id.slice(0, head) + '…' + id.slice(-tail) : id
}

const linkButtonStyle = {
  background: 'none',
  border: 'none',
  color: 'var(--dsw-alias-state-business-primary, #6b9bff)',
  cursor: 'pointer',
  padding: 0,
  fontSize: 12,
  textDecoration: 'underline',
}

// ── plugin entry ──────────────────────────────────────────────────────────

/** Required services (cordis fiber inject). */
const inject = ['slots', 'locale', 'connection', 'sessions', 'workspaces']

/**
 * Mount the Feishu surfaces.
 * @param {import('@deepseek-ai/dsh-client-runtime/client').ClientContext} ctx
 */
function apply(ctx) {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-fschannel: locales')

  // Auto-connect new sessions when the preference is on, and honor the
  // one-shot "new session and connect" button. The first list snapshot after
  // boot/reconnect is a baseline: seed the seen set without binding, so
  // restored sessions are never mass-bound.
  let stageBind = false
  let stageTimer = undefined
  const clearStage = () => {
    stageBind = false
    if (stageTimer !== undefined) {
      clearTimeout(stageTimer)
      stageTimer = undefined
    }
  }
  const createConnectedSession = async () => {
    clearStage()
    stageBind = true
    // Disarm when no session appeared within the grace window, so a session
    // created later by other means is never surprise-bound.
    stageTimer = setTimeout(clearStage, 60000)
    try {
      await ctx.workspaces.startSession()
    } catch {
      clearStage()
    }
  }
  ctx.effect(() => {
    let seen = null
    const maybeBind = async (sessionId) => {
      try {
        if (stageBind) {
          clearStage()
          await api('bind', { method: 'POST', body: JSON.stringify({ sessionId }) })
          return
        }
        const cfg = await api('config')
        if (cfg.ok && cfg.autoBindNewSession === true) {
          await api('bind', { method: 'POST', body: JSON.stringify({ sessionId }) })
        }
      } catch {
        // Non-fatal: the header chip still offers the manual connect.
      }
    }
    const stop = ctx.sessions.list.subscribe(() => {
      const state = ctx.sessions.list.getSnapshot()
      const ids = Object.keys(state.byId || {})
      if (seen === null) {
        seen = new Set(ids)
        return
      }
      for (const id of ids) {
        if (seen.has(id)) continue
        seen.add(id)
        const summary = state.byId[id]
        if (summary && summary.blank === true) void maybeBind(id)
      }
    })
    const onReset = () => { seen = null; clearStage() }
    ctx.on('connection/reset', onReset)
    return () => {
      stop()
      ctx.off('connection/reset', onReset)
    }
  }, 'dsh-fschannel: auto-bind new sessions')

  // In-session image nodes: register only when the conversation event engine
  // is present, so an older host never breaks the seat/settings surfaces.
  const conversationEvents = ctx.get('conversationEvents')
  if (conversationEvents !== undefined) {
    const FeishuImageNodeView = ({ node }) => {
      const data = (node !== null && node !== undefined && node.data) || {}
      const name = String(data.name || '')
      const sessionId = String(data.sessionId || '')
      const url = imageUrl(sessionId, name)
      const [failed, setFailed] = useState(false)
      const missing = (() => { try { return ctx.locale.bind(NS)('imgNodeMissing') } catch { return 'missing' } })()
      const openHint = (() => { try { return ctx.locale.bind(NS)('imgOpen') } catch { return 'open' } })()
      const caption = imageCaption(data.fileName, name, data.bytes)
      if (failed || name === '' || sessionId === '') {
        return h('div', { style: { padding: '8px 0', fontSize: 12, color: 'var(--dsw-alias-label-tertiary, #999)' } },
          caption + (failed ? '（' + missing + '）' : ''))
      }
      return h('div', { style: { padding: '8px 0' } },
        h('img', {
          src: url,
          alt: caption,
          title: caption + ' — ' + openHint,
          loading: 'lazy',
          style: imageNodeStyle,
          onError: () => setFailed(true),
          onClick: () => window.open(url, '_blank'),
        }),
        h('div', { style: { marginTop: 4, fontSize: 12, color: 'var(--dsw-alias-label-tertiary, #999)' } }, caption),
      )
    }
    conversationEvents.register(feishuImageDefinition)
    ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
      name: 'conversation.chat.node',
      key: 'feishu-image',
    }, FeishuImageNodeView))
  }

  // Session image gallery: images are no longer written into the session log
  // (an unknown event type makes the harness refuse the whole log), so the
  // gallery is API-driven. Old logs still carry feishu/image events — those
  // render inline via feishuImageDefinition above; this button covers every
  // session uniformly from the plugin's own image index.
  const FeishuGalleryButton = ({ sessionId, t }) => {
    const [open, setOpen] = useState(false)
    const [images, setImages] = useState(null) // null = loading
    const [count, setCount] = useState(-1) // -1 = unknown, 0 = hidden

    const refresh = useCallback(async () => {
      try {
        const data = await api('images/' + encodeURIComponent(sessionId))
        if (data.ok && Array.isArray(data.images)) {
          setImages(data.images)
          setCount(data.images.length)
          return
        }
      } catch { /* best effort */ }
      setImages([])
      setCount(0)
    }, [sessionId])

    useEffect(() => { void refresh() }, [refresh])

    const onOpen = () => {
      setOpen(true)
      void refresh() // re-fetch so a just-received image appears
    }

    if (count === 0 || (images === null && count < 0)) return null
    return h(Fragment, {},
      h('button', {
        style: chipStyle,
        title: t('galleryOpen'),
        onClick: onOpen,
        'data-testid': 'feishu-gallery',
      }, t('galleryOpen')),
      open ? h('div', {
        style: galleryOverlayStyle,
        onClick: () => setOpen(false),
      }, h('div', {
        style: galleryPanelStyle,
        onClick: (event) => event.stopPropagation(),
      },
      h('div', { style: galleryHeaderStyle },
        h('span', {}, t('galleryTitle').replace('{n}', String(count))),
        h('button', { style: galleryCloseStyle, onClick: () => setOpen(false) }, t('galleryClose')),
      ),
      images === null ? h('div', { style: galleryBodyStyle }, t('galleryLoading'))
        : images.length === 0 ? h('div', { style: galleryBodyStyle }, t('galleryEmpty'))
          : h('div', { style: galleryGridStyle }, images.map((image) => {
              const name = String(image.name || '')
              const url = imageUrl(sessionId, name)
              const caption = imageCaption(image.fileName, name, image.bytes)
              return h('div', { key: name, style: galleryCellStyle },
                h('img', {
                  src: url,
                  alt: caption,
                  title: caption,
                  loading: 'lazy',
                  style: galleryImageStyle,
                  onClick: () => window.open(url, '_blank'),
                }),
                h('div', { style: { marginTop: 4, fontSize: 12, color: 'var(--dsw-alias-label-tertiary, #999)' } }, caption),
              )
            })))) : null)
  }

  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
    name: 'conversation.session.header.actions',
    id: 'feishu-images',
    order: 5,
    locale: NS,
    inject: () => ({}),
  }, FeishuGalleryButton))

  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
    name: 'conversation.session.header.actions',
    id: 'feishu-bind',
    order: 0,
    locale: NS,
    inject: () => ({}),
  }, FeishuSeat))

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'feishu',
    order: 15,
    locale: NS,
    label: () => ctx.locale.bind(NS)('nav'),
    inject: () => ({
      createSession: () => void createConnectedSession(),
      // DSH workspace display titles (the session list rows), so the bindings
      // table can show e.g. "继续开发插件" instead of the Feishu chat name.
      sessionTitles: () => {
        try {
          const byId = ctx.sessions.list.getSnapshot().byId || {}
          const titles = {}
          for (const id of Object.keys(byId)) {
            const entry = byId[id]
            if (entry && typeof entry.displayTitle === 'string' && entry.displayTitle !== '') titles[id] = entry.displayTitle
          }
          return titles
        } catch {
          return {}
        }
      },
    }),
  }, FeishuSection))
}

    module.exports = { inject, apply }
    return module.exports
  },
})
