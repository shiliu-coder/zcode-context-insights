// context-insights MCP server：stdio JSON-RPC（MCP 协议），零依赖 Node ESM。
// 数据源为本地 ZCode rollout 日志，不做任何网络请求；价格表见 pricing-builtin.json。
import readline from 'node:readline'
import { mkdirSync, writeFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { listSessions, resolveSession, updateIndex, tailLastLine, readLineAt, searchSessionFile } from './lib/rollout.mjs'
import { composeFromRequest } from './lib/compose.mjs'
import { estimateCostUsd, isPlanProvider, priceFor, configDir, contextLimitFor } from './lib/pricing.mjs'

// ---------- 格式化 ----------

const fmtInt = n => n == null ? 'N/A' : Intl.NumberFormat('en-US').format(Math.round(n))
const fmtTok = n => {
  if (n == null) return 'N/A'
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`
  return String(Math.round(n))
}
const fmtUsd = n => n == null ? 'N/A' : `$${n < 0.01 && n > 0 ? n.toFixed(4) : n.toFixed(2)}`
const pad2 = n => String(n).padStart(2, '0')
const shortSid = sid => {
  if (sid == null) return 'N/A'
  const bare = sid.replace(/^sess_subagent_agent_/, '').replace(/^sess_/, '')
  return bare.length <= 12 ? bare : bare.slice(0, 8)
}
const fmtDate = ts => {
  if (!ts) return 'N/A'
  const d = new Date(ts)
  if (isNaN(d)) return String(ts)
  // 本机时区：与小时分布/每日分桶保持同一口径
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}
const localDayKey = ts => {
  const d = new Date(ts)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}
const isSub = sid => typeof sid === 'string' && sid.includes('subagent')
const homePath = p => typeof p === 'string' ? p.replace(/^\/Users\/[^/]+/, '~') : '-'
/** 表格用的工作区显示：超长路径折叠中段（.zcode/workspace/<uuid> 之类）。 */
const wsDisplay = p => {
  if (typeof p !== 'string' || !p) return '-'
  const t = p.replace(/^\/Users\/[^/]+/, '~').replace(/\/+$/, '')
  if (t.length <= 48) return t
  const segs = t.split('/')
  return `${segs[0]}/…/${segs[segs.length - 1]}`
}
/** 会话标题渲染清洗：剥 markdown 链接留文字、折叠空白。 */
const cleanTitle = t => typeof t === 'string' ? t.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\s+/g, ' ').trim() : t
/** 走势条图降采样：点数上限 72（桶内取均值），避免超宽换行。 */
const downsample = (values, max = 72) => {
  if (values.length <= max) return values
  const size = Math.ceil(values.length / max)
  const out = []
  for (let i = 0; i < values.length; i += size) {
    let s = 0, n = 0
    for (let j = i; j < Math.min(i + size, values.length); j++) { s += values[j] || 0; n++ }
    out.push(s / Math.max(1, n))
  }
  return out
}

/** 把一列数值画成 Unicode 高度条（趋势/热力图用）。 */
function sparkline(values) {
  if (!values.length) return ''
  const max = Math.max(...values, 1)
  const blocks = '▁▂▃▄▅▆▇█'
  return values.map(v => blocks[Math.min(7, Math.floor(8 * (v || 0) / max))]).join('')
}

const sum = (arr, f) => arr.reduce((s, x) => s + (f(x) || 0), 0)

/** 索引摘要（短键 in/out/cr/cw）→ 成本估算；缓存命中部分按 cacheRead 价计，避免与 input 价重复计费。 */
function requestCostUsd(r) {
  const inTok = r.in ?? null
  const cr = r.cr ?? 0
  // inputTokens 含缓存命中：非缓存部分按 input 价，命中部分按 cacheRead 价
  return estimateCostUsd(r.model, inTok == null ? null : { inputTokens: Math.max(0, inTok - cr), outputTokens: r.out ?? 0, cacheReadTokens: cr, cacheWriteTokens: r.cw ?? 0 })
}

/** 按时间排序的请求序列。 */
const sortedReqs = entry => (entry?.requests || []).slice().sort((a, b) => (a.ts || '').localeCompare(b.ts || ''))

function rolloutDirOf() { return process.env.CONTEXT_INSIGHTS_ROLLOUT_DIR || '~/.zcode/cli/rollout' }

/**
 * 取会话内某次请求的完整记录。reqIdx=-1 尾部直读（不依赖索引）；
 * 其他索引值经字节偏移直读。返回 {record, picked, total, err}。
 */
async function getRequestRecord(target, idx, reqIdx) {
  if (reqIdx === -1) {
    const record = await tailLastLine(target.file)
    return record && record.type === 'model_io'
      ? { record, picked: '最后一条请求', total: null }
      : { err: `${target.sid} 尾部未读到完整 model_io 记录。` }
  }
  const reqs = sortedReqs(idx?.sessions?.[target.sid])
  const i = reqIdx < 0 ? reqs.length + reqIdx : reqIdx
  if (!(i >= 0 && i < reqs.length)) {
    return { err: `request 索引越界：会话共 ${reqs.length} 条请求，有效范围 [-${reqs.length}, ${reqs.length - 1}]。` }
  }
  if (reqs[i].off == null) return { err: '索引缺少该请求的字节偏移（旧版索引）。再次调用可触发索引增量升级后重试。' }
  const record = readLineAt(target.file, reqs[i].off)
  if (!record || record.type !== 'model_io') return { err: `${target.sid} 未读到完整 model_io 记录（第 ${i + 1}/${reqs.length} 条）。` }
  return { record, picked: `第 ${i + 1}/${reqs.length} 条请求（request=${reqIdx}）`, total: reqs.length }
}

// ---------- 工具实现 ----------

async function toolComposition(args = {}, idx) {
  const target = resolveSession(args.session)
  if (!target) return `未找到会话${args.session ? `（匹配 "${args.session}"）` : ''}：rollout 目录 ${rolloutDirOf()} 下没有 model-io-*.jsonl 文件。`
  const reqIdx = Number.isInteger(args.request) ? args.request : -1
  const got = await getRequestRecord(target, idx, reqIdx)
  if (got.err) return got.err
  const { record, picked } = got
  const c = composeFromRequest(record, { detail: args.detail === true })
  const plan = isPlanProvider(c.provider)
  const lines = []
  lines.push(`## 上下文组成 · 会话 ${shortSid(target.sid)}（${args.session ? '指定' : '最近活跃'} · ${picked}）`)
  lines.push('')
  lines.push(`- 模型：\`${c.model}\`${plan ? '（套餐 provider）' : ''} · provider \`${c.provider}\``)
  lines.push(`- 窗口：${fmtInt(c.windowTokens)} token（含缓存命中 ${fmtInt(c.cacheReadTokens)}）`
    + (c.contextLimit ? ` / 上限 ${fmtInt(c.contextLimit)}，占用 ${(100 * (c.windowTokens || 0) / c.contextLimit).toFixed(1)}%` : '（模型上限未知）'))
  lines.push(`- 本请求输出：${fmtInt(c.outputTokens)} token · 时间 ${fmtDate(c.ts)} · 工具定义 ${record?.request?.body?.tools?.length ?? '?'} 个`)
  lines.push('')
  lines.push('| 组成部分 | 估算 token | 占比(加权) | 块数 |')
  lines.push('|---|---|---|---|')
  for (const p of c.parts) lines.push(`| ${p.label} | ${fmtInt(p.estTokens)} | ${p.pct ?? 'N/A'}% | ${p.blocks} |`)
  // 按工具归因：哪个工具的结果/调用回放在吃上下文
  const attr = (c.toolAttribution || []).slice(0, 6)
  if (attr.length) {
    lines.push('')
    lines.push('| 工具 | 结果 token | 调用回放 token | 结果块 |')
    lines.push('|---|---|---|---|')
    for (const a of attr) {
      const rTok = Math.round((a.results.chars / (c.totalChars || 1)) * (c.windowTokens || 0))
      const cTok = Math.round((a.calls.chars / (c.totalChars || 1)) * (c.windowTokens || 0))
      lines.push(`| ${a.name} | ${fmtInt(rTok)} | ${fmtInt(cTok)} | ${a.results.blocks} |`)
    }
  }
  // 按消息明细（detail=true）：定位具体是哪几条消息最大
  if (c.messages) {
    const rows = c.messages.slice().sort((a, b) => b.chars - a.chars)
    const top = rows.slice(0, 12)
    const rest = rows.slice(12)
    lines.push('')
    lines.push(`### 消息明细（按字符量前 ${top.length}${rest.length ? `，其余 ${rest.length} 条合并` : ''}）`)
    lines.push('| # | role | 内容 | 估算 token |')
    lines.push('|---|---|---|---|')
    for (const r of top) lines.push(`| ${r.i} | ${r.role} | ${r.kinds.join('+')} | ${fmtInt(r.estTokens)} |`)
    if (rest.length) lines.push(`| — | 其余 ${rest.length} 条 | — | ${fmtInt(rest.reduce((s, r) => s + (r.estTokens || 0), 0))} |`)
  }
  lines.push('')
  lines.push(`> ${c.note}`)
  return lines.join('\n')
}

/** 组成增量：两个请求之间上下文长在哪里。 */
async function toolDiff(args = {}, idx) {
  const target = resolveSession(args.session)
  if (!target) return `未找到会话（匹配 "${args.session}"）。`
  const fromIdx = Number.isInteger(args.from) ? args.from : -5
  const toIdx = Number.isInteger(args.to) ? args.to : -1
  const a = await getRequestRecord(target, idx, fromIdx)
  if (a.err) return `from 请求失败：${a.err}`
  const b = await getRequestRecord(target, idx, toIdx)
  if (b.err) return `to 请求失败：${b.err}`
  const ca = composeFromRequest(a.record)
  const cb = composeFromRequest(b.record)
  const keys = [...new Set([...ca.parts.map(p => p.key), ...cb.parts.map(p => p.key)])]
  const mapBy = parts => new Map(parts.map(p => [p.key, p]))
  const ma = mapBy(ca.parts), mb = mapBy(cb.parts)
  const rows = keys.map(k => ({
    label: (mb.get(k) || ma.get(k)).label,
    a: ma.get(k)?.estTokens ?? 0,
    b: mb.get(k)?.estTokens ?? 0,
  })).map(r => ({ ...r, d: r.b - r.a })).sort((x, y) => Math.abs(y.d) - Math.abs(x.d))
  const lines = []
  lines.push(`## 组成增量 · 会话 ${shortSid(target.sid)}（${a.picked} → ${b.picked}）`)
  lines.push('')
  lines.push(`- 窗口：${fmtInt(ca.windowTokens)} → ${fmtInt(cb.windowTokens)}（${(cb.windowTokens || 0) - (ca.windowTokens || 0) >= 0 ? '+' : ''}${fmtInt((cb.windowTokens || 0) - (ca.windowTokens || 0))}）`
    + ` · 时间 ${fmtDate(ca.ts)} → ${fmtDate(cb.ts)}`)
  lines.push('')
  lines.push('| 组成部分 | from | to | 增量 |')
  lines.push('|---|---|---|---|')
  for (const r of rows) lines.push(`| ${r.label} | ${fmtInt(r.a)} | ${fmtInt(r.b)} | ${r.d >= 0 ? '+' : ''}${fmtInt(r.d)} |`)
  lines.push('')
  lines.push('> 增量为估算值的差（分项按字符占比分摊）；回答"从 A 到 B，上下文长在哪里"。')
  return lines.join('\n')
}

async function toolTrend(args = {}, idx) {
  const target = resolveSession(args.session)
  if (!target) return `未找到会话（匹配 "${args.session}"）。`
  const entry = idx.sessions[target.sid]
  const reqs = sortedReqs(entry)
  if (!reqs.length) return `${target.sid} 在索引中没有请求记录。`
  const inTok = sum(reqs, r => r.in), outTok = sum(reqs, r => r.out), cr = sum(reqs, r => r.cr)
  const costs = reqs.map(requestCostUsd).filter(v => v != null)
  const totalCost = costs.length ? costs.reduce((s, v) => s + v, 0) : null
  const model = reqs[reqs.length - 1].model, provider = reqs[reqs.length - 1].provider
  const modelMs = sum(reqs, r => r.ms)
  const spanMs = (Date.parse(reqs[reqs.length - 1].ts) - Date.parse(reqs[0].ts)) || 0
  // 压缩事件：相邻请求输入 token 骤降 >40%（且此前超过 10k）
  const compactions = []
  for (let i = 1; i < reqs.length; i++) {
    const prev = reqs[i - 1].in, cur = reqs[i].in
    if (prev != null && cur != null && prev > 10000 && cur < prev * 0.6) {
      compactions.push({ at: reqs[i].ts, from: prev, to: cur, pct: Math.round(100 * (1 - cur / prev)) })
    }
  }
  // 按轮次（turnId）聚合：每个 user 步骤的请求与 token 消耗
  const turns = new Map()
  for (let i = 0; i < reqs.length; i++) {
    const r = reqs[i]
    const key = r.turn || null
    const t = turns.get(key) || { n: 0, in: 0, out: 0, first: r.ts }
    t.n++; t.in += r.in || 0; t.out += r.out || 0
    turns.set(key, t)
  }
  const turnRows = [...turns.entries()].map(([k, t]) => ({ k: k ?? '(无 turn 标记)', ...t }))
  const topTurns = turnRows.slice().sort((a, b) => b.in - a.in).slice(0, 5)
  const lines = []
  lines.push(`## 上下文趋势 · 会话 ${shortSid(target.sid)}${entry?.workspace ? ` · ${wsDisplay(entry.workspace)}` : ''}`)
  if (entry?.title) lines.push(`> ${cleanTitle(entry.title).slice(0, 80)}`)
  lines.push('')
  lines.push(`- 模型 \`${model}\` · ${reqs.length} 次请求 · ${fmtDate(reqs[0].ts)} → ${fmtDate(reqs[reqs.length - 1].ts)}`)
  lines.push(`- 输入合计 ${fmtTok(inTok)} · 输出合计 ${fmtTok(outTok)} · 缓存命中 ${fmtTok(cr)}（命中率 ${inTok ? (100 * cr / inTok).toFixed(1) : 'N/A'}%）`)
  lines.push(`- 峰值输入 ${fmtTok(Math.max(...reqs.map(r => r.in || 0)))} · 计费输入（扣缓存）合计 ${fmtTok(inTok - cr)}`)
  lines.push(`- 模型耗时 ${fmtDur(modelMs)} · 会话跨度 ${fmtDur(spanMs)} · 非模型时间约 ${fmtDur(Math.max(0, spanMs - modelMs))}`)
  lines.push(`- 轮次 ${turnRows.length} 个（平均 ${(reqs.length / Math.max(1, turnRows.length)).toFixed(1)} 请求/轮）`)
  lines.push(`- 成本（按量牌价折算）：${fmtUsd(totalCost)}${isPlanProvider(provider) ? '（套餐 provider，此为等值成本）' : ''}${totalCost == null ? ' — 模型不在价格表，可在 ~/.zcode/context-insights/pricing.json 补充' : ''}`)
  // 窗口压力投影：取最近 ≤20 条请求的输入增量（剔除压缩骤降段）取中位，外推到窗口 80%（常见压缩触发区）
  const lastIn = reqs[reqs.length - 1].in
  const limit = contextLimitFor(model)
  const recent = reqs.slice(-20)
  const deltas = []
  for (let i = 1; i < recent.length; i++) {
    const d = (recent[i].in || 0) - (recent[i - 1].in || 0)
    if (d >= 0) deltas.push(d)
  }
  if (limit && lastIn != null && deltas.length >= 3) {
    const med = deltas.slice().sort((a, b) => a - b)[Math.floor(deltas.length / 2)]
    const target = limit * 0.8
    if (med > 0 && lastIn < target) {
      lines.push(`- 窗口压力投影：按近 ${deltas.length} 条增长节奏（中位 +${fmtTok(med)}/请求），约 ${Math.ceil((target - lastIn) / med)} 条请求后到窗口 80%（${fmtTok(target)}）`)
    } else if (lastIn >= target) {
      lines.push(`- 窗口压力投影：当前输入 ${fmtTok(lastIn)} 已超窗口 80%（${fmtTok(target)}），接近压缩触发区`)
    } else {
      lines.push(`- 窗口压力投影：近段增长停滞（中位 ${fmtTok(med)}/请求），窗口压力低`)
    }
  }
  if (topTurns.length > 1) {
    lines.push('')
    lines.push('### 最费 token 的轮次（前 5）')
    lines.push('| 轮次 | 首请求时间 | 请求 | 输入 | 输出 |')
    lines.push('|---|---|---|---|---|')
    for (const t of topTurns) lines.push(`| ${t.k === '(无 turn 标记)' ? t.k : t.k.slice(0, 18)} | ${fmtDate(t.first)} | ${t.n} | ${fmtTok(t.in)} | ${fmtTok(t.out)} |`)
  }
  lines.push('')
  lines.push(`### 逐请求走势（${reqs.length} 点）`)
  lines.push('```')
  lines.push(`输入     ${sparkline(downsample(reqs.map(r => r.in || 0)))}`)
  lines.push(`计费输入 ${sparkline(downsample(reqs.map(r => Math.max(0, (r.in || 0) - (r.cr || 0)))))}`)
  lines.push(`输出     ${sparkline(downsample(reqs.map(r => r.out || 0)))}`)
  lines.push('```')
  if (compactions.length) {
    lines.push('### 检测到上下文压缩事件')
    for (const ev of compactions.slice(-8)) lines.push(`- ${fmtDate(ev.at)}：${fmtTok(ev.from)} → ${fmtTok(ev.to)}（-${ev.pct}%）`)
  } else lines.push('未检测到输入 token 骤降（无自动压缩迹象）。')
  return lines.join('\n')
}

async function toolEvents(args = {}, idx) {
  const target = resolveSession(args.session)
  if (!target) return `未找到会话（匹配 "${args.session}"）。`
  const entry = idx.sessions[target.sid]
  const reqs = sortedReqs(entry)
  if (!reqs.length) return `${target.sid} 在索引中没有请求记录。`
  const events = []
  for (let i = 1; i < reqs.length; i++) {
    const prev = reqs[i - 1], cur = reqs[i]
    if (prev.in != null && cur.in != null && prev.in > 10000 && cur.in < prev.in * 0.6) {
      events.push({ ts: cur.ts, kind: '压缩', detail: `输入 ${fmtTok(prev.in)} → ${fmtTok(cur.in)}（-${Math.round(100 * (1 - cur.in / prev.in))}%）` })
    }
    if (prev.toolsN != null && cur.toolsN != null && prev.toolsN !== cur.toolsN) {
      const d = cur.toolsN - prev.toolsN
      events.push({ ts: cur.ts, kind: '工具集变更', detail: `工具定义 ${prev.toolsN} → ${cur.toolsN}（${d > 0 ? '+' : ''}${d}）` })
    }
    if (prev.in != null && cur.in != null && cur.in - prev.in > 30000) {
      events.push({ ts: cur.ts, kind: '大幅增长', detail: `输入 +${fmtTok(cur.in - prev.in)} → ${fmtTok(cur.in)}（本步新注入较多内容）` })
    }
  }
  const lines = [`## 上下文事件 · 会话 ${shortSid(target.sid)}（共 ${events.length} 个事件）`, '']
  if (!events.length) {
    lines.push('该会话未检测到压缩、工具集变更或单步大幅增长事件。')
    return lines.join('\n')
  }
  lines.push('| 时间 | 事件 | 详情 |')
  lines.push('|---|---|---|')
  for (const ev of events) lines.push(`| ${fmtDate(ev.ts)} | ${ev.kind} | ${ev.detail} |`)
  lines.push('')
  lines.push('> 检测口径：压缩=输入骤降>40%（前值>10k）；工具集变更=请求内工具定义数量变化（MCP/插件加载或工具搜索）；大幅增长=单步输入+30k。')
  return lines.join('\n')
}

/**
 * 家族归组（启发式，与 subagents/fleet 共用）：主会话 ±5min 时间窗 + 工作区相等或是其子路径。
 * 每个子 agent 只归属时间上第一个匹配的父会话；未匹配的进入 orphans。
 * 返回 { families: Map<父sid, {entry, pReqs, children:[{sid, reqs, entry}]}>, orphans:[{sid, reqs, entry}] }。
 */
function computeFamily(idx) {
  // 父候选按启动时间升序：子 agent 归属最早启动的匹配父会话（Map 插入序是 mtime 序，不可依赖）
  const mainsArr = Object.entries(idx.sessions)
    .filter(([sid]) => !isSub(sid) && sid !== 'no-session')
    .map(([sid, e]) => ({ sid, e, pReqs: sortedReqs(e) }))
    .filter(x => x.pReqs.length)
    .sort((a, b) => (a.pReqs[0].ts || '').localeCompare(b.pReqs[0].ts || ''))
  const families = new Map(mainsArr.map(x => [x.sid, { entry: x.e, pReqs: x.pReqs, children: [] }]))
  const orphans = []
  for (const [sid, e] of Object.entries(idx.sessions)) {
    if (!isSub(sid)) continue
    const reqs = sortedReqs(e)
    if (!reqs.length) continue
    const first = Date.parse(reqs[0].ts), last = Date.parse(reqs[reqs.length - 1].ts)
    if (isNaN(first)) continue
    let placed = false
    for (const [, fam] of families) {
      const pf = Date.parse(fam.pReqs[0].ts), pl = Date.parse(fam.pReqs[fam.pReqs.length - 1].ts)
      if (isNaN(pf) || isNaN(pl)) continue
      const overlap = first <= pl + 5 * 60_000 && last >= pf - 5 * 60_000
      const wsOk = !e.workspace || !fam.entry.workspace
        || e.workspace === fam.entry.workspace
        || e.workspace.startsWith(fam.entry.workspace.replace(/\/+$/, '') + '/')
      if (overlap && wsOk) { fam.children.push({ sid, reqs, entry: e }); placed = true; break }
    }
    if (!placed) orphans.push({ sid, reqs, entry: e })
  }
  for (const fam of families.values()) fam.children.sort((a, b) => (a.reqs[0].ts || '').localeCompare(b.reqs[0].ts || ''))
  return { families, orphans }
}

async function toolFleet(args = {}, idx) {
  // 默认取最近活跃的主会话；子 agent 归组为启发式：同工作区 + 时间窗重叠
  let parent
  if (args.session) {
    parent = resolveSession(args.session)
  } else {
    const mains = listSessions().filter(s => !isSub(s.sid) && s.sid !== 'no-session')
    parent = mains[0] || resolveSession()
  }
  if (!parent) return `未找到会话。`
  const pEntry = idx.sessions[parent.sid]
  const pReqs = sortedReqs(pEntry)
  if (!pReqs.length) return `${parent.sid} 在索引中没有请求记录。`
  // 家族归组统一走 computeFamily（与 subagents 工具同口径；每个子 agent 只归属一个父会话）
  const { families } = computeFamily(idx)
  const children = families.get(parent.sid)?.children || []
  const pCost = sum(pReqs, requestCostUsd)
  const lines = []
  lines.push(`## Agent 家族 · 主会话 ${shortSid(parent.sid)}${pEntry?.workspace ? ` · ${wsDisplay(pEntry.workspace)}` : ''}`)
  if (pEntry?.title) lines.push(`> ${cleanTitle(pEntry.title).slice(0, 80)}`)
  lines.push('')
  lines.push(`- 主会话：${pReqs.length} 次请求 · 输入 ${fmtTok(sum(pReqs, r => r.in))} · 输出 ${fmtTok(sum(pReqs, r => r.out))} · 成本 ${fmtUsd(pCost)}`)
  lines.push(`- 子 agent：${children.length} 个${children.length ? '' : '（时间窗内未发现同工作区的子 agent 会话）'}`)
  if (children.length) {
    lines.push('')
    lines.push('| 子 agent | 启动 | 请求 | 输入 | 输出 | 成本 | 模型 |')
    lines.push('|---|---|---|---|---|---|---|')
    for (const c of children) {
      const m = c.reqs[c.reqs.length - 1].model || '-'
      lines.push(`| ${shortSid(c.sid)} | ${fmtDate(c.reqs[0].ts)} | ${c.reqs.length} | ${fmtTok(sum(c.reqs, r => r.in))} | ${fmtTok(sum(c.reqs, r => r.out))} | ${fmtUsd(sum(c.reqs, requestCostUsd))} | ${m} |`)
    }
    const cAll = children.flatMap(c => c.reqs)
    lines.push('')
    lines.push(`- 家族合计：请求 ${pReqs.length + cAll.length} · 输入 ${fmtTok(sum(pReqs, r => r.in) + sum(cAll, r => r.in))} · 输出 ${fmtTok(sum(pReqs, r => r.out) + sum(cAll, r => r.out))} · 成本 ${fmtUsd(pCost + sum(cAll, requestCostUsd))}`)
  }
  lines.push('')
  lines.push('> 归组为启发式（同工作区 + 活动时间窗重叠 ±5 分钟）；ZCode rollout 未记录显式父子链接。')
  return lines.join('\n')
}

/**
 * 价格表在线刷新（唯一会发起网络请求的工具，且仅在用户显式要求时调用）：
 * 抓取 models.dev 的 zhipuai 条目写入自动层 pricing-auto.json——手写 pricing.json 优先级更高，永不被覆盖。
 */
async function toolPricingRefresh() {
  let body
  try {
    const res = await fetch('https://models.dev/api.json', { signal: AbortSignal.timeout(20000) })
    if (!res.ok) return `models.dev 拉取失败：HTTP ${res.status}`
    body = await res.json()
  } catch (e) {
    return `models.dev 拉取失败：${e.message}`
  }
  const models = {}
  for (const key of ['zhipuai', 'zhipuai-coding-plan']) {
    for (const [mid, m] of Object.entries(body?.[key]?.models || {})) {
      const cost = m.cost || {}
      const limit = m.limit?.context
      if (cost.input == null && cost.output == null && !limit) continue
      models[mid.toLowerCase()] = {
        input: cost.input ?? 0, output: cost.output ?? 0,
        cacheRead: cost.cache_read ?? 0, cacheWrite: cost.cache_write ?? 0,
        ...(limit ? { contextLimit: limit } : {}),
      }
    }
  }
  if (!Object.keys(models).length) return 'models.dev 返回中没有可用条目。'
  const dir = configDir()
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'pricing-auto.json')
  writeFileSync(file, JSON.stringify({
    $comment: `pricing_refresh 自动抓取（models.dev，${new Date().toISOString()}）。层序：内置 < 此文件 < 手写 pricing.json（手写优先，本文件不会覆盖手写条目）。`,
    models,
  }, null, 2))
  reloadPricing()
  const lines = [`## 价格表已刷新（models.dev · ${Object.keys(models).length} 条目）`, '', `- 已写入自动层 \`${file}\`（手写 \`pricing.json\` 优先级更高，未被改动）`, '- 生效示例：']
  for (const mid of ['glm-5.3', 'glm-5.3-flash']) {
    const p = priceFor(mid)
    if (p) lines.push(`  - ${mid}: 输入 ${fmtUsd(p.input)} · 输出 ${fmtUsd(p.output)} · 缓存读 ${fmtUsd(p.cacheRead)} /M · 上限 ${p.contextLimit ? fmtInt(p.contextLimit) : '-'}`)
  }
  return lines.join('\n')
}

