// 上下文组成拆解：把一次请求的 messages 拆成若干组成部分，
// 按字符占比对总输入 token 做估算分摊（dsh-context 的"Token Stats"数据层对应物）。
// 附按工具归因（工具结果/调用回放各工具各占多少）与可选的按消息明细。
import { contextLimitFor } from './pricing.mjs'

const REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g

/** 把一段文本按 system-reminder 拆成 {plain, injected} 两段字符数。 */
function splitReminder(text) {
  const injected = (text.match(REMINDER) || []).join('')
  return { plain: text.replace(REMINDER, ''), injected }
}

/** CJK/全角字符（含中文标点、假名、汉字扩展 B 基本段）——GLM 分词下 1 个此类字符 ≈ 1 token，而 4 个 ASCII 字符 ≈ 1 token，权重取 3。 */
const CJK_RE = /[\u2e80-\u9fff\uff00-\uffef\u{20000}-\u{2fa1f}]/gu

/** 加权字符量：CJK 权重 3、其余 1——比均匀字符数更贴近分词后的 token 占比。 */
function weightedLen(text) {
  const cjk = (text.match(CJK_RE) || []).length
  return cjk * 3 + (text.length - cjk)
}

/** 内容块的规范量度：文本按加权字符计，其他块用序列化文本的加权长度。 */
function charsOf(value) {
  if (typeof value === 'string') return weightedLen(value)
  try { return weightedLen(JSON.stringify(value)) } catch { return weightedLen(String(value)) }
}

/**
 * 从一条 model_io 记录拆出组成。
 * 返回 parts（按估算 token 降序）、toolAttribution（按工具名）、窗口/输出用量；
 * opts.detail=true 时附带 messages 明细（按字符量取前若干条）。
 * 估算口径：总输入 token（含缓存命中部分）按各部分序列化字符数占比分摊——
 * 分项是估算值，总数是精确值。
 */
