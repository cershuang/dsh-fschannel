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
  rowTitle: '飞书机器人',
  rowDescConnected: '机器人已连接 · 绑定 {bound} 个会话 · 待绑定 {pending} 个',
  rowDescDisconnected: '机器人未连接：{reason}',
  rowDescConnecting: '机器人连接中…',
  rowDescUnconfigured: '未配置凭据（appId/appSecret）',
  rowAutoBind: '新会话默认连接飞书',
  rowCreateSession: '新建会话并连接飞书',
  rowCreateSessionHint: '立即新建一个会话并进入待绑定状态（在飞书发一条消息完成绑定）',
  rowOutput: '输出方式：{mode}',
  outputStream: '流式卡片',
  outputPlain: '普通消息',
  rowRefresh: '刷新',
  rowBindingsTitle: '绑定列表',
  rowNoBindings: '还没有绑定任何会话',
  detach: '断开',
  chatUnknown: '未知聊天',
  sessionShort: '会话',
}

const en = {
  seatUnbound: 'Connect Feishu',
  seatPending: 'Awaiting bind',
  seatPendingHint: 'Send the bot a message in Feishu to finish binding (click to cancel)',
  seatBound: 'Connected',
  seatBoundHint: 'This session is connected to Feishu chat: {chat} (click to disconnect)',
  seatLoading: '…',
  confirmUnbind: 'Disconnect this session from Feishu?',
  rowTitle: 'Feishu bot',
  rowDescConnected: 'Bot connected · {bound} sessions bound · {pending} pending',
  rowDescDisconnected: 'Bot offline: {reason}',
  rowDescConnecting: 'Bot connecting…',
  rowDescUnconfigured: 'Credentials not configured (appId/appSecret)',
  rowAutoBind: 'Auto-connect new sessions to Feishu',
  rowCreateSession: 'New session and connect to Feishu',
  rowCreateSessionHint: 'Create a session right away and mark it pending (send the bot a message in Feishu to bind)',
  rowOutput: 'Output: {mode}',
  outputStream: 'streaming cards',
  outputPlain: 'plain messages',
  rowRefresh: 'Refresh',
  rowBindingsTitle: 'Bindings',
  rowNoBindings: 'No sessions bound yet',
  detach: 'Detach',
  chatUnknown: 'unknown chat',
  sessionShort: 'Session',
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
    } else if ((data.pending || []).includes(sessionId)) {
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

// ── settings row ──────────────────────────────────────────────────────────

function FeishuSettingsRow({ t, createSession }) {
  const [status, setStatus] = useState(null)
  const [autoBind, setAutoBind] = useState(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    const [s, c] = await Promise.all([api('status'), api('config')])
    setStatus(s.ok ? s : null)
    setAutoBind(c.ok ? c.autoBindNewSession : null)
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const toggleAuto = async (value) => {
    setBusy(true)
    try {
      const res = await api('config', { method: 'POST', body: JSON.stringify({ autoBindNewSession: value }) })
      if (res.ok) setAutoBind(res.autoBindNewSession)
    } finally {
      setBusy(false)
    }
  }

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

  const rowStyle = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 16,
    padding: '10px 0',
    width: '100%',
  }
  const textStyle = { minWidth: 0 }
  const titleStyle = { fontSize: 14, fontWeight: 500, color: 'var(--dsw-alias-label-primary, #eee)' }
  const descStyle = { fontSize: 12, color: 'var(--dsw-alias-label-tertiary, #999)', marginTop: 2 }

  return h('div', { style: rowStyle },
    h('div', { style: textStyle },
      h('div', { style: titleStyle }, t('rowTitle')),
      h('div', { style: descStyle }, desc),
      h('div', { style: { marginTop: 8, display: 'flex', alignItems: 'center', gap: 10, fontSize: 12, flexWrap: 'wrap' } },
        h('label', { style: { display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' } },
          h('input', {
            type: 'checkbox',
            checked: autoBind === true,
            disabled: busy || autoBind === null,
            onChange: (event) => void toggleAuto(event.target.checked),
          }),
          t('rowAutoBind'),
        ),
        h('button', {
          style: { ...linkButtonStyle, fontWeight: 600 },
          title: t('rowCreateSessionHint'),
          disabled: busy,
          onClick: () => void createAndConnect(),
        }, t('rowCreateSession')),
        status !== null && status.output !== undefined
          ? h('span', { style: { color: 'var(--dsw-alias-label-tertiary, #999)' } },
            t('rowOutput').replace('{mode}', status.output === 'plain' ? t('outputPlain') : t('outputStream')))
          : null,
        h('button', { style: linkButtonStyle, onClick: () => void refresh() }, t('rowRefresh')),
      ),
      h('div', { style: { marginTop: 8, fontSize: 12, color: 'var(--dsw-alias-label-secondary, #bbb)' } },
        h('details', null,
          h('summary', { style: { cursor: 'pointer' } }, t('rowBindingsTitle')),
          status !== null && status.bindings && status.bindings.length === 0
            ? h('div', { style: { marginTop: 4 } }, t('rowNoBindings'))
            : h('div', { style: { marginTop: 4, display: 'flex', flexDirection: 'column', gap: 4 } },
              (status ? status.bindings : []).map((entry) => h('div', { key: entry.sessionId, style: { display: 'flex', alignItems: 'center', gap: 8 } },
                h('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                  entry.chatName || entry.chatId,
                  h('span', { style: { color: 'var(--dsw-alias-label-tertiary, #999)' } },
                    ' · ' + t('sessionShort') + ' ' + String(entry.sessionId).slice(0, 8) + '…'),
                ),
                h('button', { style: linkButtonStyle, onClick: () => void detach(entry.sessionId) }, t('detach')),
              )),
            ),
        ),
      ),
    ),
  )
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
  const createConnectedSession = async () => {
    stageBind = true
    try {
      await ctx.workspaces.startSession()
    } catch {
      stageBind = false
    }
  }
  ctx.effect(() => {
    let seen = null
    const maybeBind = async (sessionId) => {
      try {
        if (stageBind) {
          stageBind = false
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
    const onReset = () => { seen = null }
    ctx.on('connection/reset', onReset)
    return () => {
      stop()
      ctx.off('connection/reset', onReset)
    }
  }, 'dsh-fschannel: auto-bind new sessions')

  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
    name: 'conversation.session.header.actions',
    id: 'feishu-bind',
    order: 0,
    locale: NS,
    inject: () => ({}),
  }, FeishuSeat))

  ctx.slots.inject('settings.general.item', () => ctx.slots.register({
    name: 'settings.general.item',
    id: 'feishu',
    order: 15,
    locale: NS,
    inject: () => ({ createSession: () => void createConnectedSession() }),
  }, FeishuSettingsRow))
}

    module.exports = { inject, apply }
    return module.exports
  },
})