async function toolPricingInfo() {
  const { pricingTableEntries } = await import('./lib/pricing.mjs')
  const entries = pricingTableEntries()
  const lines = ['## 价格表（每百万 token，USD）', '']
  if (!entries.length) { lines.push('价格表为空。'); return lines.join('\n') }
  lines.push('| 模型 | 输入 | 输出 | 缓存读 | 缓存写 | 上下文上限 |')
  lines.push('|---|---|---|---|---|---|')
  for (const e of entries) {
    lines.push(`| ${e.id} | ${fmtUsd(e.entry.input)} | ${fmtUsd(e.entry.output)} | ${fmtUsd(e.entry.cacheRead)} | ${fmtUsd(e.entry.cacheWrite)} | ${e.entry.contextLimit ? fmtInt(e.entry.contextLimit) : '-'} |`)
  }
  lines.push('')
  lines.push('- 计费口径：命中缓存的输入按 cacheRead 价，未命中按 input 价，输出按 output 价。')
  lines.push('- 套餐类 provider（id 含 `plan`）实际按订阅计费，工具输出中的成本为"按 API 牌价折算的等值成本"。')
  lines.push('- 数据来源：models.dev（抓取于 2026-11-08）。覆盖/新增模型：编辑 `~/.zcode/context-insights/pricing.json`，结构同上（modelId 小写为键），保存后即时生效。')
  return lines.join('\n')
}