export function composeFromRequest(record, opts = {}) {
  const body = record?.request?.body || {}
  const usage = record?.response?.usage || {}
  const messages = Array.isArray(body.messages) ? body.messages : []
  const buckets = new Map()
  const add = (key, label, value) => {
    const b = buckets.get(key) || { key, label, chars: 0, blocks: 0 }
    b.chars += charsOf(value)
    b.blocks += 1
    buckets.set(key, b)
  }

  // 工具归因：先收 tool_use id→name 映射，tool_result 按 id 归到对应工具名
  const toolNameById = new Map()
  for (const msg of messages) {
    const items = Array.isArray(msg?.content) ? msg.content : []
    for (const b of items) {
      if (b?.type === 'tool_use' && typeof b.name === 'string') toolNameById.set(b.id, b.name)
    }
    if (Array.isArray(msg?.tool_calls)) for (const tc of msg.tool_calls) {
      const name = tc?.function?.name || tc?.name
      if (name && tc?.id) toolNameById.set(tc.id, name)
    }
  }
  const attribution = new Map() // name → {results:{chars,blocks}, calls:{chars,blocks}}
  const attr = (name, kind, value) => {
    const a = attribution.get(name) || { results: { chars: 0, blocks: 0 }, calls: { chars: 0, blocks: 0 } }
    a[kind].chars += charsOf(value)
    a[kind].blocks += 1
    attribution.set(name, a)
  }
  const msgRows = opts.detail ? [] : null

  // 1. 系统提示词（body.system：字符串或块数组；其中 system-reminder 计入注入上下文）
  const sys = body.system
  if (sys != null && sys !== '') {
    const blocks = Array.isArray(sys) ? sys : [sys]
    for (const b of blocks) {
      const text = typeof b === 'string' ? b : (b?.text ?? null)
      if (typeof text === 'string') {
        const { plain, injected } = splitReminder(text)
        if (plain) add('system', '系统提示词', plain)
        if (injected) add('injected', '注入上下文（system-reminder）', injected)
      } else if (b != null) add('system', '系统提示词', b)
    }
  }

  // 2. 工具定义（body.tools）
  if (Array.isArray(body.tools)) for (const t of body.tools) add('tools', '工具定义', t)

  // 3. 消息内容
  for (let mi = 0; mi < messages.length; mi++) {
    const msg = messages[mi]
    const role = msg?.role || 'unknown'
    const content = msg?.content
    const items = typeof content === 'string' ? [{ type: 'text', text: content }] : (Array.isArray(content) ? content : [])
    const row = opts.detail ? { i: mi, role, chars: 0, kinds: [] } : null
    const note = (kind, value) => { if (row) { row.chars += charsOf(value); row.kinds.push(kind) } }
    for (const b of items) {
      const type = b?.type || (typeof b === 'string' ? 'text' : 'other')
      if (type === 'text' && typeof b.text === 'string') {
        const { plain, injected } = splitReminder(b.text)
        if (injected) { add('injected', '注入上下文（system-reminder）', injected); note('注入', injected) }
        if (plain) {
          if (role === 'user') { add('user', '用户消息', plain); note('用户', plain) }
          else if (role === 'assistant') { add('assistant', '助手回复', plain); note('助手', plain) }
          else if (role === 'system') { add('systemMsgs', '会话级 system 消息（摘要/注入）', plain); note('system消息', plain) }
          else { add('otherText', `其他文本（role=${role}）`, plain); note('其他', plain) }
        }
      } else if (type === 'tool_result') {
        add('toolResults', '工具结果', b); note('工具结果', b)
        const name = toolNameById.get(b?.tool_use_id) || '(未知工具)'
        attr(name, 'results', b)
      } else if (type === 'tool_use') {
        add('toolCalls', '工具调用（请求内回放）', b); note('工具调用', b)
        attr(b?.name || '(未知)', 'calls', b)
      } else if (type === 'thinking' || type === 'redacted_thinking') {
        add('reasoning', '推理（thinking 回放）', b); note('推理', b)
      } else if (type === 'image' || type === 'document') {
        add('images', '图片/文档块', b); note('图片', b)
      } else { add('otherText', '其他内容块', b); note('其他', b) }
    }
    // OpenAI 风格的 tool_calls 挂在消息上
    if (Array.isArray(msg?.tool_calls)) for (const tc of msg.tool_calls) {
      add('toolCalls', '工具调用（请求内回放）', tc); note('工具调用', tc)
      attr(tc?.function?.name || tc?.name || '(未知)', 'calls', tc)
    }
    if (row) msgRows.push(row)
  }

  const windowTokens = usage.inputTokens ?? null
  const totalChars = [...buckets.values()].reduce((s, b) => s + b.chars, 0)
  const toTok = chars => (windowTokens != null && totalChars > 0 ? Math.round(windowTokens * chars / totalChars) : null)
  const parts = [...buckets.values()].map(b => ({
    ...b, estTokens: toTok(b.chars),
    pct: totalChars > 0 ? +(100 * b.chars / totalChars).toFixed(1) : null,
  })).sort((a, b) => b.chars - a.chars)

  const toolAttribution = [...attribution.entries()]
    .map(([name, a]) => ({ name, ...a }))
    .sort((x, y) => (y.results.chars + y.calls.chars) - (x.results.chars + x.calls.chars))

  const modelId = record?.model?.modelId || null
  return {
    model: modelId,
    provider: record?.model?.providerId || null,
    ts: record?.completedAt || null,
    windowTokens,
    cacheReadTokens: usage.cacheReadTokens ?? null,
    outputTokens: usage.outputTokens ?? null,
    contextLimit: contextLimitFor(modelId),
    totalChars,
    parts,
    toolAttribution,
    messages: msgRows ? msgRows.map(r => ({ ...r, estTokens: toTok(r.chars), kinds: [...new Set(r.kinds)].slice(0, 3) })) : null,
    note: '分项 token 为按加权字符占比（CJK/全角权重 3）对总输入 token 的估算；总数（windowTokens）为精确值。usage.inputTokens 按含缓存命中口径计入窗口。',
  }
}