/** 从一条请求记录抽出可搜索文本（用户消息/助手回复/工具结果）；上限 400 段防失控。 */
function extractSearchTexts(record) {
  const out = []
  const msgs = record?.request?.body?.messages
  if (Array.isArray(msgs)) {
    for (const m of msgs) {
      const role = m?.role
      const c = m?.content
      const items = typeof c === 'string' ? [{ type: 'text', text: c }] : (Array.isArray(c) ? c : [])
      for (const b of items) {
        if (b?.type === 'text' && typeof b.text === 'string') {
          if (role === 'user') out.push({ kind: 'user', text: b.text })
          else if (role === 'assistant') out.push({ kind: 'assistant', text: b.text })
        } else if (b?.type === 'tool_result') {
          const cc = b?.content
          const items2 = typeof cc === 'string' ? [{ type: 'text', text: cc }] : (Array.isArray(cc) ? cc : [])
          for (const b2 of items2) if (b2?.type === 'text' && typeof b2.text === 'string') out.push({ kind: '工具结果', text: b2.text })
        }
      }
      if (out.length > 400) break
    }
  }
  if (typeof record?.response?.text === 'string' && record.response.text) out.push({ kind: 'assistant', text: record.response.text })
  return out
}

/**
 * 跨会话全文搜索。请求体全量携带历史，同一文本会在后续每条请求重复出现——
 * 以规范化片段去重；命中映射到字节偏移所在请求的负数序号（可直接传 context_composition）。
 */
async function toolSearch(args = {}, idx) {
  const query = typeof args.query === 'string' ? args.query.trim() : ''
  if (!query) return '缺少 query 参数（要搜索的子串或正则）。'
  const useRegex = args.regex === true
  let matchLine, findAt
  if (useRegex) {
    let re
    try { re = new RegExp(query, 'u') } catch (e) { return `正则无效：${e.message}` }
    matchLine = t => re.test(t)
    findAt = text => { const m = re.exec(text); return m ? { at: m.index, len: m[0].length } : null }
  } else {
    matchLine = t => t.includes(query)
    findAt = text => text.includes(query) ? { at: text.indexOf(query), len: query.length } : null
  }
  const range = RANGES[args.range] ? args.range : '30d'
  const days = RANGES[range]
  const cutoff = days === Infinity ? 0 : Date.now() - days * 86400_000
  const wsFilter = typeof args.workspace === 'string' && args.workspace ? args.workspace.replace(/\/+$/, '') : null
  const limit = Math.min(Math.max(parseInt(args.limit) || 20, 1), 50)
  const perSession = 5
  const candidates = Object.entries(idx.sessions)
    .map(([sid, e]) => ({ sid, e, reqs: (e.requests || []).filter(r => r.ts && Date.parse(r.ts) >= cutoff) }))
    .filter(c => c.reqs.length && (!wsFilter || (c.e.workspace || '').startsWith(wsFilter)))
    .sort((a, b) => (b.reqs[b.reqs.length - 1].ts || '').localeCompare(a.reqs[a.reqs.length - 1].ts || ''))
  if (!candidates.length) return `时间范围 ${range} 内没有可搜索的会话。`
  const maxBytesTotal = parseInt(process.env.CONTEXT_INSIGHTS_SEARCH_MAX_BYTES) || 4 * 1024 ** 3
  const lines = [`## 会话内容搜索 · ${useRegex ? `正则` : `"`}${query}${useRegex ? `` : `"`}（${useRegex ? '正则模式 · ' : ''}${range}${wsFilter ? ` · 工作区 ${wsDisplay(wsFilter)}` : ''}）`, '']
  let total = 0, sessionsHit = 0, scannedBytes = 0, truncatedAny = false
  const seen = new Set()
  for (const c of candidates) {
    if (total >= limit || scannedBytes >= maxBytesTotal) break
    const info = listSessions().find(s => s.sid === c.sid)
    if (!info) continue
    const sorted = sortedReqs(c.e)
    const offs = sorted.map(r => r.off ?? 0)
    const { scannedBytes: sb, hits, truncated } = await searchSessionFile(info.file, matchLine, { maxBytes: maxBytesTotal - scannedBytes })
    scannedBytes += sb
    truncatedAny ||= truncated
    let per = 0
    for (const h of hits) {
      if (total >= limit || per >= perSession) break
      for (const t of extractSearchTexts(h.record)) {
        const found = findAt(t.text)
        if (!found) continue
        const { at, len } = found
        const snippet = (at > 0 ? '…' : '') + t.text.slice(Math.max(0, at - 60), at + len + 80).replace(/\s+/g, ' ').trim() + (at + len + 80 < t.text.length ? '…' : '')
        const dedupKey = t.kind + ':' + snippet.slice(0, 100)
        if (seen.has(dedupKey)) break
        seen.add(dedupKey)
        // 二分：行起始偏移落在哪条请求里（请求体全量含历史，取覆盖该行的请求）
        let lo = 0, hi = offs.length - 1, seq = -1
        while (lo <= hi) { const mid = (lo + hi) >> 1; if (offs[mid] <= h.lineStart) { seq = mid; lo = mid + 1 } else hi = mid - 1 }
        const reqArg = seq >= 0 ? seq - sorted.length : null
        lines.push(`- **${shortSid(c.sid)}${isSub(c.sid) ? '（子）' : ''}** · ${t.kind} · ${fmtDate(h.record.completedAt)}${reqArg != null ? ` · \`request=${reqArg}\`` : ''}`)
        lines.push(`  > ${snippet}`)
        total++; per++
        break
      }
    }
    if (per) sessionsHit++
  }
  if (!total) lines.push('没有命中。（匹配为大小写敏感的子串匹配；中文不受大小写影响。）')
  else lines.push('')
  lines.push(`> 扫描 ${candidates.length} 个候选会话 / ${fmtTok(scannedBytes / 1e6)}MB${truncatedAny ? '（达到单次扫描字节上限提前截断——可用 CONTEXT_INSIGHTS_SEARCH_MAX_BYTES 调大，或收窄 range/workspace）' : ''} · 命中 ${total} 条 / ${sessionsHit} 个会话（每会话最多 ${perSession} 条，重复内容已去重）`)
  lines.push('> 把命中行的 `request=N` 与会话 id 传给 `context_composition` 可查看该请求的完整上下文组成。')
  return lines.join('\n')
}

/** CSV 单元格：防公式注入（字符串以 =+-@\t\r 开头时加 ' 前缀）；含逗号/引号/换行时加引号并翻倍引号。数字不动。 */
const csvCell = v => {
  if (v == null) return ''
  let s = String(v)
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = "'" + s
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
}

/** 导出 CSV（会话汇总或逐请求明细）到插件配置目录的 exports/ 下；固定目录、不接受任意路径。 */
async function toolExport(args = {}, idx) {
  const kind = args.kind === 'requests' ? 'requests' : 'sessions'
  const range = RANGES[args.range] ? args.range : '30d'
  const days = RANGES[range]
  const cutoff = days === Infinity ? 0 : Date.now() - days * 86400_000
  const wsFilter = typeof args.workspace === 'string' && args.workspace ? args.workspace.replace(/\/+$/, '') : null
  const q = typeof args.query === 'string' && args.query ? args.query.toLowerCase() : null
  const sessions = Object.entries(idx.sessions)
    .filter(([sid, e]) => {
      if (wsFilter && !(e.workspace || '').startsWith(wsFilter)) return false
      if (q && ![sid, e.title, e.workspace].join(' ').toLowerCase().includes(q)) return false
      return (e.requests || []).some(r => r.ts && Date.parse(r.ts) >= cutoff)
    })
    .map(([sid, e]) => ({ sid, e, reqs: sortedReqs(e).filter(r => r.ts && Date.parse(r.ts) >= cutoff) }))
  if (!sessions.length) return `时间范围 ${range} 内没有可导出的数据。`

  let csv, rowN
  if (kind === 'sessions') {
    const head = ['session_id', 'is_subagent', 'title', 'workspace', 'first_ts', 'last_ts', 'requests', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'peak_input_tokens', 'compactions', 'last_model', 'est_cost_usd']
    const body = sessions.map(({ sid, e, reqs }) => {
      let comp = 0
      for (let i = 1; i < reqs.length; i++) {
        const prev = reqs[i - 1].in, cur = reqs[i].in
        if (prev != null && cur != null && prev > 10000 && cur < prev * 0.6) comp++
      }
      return [
        sid, isSub(sid), cleanTitle(e.title) || '', e.workspace || '',
        reqs[0]?.ts || '', reqs[reqs.length - 1]?.ts || '',
        reqs.length, sum(reqs, r => r.in), sum(reqs, r => r.out), sum(reqs, r => r.cr),
        Math.max(0, ...reqs.map(r => r.in || 0)), comp,
        reqs[reqs.length - 1]?.model || '',
        sum(reqs, requestCostUsd),
      ]
    })
    rowN = body.length
    csv = '\uFEFF' + [head, ...body].map(r => r.map(csvCell).join(',')).join('\n')
  } else {
    const head = ['session_id', 'request', 'ts', 'turn', 'model', 'provider', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'duration_ms', 'n_tool_calls', 'est_cost_usd']
    const body = []
    for (const { sid, reqs } of sessions) {
      reqs.forEach((r, i) => body.push([
        sid, i - reqs.length, r.ts || '', r.turn || '', r.model || '', r.provider || '',
        r.in ?? '', r.out ?? '', r.cr ?? '', r.cw ?? '', r.ms ?? '', (r.tools || []).length,
        requestCostUsd(r) ?? '',
      ]))
    }
    rowN = body.length
    csv = '\uFEFF' + [head, ...body].map(r => r.map(csvCell).join(',')).join('\n')
  }
  const dir = join(configDir(), 'exports')
  mkdirSync(dir, { recursive: true })
  const now = new Date()
  const stamp = `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}-${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`
  const file = join(dir, `context-insights-${kind}-${stamp}.csv`)
  writeFileSync(file, csv)
  let size = 0
  try { size = statSync(file).size } catch { /* 统计失败不影响导出结果 */ }
  const preview = csv.split('\n').slice(0, 4).map(l => l.slice(0, 120))
  return [
    `## 导出完成（${kind}）`,
    '',
    `- 文件：\`${file}\``,
    `- 数据行 ${fmtInt(rowN)} 行（另有表头）· 大小 ${fmtTok(size / 1e6)}MB · 过滤：range=${range}${wsFilter ? ` · workspace=${wsDisplay(wsFilter)}` : ''}${args.query ? ` · query="${args.query}"` : ''}`,
    '',
    '```',
    ...preview,
    '```',
    '',
    '> 带 BOM 的 UTF-8 CSV，Excel/Numbers 可直接打开；est_cost_usd 为按量牌价折算的等值成本（套餐 provider 亦同口径）。文件写入固定在 ~/.zcode/context-insights/exports/ 下。',
  ].join('\n')
}

const fmtDur = ms => {
  if (!Number.isFinite(ms) || ms < 0) return '-'
  const s = ms / 1000
  if (s < 90) return `${Math.round(s)}s`
  if (s < 5400) return `${(s / 60).toFixed(1)}分`
  return `${(s / 3600).toFixed(1)}时`
}

/** 工具调用的极简描述（实况行用，防长输出）：Bash 取命令头、文件类取路径尾、其余取主参数。 */
function describeCall(c) {
  const i = c?.input || {}
  if (c?.name === 'Bash' && typeof i.command === 'string') return `Bash(${i.command.slice(0, 48).replace(/\s+/g, ' ')})`
  if (c?.name === 'Agent') return `Agent(${(i.description || i.subagent_type || '').slice(0, 48)})`
  const f = i.file_path || i.path || i.notebook_path
  if (typeof f === 'string' && f) return `${c.name}(${f.slice(-40)})`
  if (typeof i.query === 'string' && i.query) return `${c.name}(${i.query.slice(0, 40)})`
  if (typeof i.pattern === 'string' && i.pattern) return `${c.name}(${i.pattern.slice(0, 40)})`
  if (typeof i.skill === 'string' && i.skill) return `Skill(${i.skill})`
  return `${c?.name || '?'}()`
}

/**
 * 子 agent 会话管理：注册表 + 状态推断 + 父会话归属与开销占比。
 * rollout 只是日志，MCP 无法（也不应）终止会话——"管理"定位为可见性：谁在跑、花多少、谁孤立。
 */
async function toolSubagents(args = {}, idx) {
  const { families, orphans } = computeFamily(idx)
  const childToParent = new Map()
  for (const [pid, fam] of families) for (const c of fam.children) childToParent.set(c.sid, pid)
  const statusFilter = ['running', 'recent', 'done', 'all'].includes(args.status) ? args.status : 'all'
  const parentFilter = typeof args.parent === 'string' && args.parent ? String(args.parent).toLowerCase() : null
  const wsFilter = typeof args.workspace === 'string' && args.workspace ? args.workspace.replace(/\/+$/, '') : null
  const limit = Math.min(Math.max(parseInt(args.limit) || 20, 1), 100)
  const now = Date.now()
  const rows = []
  for (const [sid, e] of Object.entries(idx.sessions)) {
    if (!isSub(sid)) continue
    const reqs = sortedReqs(e)
    if (!reqs.length) continue
    const firstTs = reqs[0].ts, lastTs = reqs[reqs.length - 1].ts
    const lastMs = lastTs ? Date.parse(lastTs) : NaN
    const status = !isNaN(lastMs) && now - lastMs < 5 * 60_000 ? '运行中' : (!isNaN(lastMs) && now - lastMs < 24 * 3600_000 ? '近24h' : '已结束')
    rows.push({
      sid,
      parent: childToParent.get(sid) || null,
      orphan: !childToParent.has(sid),
      status,
      firstTs, lastTs,
      durMs: isNaN(lastMs) ? null : lastMs - (Date.parse(firstTs) || lastMs),
      n: reqs.length,
      inTok: sum(reqs, r => r.in), outTok: sum(reqs, r => r.out),
      cost: sum(reqs, requestCostUsd),
      title: cleanTitle(e.title) || '-',
      workspace: e.workspace,
    })
  }
  const filtered = rows.filter(r =>
    (statusFilter === 'all' || (statusFilter === 'running' ? r.status === '运行中' : statusFilter === 'recent' ? r.status === '近24h' : r.status === '已结束'))
    && (!wsFilter || (r.workspace || '').startsWith(wsFilter))
    && (!parentFilter || (r.parent && r.parent.toLowerCase().includes(parentFilter))))
    .sort((a, b) => (a.status === '运行中' ? 0 : 1) - (b.status === '运行中' ? 0 : 1) || (b.lastTs || '').localeCompare(a.lastTs || ''))
    .slice(0, limit)
  const countBy = s => rows.filter(r => r.status === s).length
  const lines = []
  lines.push(`## 子 agent 会话（共 ${rows.length} 个 · 运行中 ${countBy('运行中')} · 近24h ${countBy('近24h')} · 已结束 ${countBy('已结束')} · 孤立 ${orphans.length}${statusFilter !== 'all' ? ` · 筛选 ${statusFilter}` : ''}${parentFilter ? ` · 父~${args.parent}` : ''}${wsFilter ? ` · ${wsDisplay(wsFilter)}` : ''}）`)
  lines.push('')
  if (!filtered.length) {
    lines.push(statusFilter === 'all' ? '没有子 agent 会话记录。' : '没有匹配筛选条件的子 agent 会话。')
  } else {
    lines.push('| 子agent | 父会话 | 状态 | 启动 | 时长 | 请求 | 输入 | 成本 | 任务 |')
    lines.push('|---|---|---|---|---|---|---|---|---|')
    for (const r of filtered) {
      lines.push(`| ${shortSid(r.sid)} | ${r.parent ? shortSid(r.parent) : '**孤立?**'} | ${r.status} | ${fmtDate(r.firstTs)} | ${fmtDur(r.durMs)} | ${r.n} | ${fmtTok(r.inTok)} | ${fmtUsd(r.cost)} | ${(r.title || '-').slice(0, 32).replace(/\|/g, '\\|')} |`)
    }
  }
  // 运行中实况：尾部直读最近一条请求，呈现最近动作链与 token 速度（上限 8 个，防长输出；live:false 关闭）
  if (args.live !== false && (statusFilter === 'all' || statusFilter === 'running')) {
    const running = filtered.filter(r => r.status === '运行中').slice(0, 8)
    if (running.length) {
      const fileBySid = new Map(listSessions().map(s => [s.sid, s.file]))
      lines.push('')
      lines.push('### 运行中实况（尾部直读最近一条请求）')
      for (const r of running) {
        const file = fileBySid.get(r.sid)
        const rec = file ? await tailLastLine(file) : null
        const calls = Array.isArray(rec?.response?.toolCalls) ? rec.response.toolCalls.slice(-3) : []
        const act = calls.map(describeCall).join(' → ') || (typeof rec?.response?.text === 'string' && rec.response.text ? '生成回复中' : '（暂无动作记录）')
        const mins = r.durMs ? Math.max(r.durMs / 60000, 1 / 60) : null
        const vel = mins ? `${fmtTok((r.inTok + r.outTok) / mins)} tok/分` : '-'
        const win = rec?.response?.usage?.inputTokens
        lines.push(`- **${shortSid(r.sid)}**（父 ${r.parent ? shortSid(r.parent) : '?'} · ${vel}）窗口 ${fmtTok(win)} · ${act}`)
      }
    }
  }

  // 按父会话汇总：子 agent 的开销平时是隐形的，这里给出占父会话成本的比重
  if (!parentFilter) {
    const perParent = new Map()
    for (const r of rows) {
      if (!r.parent) continue
      const d = perParent.get(r.parent) || { n: 0, cost: 0, tok: 0 }
      d.n++; d.cost += r.cost; d.tok += r.inTok + r.outTok
      perParent.set(r.parent, d)
    }
    const parentCost = new Map()
    for (const [pid, fam] of families) parentCost.set(pid, sum(fam.pReqs, requestCostUsd))
    const ranked = [...perParent.entries()]
      .map(([pid, d]) => ({ pid, ...d, pCost: parentCost.get(pid) || 0, ratio: parentCost.get(pid) ? d.cost / parentCost.get(pid) : null }))
      .sort((a, b) => b.tok - a.tok).slice(0, 6)
    if (ranked.length) {
      lines.push('')
      lines.push('### 按父会话汇总（前 6，按子 agent token）')
      lines.push('| 父会话 | 子agent数 | 子agent成本 | 父会话成本 | 子/父比 |')
      lines.push('|---|---|---|---|---|')
      for (const r of ranked) lines.push(`| ${shortSid(r.pid)} | ${r.n} | ${fmtUsd(r.cost)} | ${fmtUsd(r.pCost)} | ${r.ratio != null ? `${Math.round(100 * r.ratio)}%` : '-'} |`)
    }
  }
  lines.push('')
  lines.push('> 归组为启发式（时间窗 ±5min + 工作区相等或子路径），"孤立?" 表示未找到匹配父会话。rollout 为事后日志，无法终止运行中的会话；用 `fleet`/`context_trend` 深查单个会话。')
  return lines.join('\n')
}

const clamp01 = v => Math.max(0, Math.min(1, v))
const gradeOf = t => t == null ? '-' : t >= 85 ? 'A' : t >= 70 ? 'B' : t >= 55 ? 'C' : 'D'

/** 健康度低分维度的改进建议（口径见 scoreSession）。 */
const HEALTH_ADVICE = {
  cache: '缓存命中率偏低：检查是否有大量非缓存前缀变化（工具集抖动、频繁 system 注入），或超大工具结果挤掉缓存段',
  window: '峰值窗口占比偏高：及时 /compact 或拆分会话，避免长会话单窗口堆积',
  compaction: '压缩频繁：单步注入内容过大（整读网页/文件），考虑收窄任务颗粒度或让大输出先落盘再引用',
  efficiency: '输出/计费输入比偏低：重复上下文回放占比大，减少无效工具往返可提升',
}

/**
 * 单会话健康度评分（启发式）：缓存效率 35% / 窗口纪律 25% / 压缩频率 20% / 成本效率 20%。
 * 数据不足的维度记 N/A 并按剩余权重重分配；压缩判定与 context_events 同口径。
 */
function scoreSession(reqs, modelId) {
  const n = reqs.length
  const inTok = sum(reqs, r => r.in), cr = sum(reqs, r => r.cr), outTok = sum(reqs, r => r.out)
  const peak = Math.max(0, ...reqs.map(r => r.in || 0))
  let comp = 0
  for (let i = 1; i < n; i++) {
    const prev = reqs[i - 1].in, cur = reqs[i].in
    if (prev != null && cur != null && prev > 10000 && cur < prev * 0.6) comp++
  }
  const parts = {}
  if (inTok >= 10000) {
    const hitRate = cr / inTok
    parts.cache = { score: Math.round(clamp01(hitRate / 0.9) * 100), weight: 0.35, detail: `命中率 ${(100 * hitRate).toFixed(1)}%` }
  }
  const limit = contextLimitFor(modelId)
  if (limit) {
    const pressure = peak / limit
    parts.window = { score: pressure <= 0.5 ? 100 : Math.round(clamp01(1 - (pressure - 0.5) * 2) * 100), weight: 0.25, detail: `峰值 ${fmtTok(peak)} / ${fmtTok(limit)}（${Math.round(100 * pressure)}%）` }
  }
  if (n >= 3) {
    const per100 = comp / n * 100
    parts.compaction = { score: Math.round(clamp01(1 - per100 / 5) * 100), weight: 0.2, detail: `${fmtInt(comp)} 次 / ${n} 请求（${per100.toFixed(1)}/百请求）` }
  }
  const billed = Math.max(0, inTok - cr)
  if (billed >= 1000) {
    const eff = outTok / billed
    parts.efficiency = { score: Math.round(clamp01(eff / 1.25) * 100), weight: 0.2, detail: `输出/计费输入 ${eff.toFixed(2)}` }
  }
  const wsum = Object.values(parts).reduce((s, p) => s + p.weight, 0)
  const total = wsum ? Math.round(Object.values(parts).reduce((s, p) => s + p.score * p.weight, 0) / wsum) : null
  return { total, parts, metrics: { n, inTok, outTok, cr, peak, comp, billed, limit } }
}

/** 会话健康度：单会话诊断（默认最近活跃）或范围内排名（最差优先，actionable）。 */
async function toolHealth(args = {}, idx) {
  const range = RANGES[args.range] ? args.range : '30d'
  const days = RANGES[range]
  const cutoff = days === Infinity ? 0 : Date.now() - days * 86400_000
  const reqsInRange = entry => sortedReqs(entry).filter(r => r.ts && Date.parse(r.ts) >= cutoff)

  if (args.session) {
    const target = resolveSession(args.session)
    if (!target) return `未找到会话（匹配 "${args.session}"）。`
    const reqs = reqsInRange(idx.sessions[target.sid])
    if (!reqs.length) return `${target.sid} 在 ${range} 内没有请求记录。`
    const lastModel = reqs[reqs.length - 1].model
    const sc = scoreSession(reqs, lastModel)
    const lines = []
    lines.push(`## 会话健康度 · ${shortSid(target.sid)}（${range}）`)
    if (entryTitleOf(idx.sessions[target.sid])) lines.push(`> ${entryTitleOf(idx.sessions[target.sid]).slice(0, 80)}`)
    lines.push('')
    if (sc.total == null) {
      lines.push('数据不足，无法评分（需要模型上限或更多请求）。')
      return lines.join('\n')
    }
    lines.push(`**总分 ${sc.total}/100 · 评级 ${gradeOf(sc.total)}**`)
    lines.push('')
    lines.push('| 维度 | 得分 | 权重 | 依据 |')
    lines.push('|---|---|---|---|')
    const zh = { cache: '缓存效率', window: '窗口纪律', compaction: '压缩频率', efficiency: '成本效率' }
    for (const [k, p] of Object.entries(sc.parts)) lines.push(`| ${zh[k]} | ${p.score} | ${Math.round(p.weight * 100)}% | ${p.detail} |`)
    lines.push('')
    const weak = Object.entries(sc.parts).filter(([, p]) => p.score < 70).sort((a, b) => a[1].score - b[1].score)
    if (weak.length) {
      lines.push('建议：')
      for (const [k] of weak) lines.push(`- ${HEALTH_ADVICE[k]}`)
    } else lines.push('各维度均健康，保持当前节奏。')
    lines.push('')
    lines.push('> 评分为启发式：缓存满赞=90%+；窗口压力≤50% 满赞、100% 零分；压缩 ≤1/百请求 满赞、≥5/百请求 零分；成本效率=输出/计费输入，1.25+ 满赞。数据不足的维度按剩余权重重分配。')
    return lines.join('\n')
  }

  // 排名模式：范围内全部会话，最差优先
  const wsFilter = typeof args.workspace === 'string' && args.workspace ? args.workspace.replace(/\/+$/, '') : null
  const limitN = Math.min(Math.max(parseInt(args.limit) || 10, 1), 50)
  const rows = []
  for (const [sid, e] of Object.entries(idx.sessions)) {
    if (wsFilter && !(e.workspace || '').startsWith(wsFilter)) continue
    const reqs = reqsInRange(e)
    if (reqs.length < 3) continue
    const sc = scoreSession(reqs, reqs[reqs.length - 1].model)
    if (sc.total == null) continue
    rows.push({ sid, ws: e.workspace, total: sc.total, parts: sc.parts, tok: sc.metrics.inTok + sc.metrics.outTok })
  }
  if (!rows.length) return `时间范围 ${range} 内没有可评分的会话（≥3 条请求）。`
  const avg = Math.round(rows.reduce((s, r) => s + r.total, 0) / rows.length)
  const lines = []
  lines.push(`## 会话健康度排名（${range}${wsFilter ? ` · 工作区 ${wsDisplay(wsFilter)}` : ''} · 共 ${rows.length} 个 · 平均 ${avg}）`)
  lines.push('')
  lines.push('### 最差前 ' + Math.min(limitN, rows.length) + '（优先治理）')
  lines.push('| 会话 | 总分 | 评级 | 缓存 | 窗口 | 压缩 | 成本效率 | token |')
  lines.push('|---|---|---|---|---|---|---|---|')
  const cell = (p, k) => p[k] ? p[k].score : '-'
  for (const r of [...rows].sort((a, b) => a.total - b.total).slice(0, limitN)) {
    lines.push(`| ${shortSid(r.sid)}${isSub(r.sid) ? '（子）' : ''} | ${r.total} | ${gradeOf(r.total)} | ${cell(r.parts, 'cache')} | ${cell(r.parts, 'window')} | ${cell(r.parts, 'compaction')} | ${cell(r.parts, 'efficiency')} | ${fmtTok(r.tok)} |`)
  }
  lines.push('')
  lines.push(`### 最优前 3`)
  lines.push('| 会话 | 总分 | 评级 |')
  lines.push('|---|---|---|')
  for (const r of [...rows].sort((a, b) => b.total - a.total).slice(0, 3)) lines.push(`| ${shortSid(r.sid)}${isSub(r.sid) ? '（子）' : ''} | ${r.total} | ${gradeOf(r.total)} |`)
  lines.push('')
  lines.push('> 单会话诊断传 session 参数；评分口径为启发式（详见单会话输出）。')
  return lines.join('\n')
}

/** 尾部直读最后一条请求，取最后一条真实用户消息（剥 reminder/markdown 链接，折叠空白）；tool_result 型 user 消息自动跳过。 */
async function lastUserMessageOf(file) {
  const rec = await tailLastLine(file)
  const msgs = rec?.request?.body?.messages
  if (!Array.isArray(msgs)) return null
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]
    if (m?.role !== 'user') continue
    const c = m.content
    const texts = typeof c === 'string' ? [c] : (Array.isArray(c) ? c.filter(b => b?.type === 'text').map(b => b.text) : [])
    for (const t of texts) {
      const clean = t.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\s+/g, ' ').trim()
      if (clean) return clean
    }
  }
  return null
}

/** 会话速览：一段话回答"这个会话干了啥"——标题/跨度/账本/子 agent/最后在做什么，索引内计算 + 尾读一条。 */
async function toolDigest(args = {}, idx) {
  // 批量速览：recent=N 时输出最近 N 个主会话的紧凑速览（每会话 2-3 行）；省略则单会话详览
  const recentN = Math.min(Math.max(parseInt(args.recent) || 0, 0), 20)
  if (recentN > 0) return digestRecent(recentN, idx)
  const target = resolveSession(args.session)
  if (!target) return `未找到会话${args.session ? `（匹配 "${args.session}"）` : ''}。`
  const entry = idx.sessions[target.sid]
  const reqs = sortedReqs(entry)
  if (!reqs.length) return `${target.sid} 在索引中没有请求记录。`
  const lastModel = reqs[reqs.length - 1].model
  const sc = scoreSession(reqs, lastModel)
  // 会话内账本（ops 摘要）
  const toolL = new Map(), fileL = new Map(), cmdL = new Map()
  const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'NotebookRead', 'mcp__web_reader__webReader'])
  for (const r of reqs) {
    for (const t of r.tools || []) toolL.set(t, (toolL.get(t) || 0) + 1)
    for (const op of r.ops || []) {
      if (op.f != null) {
        const d = fileL.get(op.f) || { reads: 0, writes: 0 }
        if (READ_TOOLS.has(op.n)) d.reads++
        else if (op.n === 'Edit' || op.n === 'Write' || op.n === 'NotebookEdit') d.writes++
        else d.other = (d.other || 0) + 1
        fileL.set(op.f, d)
      } else if (op.c != null) {
        let prog = ''
        for (const t of op.c.trim().split(/\s+/)) { if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) continue; prog = t; break }
        const base = (prog.replace(/^['"]|['"]$/g, '').split('/').pop()) || prog
        cmdL.set(base, (cmdL.get(base) || 0) + 1)
      }
    }
  }
  // 子 agent（仅主会话）
  let subInfo = null
  if (!isSub(target.sid)) {
    const { families } = computeFamily(idx)
    const fam = families.get(target.sid)
    if (fam && fam.children.length) subInfo = { n: fam.children.length, cost: sum(fam.children.flatMap(c => c.reqs), requestCostUsd) }
  }
  // 最后一条用户消息（尾部直读）
  const lastUser = await lastUserMessageOf(target.file)
  const turns = new Set(reqs.map(r => r.turn).filter(Boolean)).size
  const first = reqs[0].ts, last = reqs[reqs.length - 1].ts
  const dur = (Date.parse(last) - Date.parse(first)) || null
  const lines = []
  lines.push(`## 会话速览 · ${shortSid(target.sid)}${isSub(target.sid) ? '（子）' : ''}`)
  if (entryTitleOf(entry)) lines.push(`> ${entryTitleOf(entry).slice(0, 100)}`)
  lines.push('')
  lines.push(`- ${wsDisplay(entry.workspace)} · \`${lastModel || '?'}\` · ${fmtDate(first)} → ${fmtDate(last)}（${fmtDur(dur)} · ${turns || '?'} 轮 / ${reqs.length} 请求）`)
  lines.push(`- 输入 ${fmtTok(sc.metrics.inTok)} · 输出 ${fmtTok(sc.metrics.outTok)} · 缓存命中 ${sc.metrics.inTok ? (100 * sc.metrics.cr / sc.metrics.inTok).toFixed(1) + '%' : 'N/A'} · 峰值窗口 ${fmtTok(sc.metrics.peak)} · 成本 ${fmtUsd(sum(reqs, requestCostUsd))} · 压缩 ${sc.metrics.comp} 次${sc.total != null ? ` · 健康度 ${sc.total}（${gradeOf(sc.total)}）` : ''}`)
  if (subInfo) lines.push(`- 子 agent ${subInfo.n} 个（成本 ${fmtUsd(subInfo.cost)}）`)
  const topTools = [...toolL.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
  if (topTools.length) lines.push(`- 常用工具：${topTools.map(([t, n]) => `${t}×${n}`).join('、')}`)
  const topFiles = [...fileL.entries()].map(([f, d]) => [f, d.reads + d.writes + (d.other || 0), d]).sort((a, b) => b[1] - a[1]).slice(0, 5)
  if (topFiles.length) lines.push(`- 触碰文件：${topFiles.map(([f, n, d]) => `${homePath(f).split('/').pop()}(读${d.reads}/写${d.writes})`).join('、')}`)
  const topCmds = [...cmdL.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
  if (topCmds.length) lines.push(`- 常跑命令：${topCmds.map(([c, n]) => `${c}×${n}`).join('、')}`)
  if (lastUser) {
    lines.push('')
    lines.push('### 最近在做什么')
    lines.push(`> ${lastUser}`)
  }
  lines.push('')
  lines.push('> 深入：`context_trend`（走势/投影）· `context_composition`（组成）· `context_events`（事件）。')
  return lines.join('\n')
}

/** 批量速览：最近 N 个主会话的紧凑摘要（回顾"最近都干了啥"）。 */
async function digestRecent(n, idx) {
  const mains = listSessions().filter(s => !isSub(s.sid) && s.sid !== 'no-session')
  const { families } = computeFamily(idx)
  const rows = []
  for (const info of mains) {
    const e = idx.sessions[info.sid]
    if (!e) continue
    const reqs = sortedReqs(e)
    if (!reqs.length) continue
    rows.push({ info, e, reqs })
    if (rows.length >= n) break
  }
  if (!rows.length) return '没有可速览的会话。'
  const lines = [`## 最近会话速览（前 ${rows.length}，按最近活跃）`, '']
  for (const r of rows) {
    const sc = scoreSession(r.reqs, r.reqs[r.reqs.length - 1].model)
    const dur = (Date.parse(r.reqs[r.reqs.length - 1].ts) - Date.parse(r.reqs[0].ts)) || null
    const turns = new Set(r.reqs.map(x => x.turn).filter(Boolean)).size
    const title = entryTitleOf(r.e)
    const lu = await lastUserMessageOf(r.info.file)
    const toolL = new Map()
    for (const x of r.reqs) for (const t of x.tools || []) toolL.set(t, (toolL.get(t) || 0) + 1)
    const topT = [...toolL.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([t, c]) => `${t}×${c}`).join('、')
    const fam = families.get(r.info.sid)
    const sub = fam && fam.children.length ? `子agent ${fam.children.length} 个（${fmtUsd(sum(fam.children.flatMap(c => c.reqs), requestCostUsd))}）` : null
    lines.push(`**${shortSid(r.info.sid)}** · ${fmtDur(dur)} · ${turns || '?'}轮/${r.reqs.length}请求 · 输入 ${fmtTok(sum(r.reqs, x => x.in))} · 成本 ${fmtUsd(sum(r.reqs, requestCostUsd))}${sc.total != null ? ` · 健康 ${sc.total}（${gradeOf(sc.total)}）` : ''}`)
    lines.push(`  > ${(title || '-').slice(0, 60)}${lu ? ` ｜ 最近: ${lu.slice(0, 60)}` : ''}`)
    const meta = [sub, topT ? `工具 ${topT}` : null].filter(Boolean).join(' ｜ ')
    if (meta) lines.push(`  ${meta}`)
  }
  lines.push('')
  lines.push('> 单会话详情：`session_digest {session}`；家族视图：`fleet`。')
  return lines.join('\n')
}

/** 会话对比：两个会话的指标并排表（缺省取两个最近活跃的主会话）。 */
async function toolCompare(args = {}, idx) {
  const mains = listSessions().filter(s => !isSub(s.sid) && s.sid !== 'no-session')
  const a = args.sessionA ? resolveSession(args.sessionA) : mains[0] || null
  const b = args.sessionB ? resolveSession(args.sessionB) : mains.find(s => s.sid !== a?.sid) || null
  if (!a || !b || a.sid === b.sid) return `需要两个不同的会话。可传 sessionA/sessionB（id 片段）；缺省取两个最近活跃的主会话。`
  const statsOf = sid => {
    const reqs = sortedReqs(idx.sessions[sid])
    if (!reqs.length) return null
    const sc = scoreSession(reqs, reqs[reqs.length - 1].model)
    const toolL = new Map()
    for (const r of reqs) for (const t of r.tools || []) toolL.set(t, (toolL.get(t) || 0) + 1)
    return {
      first: reqs[0].ts, last: reqs[reqs.length - 1].ts, model: reqs[reqs.length - 1].model,
      n: reqs.length, turns: new Set(reqs.map(r => r.turn).filter(Boolean)).size,
      dur: (Date.parse(reqs[reqs.length - 1].ts) - Date.parse(reqs[0].ts)) || null,
      inTok: sc.metrics.inTok, outTok: sc.metrics.outTok, cr: sc.metrics.cr, peak: sc.metrics.peak, comp: sc.metrics.comp,
      cost: sum(reqs, requestCostUsd), health: sc.total,
      tools: [...toolL.entries()].sort((x, y) => y[1] - x[1]).slice(0, 3).map(([t, c]) => `${t}×${c}`).join('、'),
    }
  }
  const sa = statsOf(a.sid), sb = statsOf(b.sid)
  if (!sa || !sb) return `所选会话在索引中没有请求记录。`
  const { families } = computeFamily(idx)
  const subInfo = sid => {
    const f = families.get(sid)
    return f && f.children.length ? `${f.children.length} 个（${fmtUsd(sum(f.children.flatMap(c => c.reqs), requestCostUsd))}）` : null
  }
  const hit = s => s.inTok ? `${(100 * s.cr / s.inTok).toFixed(1)}%` : 'N/A'
  const lines = []
  lines.push('## 会话对比')
  lines.push(`> A: ${(entryTitleOf(idx.sessions[a.sid]) || '-').slice(0, 60)}`)
  lines.push(`> B: ${(entryTitleOf(idx.sessions[b.sid]) || '-').slice(0, 60)}`)
  lines.push('')
  lines.push(`| 指标 | A（${shortSid(a.sid)}） | B（${shortSid(b.sid)}） |`)
  lines.push('|---|---|---|')
  const row = (k, va, vb) => lines.push(`| ${k} | ${va} | ${vb} |`)
  row('工作区', wsDisplay(idx.sessions[a.sid]?.workspace), wsDisplay(idx.sessions[b.sid]?.workspace))
  row('模型', sa.model || '-', sb.model || '-')
  row('时间跨度', `${fmtDate(sa.first)} → ${fmtDate(sa.last)}（${fmtDur(sa.dur)}）`, `${fmtDate(sb.first)} → ${fmtDate(sb.last)}（${fmtDur(sb.dur)}）`)
  row('轮次/请求', `${sa.turns || '?'}/${sa.n}`, `${sb.turns || '?'}/${sb.n}`)
  row('输入 / 输出', `${fmtTok(sa.inTok)} / ${fmtTok(sa.outTok)}`, `${fmtTok(sb.inTok)} / ${fmtTok(sb.outTok)}`)
  row('缓存命中率', hit(sa), hit(sb))
  row('峰值窗口', fmtTok(sa.peak), fmtTok(sb.peak))
  row('压缩次数', String(sa.comp), String(sb.comp))
  row('成本折算', fmtUsd(sa.cost), fmtUsd(sb.cost))
  row('健康度', sa.health != null ? `${sa.health}（${gradeOf(sa.health)}）` : '-', sb.health != null ? `${sb.health}（${gradeOf(sb.health)}）` : '-')
  row('子 agent', subInfo(a.sid) || '-', subInfo(b.sid) || '-')
  row('常用工具', sa.tools || '-', sb.tools || '-')
  lines.push('')
  lines.push('> 健康度口径见 `context_health`；单会话深查用 `context_trend` / `session_digest`。')
  return lines.join('\n')
}

/** 索引条目标题（清洗后）。 */
function entryTitleOf(entry) {
  return typeof entry?.title === 'string' ? cleanTitle(entry.title) : null
}

const RANGES = { today: 1, '7d': 7, '30d': 30, all: Infinity }

async function toolInsights(args = {}, idx) {
  const range = RANGES[args.range] ? args.range : '7d'
  // brief 模式：只出 KPI/模型/工作区/会话榜，跳过每日柱、热力图、小时分布与四类账本——避免长报告挤占会话窗口
  const brief = args.brief === true
  const days = RANGES[range]
  const cutoff = days === Infinity ? 0 : Date.now() - days * 86400_000
  const wsFilter = typeof args.workspace === 'string' && args.workspace ? args.workspace.replace(/\/+$/, '') : null
  const q = typeof args.query === 'string' && args.query ? args.query.toLowerCase() : null
  const rows = []
  for (const [sid, entry] of Object.entries(idx.sessions)) {
    if (wsFilter && !(entry.workspace || '').startsWith(wsFilter)) continue
    if (q && ![sid, entry.title, entry.workspace].join(' ').toLowerCase().includes(q)) continue
    const reqs = (entry.requests || []).filter(r => {
      const t = r.ts ? Date.parse(r.ts) : 0
      return t >= cutoff
    })
    if (reqs.length) rows.push({ sid, ...entry, reqs })
  }
  if (!rows.length) return `时间范围 ${range}${wsFilter ? ` · 工作区 ${wsFilter}` : ''}${q ? ` · 搜索 "${args.query}"` : ''} 内没有请求记录。`
  const allReqs = rows.flatMap(r => r.reqs)
  const inTok = sum(allReqs, r => r.in), outTok = sum(allReqs, r => r.out), cr = sum(allReqs, r => r.cr)
  const totalCost = sum(allReqs, requestCostUsd)
  const priced = allReqs.filter(r => priceFor(r.model))
  // 缓存省钱额：无缓存等值成本 = 全部输入按 input 牌价；实际成本走 requestCostUsd（命中按 cacheRead 价）
  const noCacheCost = sum(priced, r => {
    const p = priceFor(r.model)
    return ((r.in || 0) * (p.input || 0) + (r.out || 0) * (p.output || 0)) / 1e6
  })
  const modelMs = sum(allReqs, r => r.ms)
  const tsAll = allReqs.map(r => r.ts).filter(Boolean).sort()
  const spanMs = tsAll.length > 1 ? Date.parse(tsAll[tsAll.length - 1]) - Date.parse(tsAll[0]) : 0
  // 压缩事件（与 context_events 同口径）按会话统计
  let compEvents = 0, compSessions = 0
  for (const r of rows) {
    const reqs = sortedReqs({ requests: r.reqs })
    let n = 0
    for (let i = 1; i < reqs.length; i++) {
      const prev = reqs[i - 1].in, cur = reqs[i].in
      if (prev != null && cur != null && prev > 10000 && cur < prev * 0.6) n++
    }
    if (n) { compEvents += n; compSessions++ }
  }
  const lines = []
  lines.push(`## 上下文洞察（${range}${wsFilter ? ` · 工作区 ${wsDisplay(wsFilter)}` : ''}${q ? ` · "${args.query}"` : ''}）`)
  lines.push('')
  lines.push(`- 会话 ${rows.length} 个（子 agent ${rows.filter(r => isSub(r.sid)).length} 个）· 请求 ${allReqs.length} 次`)
  lines.push(`- 输入 ${fmtTok(inTok)} · 输出 ${fmtTok(outTok)} · 缓存命中 ${fmtTok(cr)}（命中率 ${inTok ? (100 * cr / inTok).toFixed(1) : 'N/A'}%）`)
  lines.push(`- 成本折算 ${fmtUsd(totalCost)}${priced.length < allReqs.length ? `（${allReqs.length - priced.length} 次请求的模型不在价格表，未计价）` : ''}`
    + (noCacheCost > 0 && totalCost != null ? ` · 缓存省钱 ${fmtUsd(noCacheCost - totalCost)}（无缓存等值 ${fmtUsd(noCacheCost)}，省 ${noCacheCost > 0 ? Math.round(100 * (1 - totalCost / noCacheCost)) : 0}%）` : ''))
  lines.push(`- 工具执行 ${fmtInt(sum(allReqs, r => (r.tools || []).length))} 次 · 模型耗时 ${fmtDur(modelMs)} · 活动跨度 ${fmtDur(spanMs)}（非模型时间约 ${fmtDur(Math.max(0, spanMs - modelMs))}）`)
  lines.push(`- 上下文压缩 ${fmtInt(compEvents)} 次（涉及 ${compSessions} 个会话）`)
  lines.push('')

  // 模型分布
  const byModel = new Map()
  for (const r of allReqs) {
    const d = byModel.get(r.model) || { n: 0, in: 0, out: 0, cr: 0, cost: 0, provider: r.provider }
    d.n++; d.in += r.in || 0; d.out += r.out || 0; d.cr += r.cr || 0; d.cost += requestCostUsd(r) || 0
    byModel.set(r.model, d)
  }
  const models = [...byModel.entries()].sort((a, b) => b[1].cost - a[1].cost || b[1].in - a[1].in)
  lines.push('### 模型分布')
  lines.push('| 模型 | provider | 请求 | 输入 | 输出 | 缓存命中 | 成本折算 |')
  lines.push('|---|---|---|---|---|---|---|')
  for (const [m, d] of models) lines.push(`| ${m ?? 'N/A'} | ${d.provider ?? '-'}${isPlanProvider(d.provider) ? '（套餐）' : ''} | ${d.n} | ${fmtTok(d.in)} | ${fmtTok(d.out)} | ${fmtTok(d.cr)} | ${fmtUsd(d.cost)} |`)

  // 工作区分布：哪个项目最费
  const byWs = new Map()
  for (const r of rows) {
    const key = r.workspace || '(未知)'
    const d = byWs.get(key) || { sessions: 0, reqs: 0, tok: 0, cost: 0 }
    d.sessions++; d.reqs += r.reqs.length; d.tok += sum(r.reqs, x => (x.in || 0) + (x.out || 0)); d.cost += sum(r.reqs, requestCostUsd)
    byWs.set(key, d)
  }
  const wsTop = [...byWs.entries()].sort((a, b) => b[1].tok - a[1].tok).slice(0, 8)
  lines.push('')
  lines.push('### 工作区分布（前 8，按 token）')
  lines.push('| 工作区 | 会话 | 请求 | token | 成本折算 |')
  lines.push('|---|---|---|---|---|')
  for (const [ws, d] of wsTop) lines.push(`| ${wsDisplay(ws)} | ${d.sessions} | ${d.reqs} | ${fmtTok(d.tok)} | ${fmtUsd(d.cost)} |`)

  // 每日用量（最近 7 个有数据的日子）
  const daily = new Map()
  for (const r of allReqs) {
    if (!r.ts) continue
    const day = localDayKey(r.ts)
    const d = daily.get(day) || { tok: 0, cost: 0 }
    d.tok += (r.in || 0) + (r.out || 0)
    d.cost += requestCostUsd(r) || 0
    daily.set(day, d)
  }
  const days7 = [...daily.entries()].sort((a, b) => a[0].localeCompare(b[0])).slice(-7)
  if (!brief && days7.length) {
    lines.push('')
    lines.push('### 每日用量（近 7 个活跃日）')
    lines.push('```')
    const maxTok = Math.max(...days7.map(([, d]) => d.tok), 1)
    for (const [day, d] of days7) {
      const bar = '█'.repeat(Math.max(1, Math.round(30 * d.tok / maxTok)))
      lines.push(`${day} ${bar} ${fmtTok(d.tok)} tok ${fmtUsd(d.cost)}`)
    }
    lines.push('```')
  }

  // 8 周活动热力图（真实日历排布，按窗口内最大日 token 归一；无数据日显示 ·）
  if (!brief && daily.size > 7) {
    const maxDayTok = Math.max(...[...daily.values()].map(d => d.tok), 1)
    const blocks = '▁▂▃▄▅▆▇█'
    const cell = d => d == null ? '·' : blocks[Math.min(7, Math.floor(8 * d.tok / maxDayTok))]
    // 从最后一个有数据的日子（本地日期）往前取 55 天，补齐日历
    const lastDay = [...daily.keys()].sort().pop()
    const cells = []
    const cursor = new Date(lastDay + 'T00:00:00')
    cursor.setDate(cursor.getDate() - 55)
    for (let i = 0; i < 56; i++) {
      const key = localDayKey(cursor)
      cells.push(cell(daily.get(key)?.tok))
      cursor.setDate(cursor.getDate() + 1)
    }
    lines.push('')
    lines.push('### 活动热力图（近 8 周 · 每行一周，▁→█ 递增，· 无数据）')
    lines.push('```')
    for (let w = 0; w < 56; w += 7) lines.push(cells.slice(w, w + 7).join(''))
    lines.push('```')
  }

  // 小时分布（本机时区）：什么时段在干活
  const hourly = new Array(24).fill(0)
  for (const r of allReqs) {
    if (!r.ts) continue
    const h = new Date(r.ts).getHours()
    if (h >= 0 && h < 24) hourly[h] += (r.in || 0) + (r.out || 0)
  }
  if (!brief && hourly.some(v => v > 0)) {
    const maxH = Math.max(...hourly, 1)
    lines.push('')
    lines.push('### 小时分布（本机时区，按 token）')
    lines.push('```')
    for (let h = 0; h < 24; h += 12) {
      const seg = hourly.slice(h, h + 12)
      lines.push(`${String(h).padStart(2, '0')}-${String(h + 11).padStart(2, '0')}时 ` + seg.map(v => {
        const blocks = '▁▂▃▄▅▆▇█'
        return v === 0 ? '·' : blocks[Math.min(7, Math.floor(8 * v / maxH))]
      }).join(''))
    }
    const peakHour = hourly.indexOf(Math.max(...hourly))
    lines.push(`峰值时段 ${String(peakHour).padStart(2, '0')}:00（${fmtTok(hourly[peakHour])} tok）`)
    lines.push('```')
  }

  // 会话榜
  const top = rows.map(r => ({
    sid: r.sid, workspace: r.workspace, title: r.title, n: r.reqs.length,
    tok: sum(r.reqs, x => (x.in || 0) + (x.out || 0)),
    cost: sum(r.reqs, requestCostUsd),
    last: r.reqs.map(x => x.ts).filter(Boolean).sort().pop(),
  })).sort((a, b) => b.tok - a.tok).slice(0, 10)
  lines.push('')
  lines.push('### 会话榜（按 token，前 10）')
  lines.push('| 会话 | 工作区 | 请求 | token | 成本 | 最近活跃 |')
  lines.push('|---|---|---|---|---|---|')
  for (const t of top) lines.push(`| ${shortSid(t.sid)}${isSub(t.sid) ? '（子）' : ''} | ${wsDisplay(t.workspace)} | ${t.n} | ${fmtTok(t.tok)} | ${fmtUsd(t.cost)} | ${fmtDate(t.last)} |`)

  // 各类账本（工具/技能/文件/命令）
  const toolLedger = new Map()
  const skillLedger = new Map()
  const fileLedger = new Map()
  const cmdLedger = new Map()
  const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'NotebookRead', 'mcp__web_reader__webReader'])
  for (const r of allReqs) {
    for (const t of r.tools || []) toolLedger.set(t, (toolLedger.get(t) || 0) + 1)
    for (const op of r.ops || []) {
      if (op.f != null) {
        const d = fileLedger.get(op.f) || { reads: 0, writes: 0, other: 0 }
        if (READ_TOOLS.has(op.n)) d.reads++
        else if (op.n === 'Edit' || op.n === 'Write' || op.n === 'NotebookEdit') d.writes++
        else d.other++
        fileLedger.set(op.f, d)
      } else if (op.k != null) {
        const d = skillLedger.get(op.k) || { n: 0, last: r.ts }
        d.n++; d.last = r.ts
        skillLedger.set(op.k, d)
      } else if (op.c != null) {
        // 取首个非环境变量前缀的词作为程序名
        const toks = op.c.trim().split(/\s+/)
        let prog = ''
        for (const t of toks) {
          if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) continue
          prog = t; break
        }
        prog = prog.replace(/^['"]|['"]$/g, '')
        const base = prog.split('/').pop() || prog
        const d = cmdLedger.get(base) || { n: 0, example: op.c.slice(0, 60) }
        d.n++
        cmdLedger.set(base, d)
      }
    }
  }
  const ledger = (title, entries, fmt) => {
    if (!entries.length) return
    lines.push('')
    lines.push(`### ${title}`)
    lines.push('```')
    for (const row of entries) lines.push(fmt(row))
    lines.push('```')
  }
  if (!brief) {
    ledger('工具调用账本（前 15）', [...toolLedger.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15),
      ([name, n]) => `${name.padEnd(28)} ${fmtInt(n)}`)
    ledger('技能加载（前 10）', [...skillLedger.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 10),
      ([k, d]) => `${k.padEnd(28)} ${fmtInt(d.n)} 次 · 最近 ${fmtDate(d.last)}`)
    ledger('文件活动（前 12，读/写/其他）', [...fileLedger.entries()].map(([f, d]) => [f, d, d.reads + d.writes + d.other]).sort((a, b) => b[2] - a[2]).slice(0, 12),
      ([f, d]) => `${homePath(f).slice(-64).padStart(64)} 读${d.reads} 写${d.writes}${d.other ? ` 他${d.other}` : ''}`)
    ledger('命令执行（按程序，前 12）', [...cmdLedger.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 12),
      ([p, d]) => `${p.padEnd(20)} ${fmtInt(d.n)} 次 · 例：${d.example}`)
  }
  return lines.join('\n')
}

async function toolSessionList(args = {}, idx) {
  const limit = Math.min(Math.max(parseInt(args.limit) || 15, 1), 100)
  const range = RANGES[args.range] ? args.range : 'all'
  const days = RANGES[range]
  const cutoff = days === Infinity ? 0 : Date.now() - days * 86400_000
  const wsFilter = typeof args.workspace === 'string' && args.workspace ? args.workspace.replace(/\/+$/, '') : null
  const q = typeof args.query === 'string' && args.query ? args.query.toLowerCase() : null
  const rows = Object.entries(idx.sessions)
    .filter(([sid, e]) => {
      if (wsFilter && !(e.workspace || '').startsWith(wsFilter)) return false
      if (q && ![sid, e.title, e.workspace].join(' ').toLowerCase().includes(q)) return false
      return (e.requests || []).some(r => r.ts && Date.parse(r.ts) >= cutoff)
    })
    .map(([sid, e]) => {
      const reqs = sortedReqs(e).filter(r => r.ts && Date.parse(r.ts) >= cutoff)
      return {
        sid, workspace: e.workspace, title: e.title,
        n: reqs.length,
        tok: sum(reqs, r => (r.in || 0) + (r.out || 0)),
        peak: Math.max(0, ...reqs.map(r => r.in || 0)),
        last: reqs.map(r => r.ts).filter(Boolean).sort().pop(),
        model: reqs.length ? reqs[reqs.length - 1].model : null,
      }
    })
    .filter(r => r.n > 0).sort((a, b) => (b.last || '').localeCompare(a.last || '')).slice(0, limit)
  if (!rows.length) return `索引中没有匹配的会话${args.range || args.workspace || args.query ? `（range=${args.range || 'all'}${wsFilter ? ` · workspace=${wsDisplay(wsFilter)}` : ''}${args.query ? ` · query="${args.query}"` : ''}）` : ''}。`
  const lines = [`## 会话列表（${range}${wsFilter ? ` · 工作区 ${wsDisplay(wsFilter)}` : ''}${args.query ? ` · "${args.query}"` : ''}；按最近活跃，前 ${rows.length}）`, '', '| 会话 | 标题/首条消息 | 工作区 | 模型 | 请求 | token | 峰值窗口 | 最近活跃 |', '|---|---|---|---|---|---|---|---|']
  for (const r of rows) lines.push(`| ${shortSid(r.sid)}${isSub(r.sid) ? '（子）' : ''} | ${(cleanTitle(r.title) || '-').slice(0, 40).replace(/\|/g, '\\|')} | ${wsDisplay(r.workspace)} | ${r.model || '-'} | ${r.n} | ${fmtTok(r.tok)} | ${fmtTok(r.peak)} | ${fmtDate(r.last)} |`)
  lines.push('')
  lines.push('> 组成/趋势工具可传 session 参数（上表会话 id 的任意片段）；组成另可传 request（如 -2 倒数第二条）查看历史请求。')
  return lines.join('\n')
}

// ---------- MCP 协议 ----------

const TOOLS = [
  {
    name: 'context_composition',
    description: '当前（默认最近活跃）或指定会话某次请求的上下文组成拆解：系统提示词/工具定义/用户消息/注入上下文/工具调用/工具结果/推理等各占多少 token（按字符占比估算，总数精确），并按工具名归因（哪个工具的结果在吃上下文）。request 参数可查看任意历史请求（Context Browser）；detail=true 附消息级明细（哪几条消息最大）。',
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string', description: '会话 id 或其片段；省略取最近活跃会话（通常即当前会话）' },
        request: { type: 'number', description: '请求序号：-1（默认）最后一条，-2 倒数第二条，0 第一条' },
        detail: { type: 'boolean', description: '附消息级明细表（按字符量取最大者）' },
      },
    },
  },
  {
    name: 'context_diff',
    description: '组成增量：同一会话两个请求之间上下文长在哪里（各组成部分 from→to→增量表）。默认对比 -5 与 -1。',
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string', description: '会话 id 或其片段；省略取最近活跃会话' },
        from: { type: 'number', description: '起点请求序号（默认 -5）' },
        to: { type: 'number', description: '终点请求序号（默认 -1）' },
      },
    },
  },
  {
    name: 'context_trend',
    description: '会话的逐请求上下文趋势：输入/计费输入（扣缓存）/输出三条走势、自动压缩事件检测、按轮次（turn）聚合的最费 token 轮次、窗口压力投影（按近期增长节奏外推到窗口 80%）、模型耗时 vs 会话跨度、累计成本。',
    inputSchema: { type: 'object', properties: { session: { type: 'string', description: '会话 id 或其片段；省略取最近活跃会话' } } },
  },
  {
    name: 'context_events',
    description: '会话的上下文事件时间线：自动压缩（输入骤降）、工具集变更（MCP/插件加载）、单步大幅增长（>30k）。',
    inputSchema: { type: 'object', properties: { session: { type: 'string', description: '会话 id 或其片段；省略取最近活跃会话' } } },
  },
  {
    name: 'subagents',
    description: '子 agent 会话管理：全部 subagent 会话注册表——状态推断（运行中=近5分钟有活动/近24h/已结束）、父会话归属（启发式）、耗时与成本、运行中实况（最近工具动作链/token 速度/当前窗口）、按父会话汇总的子/父开销比；孤立子 agent 单独标出。rollout 为事后日志，不能终止会话。',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['all', 'running', 'recent', 'done'], description: '状态筛选，默认 all' },
        parent: { type: 'string', description: '按父会话 id 片段筛选' },
        workspace: { type: 'string', description: '工作区路径前缀过滤' },
        limit: { type: 'number', description: '返回条数，默认 20，最大 100' },
        live: { type: 'boolean', description: '运行中实况开关，默认 true（最多 8 条）' },
      },
    },
  },
  {
    name: 'fleet',
    description: 'Agent 家族（Fleet）：主会话与时间窗内同工作区的子 agent 会话各自的请求/token/成本卡片与家族合计。归组为启发式。',
    inputSchema: { type: 'object', properties: { session: { type: 'string', description: '主会话 id 或其片段；省略取最近活跃的主会话' } } },
  },
  {
    name: 'context_insights',
    description: '跨会话用量洞察：KPI（含缓存省钱额）、模型分布、工作区分布、会话榜；brief=true 时只出这几项（跳过每日柱/热力图/小时分布/四类账本，避免长输出）。完整模式另含每日用量、8 周热力图、小时分布、工具/技能/文件/命令账本。',
    inputSchema: {
      type: 'object',
      properties: {
        range: { type: 'string', enum: ['today', '7d', '30d', 'all'], description: '统计时间范围，默认 7d' },
        workspace: { type: 'string', description: '工作区路径前缀过滤（如 /Users/you/Desktop/ai-agent）' },
        query: { type: 'string', description: '按会话标题/工作区/id 子串过滤' },
        brief: { type: 'boolean', description: '精简输出：KPI+模型分布+工作区分布+会话榜，默认 false' },
      },
    },
  },
  {
    name: 'context_search',
    description: '跨会话全文搜索：按子串或正则在会话的用户消息/助手回复/工具结果中查找，返回会话、时间、命中片段，以及可直接传给 context_composition 的 request 序号。子串为大小写敏感匹配（中文不受影响）；regex:true 启用 JS 正则（Unicode 模式）。大范围扫描有字节上限（CONTEXT_INSIGHTS_SEARCH_MAX_BYTES，默认 4GB）。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '要搜索的子串或正则（必填）' },
        regex: { type: 'boolean', description: '把 query 当作 JavaScript 正则（Unicode 模式），默认 false' },
        range: { type: 'string', enum: ['today', '7d', '30d', 'all'], description: '扫描时间范围，默认 30d' },
        workspace: { type: 'string', description: '工作区路径前缀过滤' },
        limit: { type: 'number', description: '返回条数上限，默认 20，最大 50' },
      },
      required: ['query'],
    },
  },
  {
    name: 'context_export',
    description: '导出 CSV 到本机 ~/.zcode/context-insights/exports/：kind=sessions（会话汇总，含成本/压缩次数）或 requests（逐请求明细）；支持 range/workspace/query 过滤；返回文件路径与预览。',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['sessions', 'requests'], description: '导出粒度，默认 sessions' },
        range: { type: 'string', enum: ['today', '7d', '30d', 'all'], description: '数据时间范围，默认 30d' },
        workspace: { type: 'string', description: '工作区路径前缀过滤' },
        query: { type: 'string', description: '会话标题/工作区/id 子串过滤' },
      },
    },
  },
  {
    name: 'session_list',
    description: '最近活跃的 ZCode 会话清单（标题、工作区、模型、请求数、token、峰值窗口、最近活跃时间），支持 range/workspace/query 过滤（与 context_insights 同口径）。',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: '返回条数，默认 15，最大 100' },
        range: { type: 'string', enum: ['today', '7d', '30d', 'all'], description: '统计时间范围，默认 all' },
        workspace: { type: 'string', description: '工作区路径前缀过滤' },
        query: { type: 'string', description: '会话标题/工作区/id 子串过滤' },
      },
    },
  },
  {
    name: 'context_health',
    description: '会话健康度评分：缓存效率(35%)/窗口纪律(25%)/压缩频率(20%)/成本效率(20%)四维启发式评分，附改进建议。传 session 做单会话诊断；不传 session 则输出范围内排名（最差前 N 优先治理 + 最优前 3）。',
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string', description: '会话 id 或其片段；省略则进入排名模式' },
        range: { type: 'string', enum: ['today', '7d', '30d', 'all'], description: '统计时间范围，排名模式默认 30d' },
        workspace: { type: 'string', description: '排名模式的工作区前缀过滤' },
        limit: { type: 'number', description: '排名模式返回条数，默认 10，最大 50' },
      },
    },
  },
  {
    name: 'session_digest',
    description: '会话速览：一段话回答"这个会话干了啥"——标题/工作区/时间跨度/轮次/token/成本/压缩/健康度/子 agent，加常用工具、触碰文件、常跑命令与最后一条用户消息（最近在做什么）。传 recent:N 则批量输出最近 N 个主会话的紧凑速览。',
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string', description: '会话 id 或其片段；省略取最近活跃会话' },
        recent: { type: 'number', description: '批量模式：最近 N 个主会话的紧凑速览（≤20），与 session 二选一' },
      },
    },
  },
  {
    name: 'context_compare',
    description: '会话对比：两个会话的指标并排表（工作区/模型/跨度/轮次/token/命中率/峰值/压缩/成本/健康度/子 agent/常用工具）。缺省取两个最近活跃的主会话；用 sessionA/sessionB 指定。',
    inputSchema: {
      type: 'object',
      properties: {
        sessionA: { type: 'string', description: '会话 A 的 id 或片段；省略取最近活跃主会话' },
        sessionB: { type: 'string', description: '会话 B 的 id 或片段；省略取次近的主会话' },
      },
    },
  },
  {
    name: 'pricing_info',
    description: '当前生效的价格表（内置 + 自动层 + 用户覆盖合并后）、计费口径说明与覆盖方法。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'pricing_refresh',
    description: '从 models.dev 在线刷新价格表到自动层（~/.zcode/context-insights/pricing-auto.json；手写 pricing.json 优先级更高，永不被覆盖）。这是本插件唯一发起网络请求的工具——仅在用户明确要求"刷新价格"时调用。',
    inputSchema: { type: 'object', properties: {} },
  },
]

let indexPromise = null
let runningUpdate = null
let lastIndexRun = 0
const INDEX_REFRESH_MS = 60_000

/**
 * 索引保障：MCP server 按 session 隔离、随会话长期存活，索引若只在进程首次调用时构建，
 * 长会话中 trend/insights 等将读到陈旧数据——因此每 60s 触发一次增量刷新
 * （暖索引下仅 stat 各文件 + 读新增字节，毫秒级）。刷新进行中的并发调用共享同一次运行。
 */
function ensureIndex() {
  if (runningUpdate) return runningUpdate
  if (indexPromise && Date.now() - lastIndexRun < INDEX_REFRESH_MS) return indexPromise
  runningUpdate = Promise.resolve()
    .then(() => updateIndex((sid, bytes) => {
      console.error(`[context-insights] 索引进度: ${sid}（累计读取 ${(bytes / 1e9).toFixed(1)}GB）`)
    }))
    .then(idx => { lastIndexRun = Date.now(); indexPromise = Promise.resolve(idx); return idx })
    .finally(() => { runningUpdate = null })
  return runningUpdate
}

async function dispatch(name, args) {
  switch (name) {
    case 'context_composition':
      // 只看最后一条时不必等索引（尾部直读）；指定历史请求才需要索引
      return toolComposition(args, args.request !== undefined && args.request !== -1 ? await ensureIndex() : null)
    case 'context_diff':
      // 默认 from=-5 就需要索引定位历史请求，直接走索引
      return toolDiff(args, await ensureIndex())
    case 'context_trend': return toolTrend(args, await ensureIndex())
    case 'context_events': return toolEvents(args, await ensureIndex())
    case 'fleet': return toolFleet(args, await ensureIndex())
    case 'subagents': return toolSubagents(args, await ensureIndex())
    case 'context_insights': return toolInsights(args, await ensureIndex())
    case 'session_list': return toolSessionList(args, await ensureIndex())
    case 'context_search': return toolSearch(args, await ensureIndex())
    case 'context_export': return toolExport(args, await ensureIndex())
    case 'context_health': return toolHealth(args, await ensureIndex())
    case 'session_digest': return toolDigest(args, await ensureIndex())
    case 'context_compare': return toolCompare(args, await ensureIndex())
    case 'pricing_info': return toolPricingInfo()
    case 'pricing_refresh': return toolPricingRefresh()
    default: throw new Error(`未知工具: ${name}`)
  }
}

function send(obj) { process.stdout.write(JSON.stringify(obj) + '\n') }

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', async line => {
  line = line.trim()
  if (!line) return
  let msg
  try { msg = JSON.parse(line) } catch { return }
  const { id, method, params } = msg
  if (method === 'initialize') {
    send({
      jsonrpc: '2.0', id, result: {
        protocolVersion: params?.protocolVersion || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'context-insights', version: '1.1.0' },
      },
    })
  } else if (method === 'notifications/initialized' || method === 'notifications/cancelled') {
    // 通知无需应答
  } else if (method === 'ping') {
    send({ jsonrpc: '2.0', id, result: {} })
  } else if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: TOOLS } })
  } else if (method === 'tools/call') {
    try {
      const text = await dispatch(params?.name, params?.arguments || {})
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } })
    } catch (err) {
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `工具执行失败：${err.message}` }], isError: true } })
    }
  } else if (id !== undefined) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } })
  }
})

console.error('[context-insights] MCP server 就绪（stdio）')
