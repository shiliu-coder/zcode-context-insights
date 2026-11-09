// rollout 模型 IO 日志的增量索引与尾部读取。
//
// 数据源：~/.zcode/cli/rollout/model-io-<sess_id>.jsonl，每行一条完整请求记录
// （request.body 全量 messages + response.usage + 模型与时间戳）。历史可达数十 GB，
// 因此索引采用"每会话记录字节偏移，只解析新增字节"的增量策略；组成拆解只需最后
// 一条请求，用从文件尾反向 seek 的方式读取，不全文解析。
import { createReadStream, existsSync, openSync, closeSync, fstatSync, statSync, readdirSync, renameSync, writeFileSync, mkdirSync, readFileSync, readSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const INDEX_VERSION = 3

export function rolloutDir() {
  return process.env.CONTEXT_INSIGHTS_ROLLOUT_DIR || join(homedir(), '.zcode', 'cli', 'rollout')
}

function indexFile() {
  return process.env.CONTEXT_INSIGHTS_INDEX_FILE
    || join(process.env.CONTEXT_INSIGHTS_CONFIG_DIR || join(homedir(), '.zcode', 'context-insights'), 'index.json')
}

/** 列出全部 model-io 文件及会话 id，按 mtime 降序（最新会话在最前）。 */
export function listSessions() {
  const dir = rolloutDir()
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter(name => name.startsWith('model-io-') && name.endsWith('.jsonl'))
    .map(name => {
      const file = join(dir, name)
      const st = statSync(file)
      return { sid: name.slice('model-io-'.length, -'.jsonl'.length), file, size: st.size, mtimeMs: st.mtimeMs }
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
}

/** 按 sid 或其片段解析出唯一的会话文件；无匹配/多匹配时返回 null（多匹配取最新）。 */
export function resolveSession(sessionHint) {
  const sessions = listSessions()
  if (!sessionHint) return sessions[0] || null
  const needle = String(sessionHint).toLowerCase().replace(/^model-io-/, '').replace(/\.jsonl$/, '')
  const hits = sessions.filter(s => s.sid.toLowerCase().includes(needle))
  return hits[0] || null
}

function loadIndex() {
  try {
    const idx = JSON.parse(readFileSync(indexFile(), 'utf8'))
    // 向下兼容：接受旧版本索引（缺的新字段靠增量/一次性补扫渐进补全）。
    // 严格拒绝会引发"全量重建风暴"——多版本 server 并存时（session 隔离）互相摧毁索引。
    if (idx && typeof idx.version === 'number' && idx.version <= INDEX_VERSION && idx.sessions && typeof idx.sessions === 'object') {
      return { idx, stale: idx.version < INDEX_VERSION }
    }
  } catch { /* 无索引或损坏：按不存在处理，重建 */ }
  return { idx: { version: INDEX_VERSION, sessions: {} }, stale: false }
}

// 进程级一次性补扫标记：索引版本落后时对缺 qs 的旧条目强制重扫一次（此后接受渐进补全）
let qsRescanDone = false

function saveIndexAtomic(idx) {
  const file = indexFile()
  mkdirSync(dirnameOf(file), { recursive: true })
  // 多 MCP server 并发（session 隔离下每个会话一个进程）写同一索引：落盘前合并磁盘上
  // 其他进程在本进程运行期间的更新，以 size/mtimeMs 较新者为准，避免 last-write-wins 丢数据。
  try {
    const disk = JSON.parse(readFileSync(file, 'utf8'))
    if (disk && disk.sessions && typeof disk.sessions === 'object') {
      for (const [sid, d] of Object.entries(disk.sessions)) {
        const mine = idx.sessions[sid]
        if (!mine) { idx.sessions[sid] = d; continue }
        // 保护新字段：内存条目已补 qs（新版本扫描）时，不被磁盘上旧版本的无 qs 条目降级覆盖
        const mineHasQs = (mine.requests || []).some(r => r.qs)
        const diskHasQs = (d.requests || []).some(r => r.qs)
        if (mineHasQs && !diskHasQs) continue
        const diskNewer = (d.size || 0) > (mine.size || 0)
          || (d.size === mine.size && (d.mtimeMs || 0) > (mine.mtimeMs || 0))
        if (diskNewer) idx.sessions[sid] = d
      }
    }
  } catch { /* 无旧索引或损坏：按当前内存态写入 */ }
  const tmp = file + '.tmp'
  writeFileSync(tmp, JSON.stringify(idx))
  renameSync(tmp, file)
}

function dirnameOf(p) {
  const i = p.lastIndexOf('/')
  return i <= 0 ? '/' : p.slice(0, i)
}

/** 从一条记录行提取摘要（不含 request.body 大对象）。off=行起始字节偏移，供按请求直读。 */
function summarize(record, lineOffset) {
  if (!record || record.type !== 'model_io') return null
  const m = record.model || {}
  const u = (record.response && record.response.usage) || {}
  const calls = Array.isArray(record.response?.toolCalls) ? record.response.toolCalls : []
  const tools = calls.map(t => t?.name).filter(n => typeof n === 'string' && n !== '')
  // 工具操作摘要：文件类记路径、Bash 记命令头、Skill 记技能名；其余只留名（供各类账本）
  const ops = []
  for (const c of calls) {
    const name = c?.name, input = c?.input
    if (!name || input == null || typeof input !== 'object') continue
    const file = input.file_path || input.path || input.notebook_path || input.filePath
    if (typeof file === 'string' && file) ops.push({ n: name, f: file })
    else if (name === 'Bash' && typeof input.command === 'string') ops.push({ n: name, c: input.command.slice(0, 120) })
    else if (name === 'Skill' && typeof input.skill === 'string') ops.push({ n: name, k: input.skill })
  }
  const toolsN = Array.isArray(record.request?.body?.tools) ? record.request.body.tools.length : null
  return {
    ts: record.completedAt || record.startedAt || null,
    model: m.modelId || null,
    provider: m.providerId || null,
    // querySource：main_turn / subagent / web_search_tool / compact / *_title 等辅助流（v3 起记录，供流量三分）
    qs: record.querySource || null,
    in: u.inputTokens ?? null,
    out: u.outputTokens ?? null,
    cr: u.cacheReadTokens ?? null,
    cw: u.cacheWriteTokens ?? null,
    ms: record.durationMs ?? null,
    tools,
    toolsN,
    ops,
    turn: record.turnId || null,
    off: lineOffset,
  }
}

/** 从首条请求的 messages 中启发式提取工作目录与标题（只在会话首行做一次）。 */
function extractMeta(record) {
  const meta = { workspace: null, title: null }
  const messages = record?.request?.body?.messages
  if (!Array.isArray(messages)) return meta
  const texts = []
  for (const msg of messages) {
    const c = msg?.content
    if (typeof c === 'string') texts.push(c)
    else if (Array.isArray(c)) for (const b of c) if (b?.type === 'text' && typeof b.text === 'string') texts.push(b.text)
    if (texts.length > 40) break
  }
  for (const t of texts) {
    const m = /(?:Primary working directory|工作目录)\s*[:：]\s*(\/[^\s`"']+)/.exec(t)
    if (m) { meta.workspace = m[1]; break }
  }
  for (const t of texts) {
    // 剥 system-reminder 与 markdown 链接（保留链接文字），折叠空白——首条用户消息常带插件引用等噪音
    const clean = t
      .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\s+/g, ' ')
      .trim()
    if (clean) { meta.title = clean.slice(0, 120); break }
  }
  return meta
}

/**
 * 增量更新索引：逐文件 stat，未变化的跳过；增长的自 offset 续读，缩小的整体重读。
 * 每处理完一个文件就原子落盘一次，中断可续。大历史首次构建可能耗时数分钟。
 */
export async function updateIndex(onProgress) {
  const { idx } = loadIndex()
  const rescanMissingQs = !qsRescanDone
  const sessions = listSessions()
  let parsed = 0, appended = 0
  for (const s of sessions) {
    const entry = idx.sessions[s.sid]
    let offset = 0, requests = entry?.requests || [], meta = entry ? { workspace: entry.workspace, title: entry.title } : null
    // 进程首刷：缺 qs 的**小**文件（≤800MB，辅助流文件都很小）强制重扫一次补字段；
    // 巨型主会话文件跳过（aux 占比低，靠新行渐进），避免每次冷启动都全量重扫 20GB
    const needsQsRescan = rescanMissingQs && requests.length > 0 && !requests.some(r => r.qs)
      && (entry?.size || s.size) <= 800 * 1024 * 1024
    if (!needsQsRescan && entry && entry.file === s.file && s.size >= entry.offset && s.size === entry.size && s.mtimeMs === entry.mtimeMs) continue
    if (!needsQsRescan && entry && entry.file === s.file && s.size >= entry.offset) offset = entry.offset
    else requests = []
    // base 追踪已消费的完整行边界（字节语义，外层可见，落盘时用）
    let base = offset
    await new Promise((resolve, reject) => {
      const stream = createReadStream(s.file, { start: offset, highWaterMark: 1 << 20 })
      let buf = Buffer.alloc(0)
      stream.on('data', chunk => {
        buf = Buffer.concat([buf, chunk])
        let nl
        while ((nl = buf.indexOf(0x0a)) !== -1) {
          const line = buf.subarray(0, nl)
          buf = buf.subarray(nl + 1)
          const lineStart = base
          base += nl + 1
          if (line.length === 0 || /^\s*$/.test(line.toString('utf8'))) continue
          try {
            const record = JSON.parse(line.toString('utf8'))
            const summary = summarize(record, lineStart)
            if (!summary) continue
            if (!meta && requests.length === 0 && Array.isArray(record.request?.body?.messages)) meta = extractMeta(record)
            requests.push(summary)
            appended++
          } catch { /* 半行或损坏行：跳过但推进偏移 */ }
        }
        parsed += chunk.length
      })
      stream.on('end', () => resolve())
      stream.on('error', err => { console.error(`[context-insights] 读取失败 ${s.file}: ${err.message}`); resolve() })
    }).catch(() => {})
    // 只在完整行边界上推进 offset；残留的不完整行下次再读。
    idx.sessions[s.sid] = { file: s.file, offset: base, size: s.size, mtimeMs: s.mtimeMs, requests, workspace: meta?.workspace || null, title: meta?.title || null }
    saveIndexAtomic(idx)
    if (onProgress) onProgress(s.sid, parsed, appended)
  }
  qsRescanDone = true
  // 清理已删除的会话文件条目。
  const live = new Set(sessions.map(s => s.sid))
  let removed = false
  for (const sid of Object.keys(idx.sessions)) if (!live.has(sid)) { delete idx.sessions[sid]; removed = true }
  if (removed) saveIndexAtomic(idx)
  return idx
}

/** 读取某文件最后一条完整 JSON 行并解析（从文件尾反向 seek，兼容超大文件）。 */
export async function tailLastLine(file) {
  const fd = openSync(file, 'r')
  try {
    const size = fstatSync(fd).size
    let window = 16 * 1024 * 1024
    while (window <= 2 * 1024 * 1024 * 1024) {
      const pos = Math.max(0, size - window)
      const buf = Buffer.alloc(size - pos)
      readSync(fd, buf, 0, buf.length, pos)
      const text = buf.toString('utf8')
      const lines = text.split('\n')
      // 窗口不从 0 开始时首段是被截断的半行；文件以换行结尾时末段为空。
      if (pos > 0) lines.shift()
      while (lines.length && lines[lines.length - 1] === '') lines.pop()
      const last = lines[lines.length - 1]
      if (last && last.trim()) {
        try { return JSON.parse(last) } catch { /* 行被窗口截断，扩大窗口重试 */ }
      }
      if (pos === 0) return null
      window *= 4
    }
    return null
  } finally {
    closeSync(fd)
  }
}

/**
 * 从字节偏移处读取一行完整 JSON 并解析（Context Browser 按请求直读用）。
 * @param {string} file 会话文件路径
 * @param {number} offset 行起始字节偏移（来自索引 off 字段）
 * @param {number} maxLine 单行上限（默认 512MB，防御异常行）
 */
export function readLineAt(file, offset, maxLine = 512 * 1024 * 1024) {
  const fd = openSync(file, 'r')
  try {
    const chunks = []
    const scratch = Buffer.alloc(1 << 20)
    let pos = offset, total = 0
    while (total < maxLine) {
      const n = readSync(fd, scratch, 0, scratch.length, pos)
      if (n <= 0) break
      const nl = scratch.subarray(0, n).indexOf(0x0a)
      if (nl !== -1) {
        chunks.push(Buffer.from(scratch.subarray(0, nl)))
        return JSON.parse(Buffer.concat(chunks).toString('utf8'))
      }
      // 必须拷贝：subarray 是视图，scratch 下轮读取会被覆写
      chunks.push(Buffer.from(scratch.subarray(0, n)))
      total += n
      pos += n
    }
    return null
  } catch {
    return null
  } finally {
    closeSync(fd)
  }
}

/**
 * 在单个会话文件中按谓词逐行搜索：命中行才 JSON 解析，大文件下代价接近纯 IO。
 * matchFn(text) => boolean（子串 includes 或正则 test）。每行字节偏移随扫描推进，供请求序号映射。
 * @returns {{scannedBytes:number, hits:Array<{lineStart:number, record:object}>, truncated:boolean}}
 */
export async function searchSessionFile(file, matchFn, { maxBytes = 4 * 1024 ** 3 } = {}) {
  const hits = []
  let scanned = 0
  let truncated = false
  await new Promise(resolve => {
    const stream = createReadStream(file, { highWaterMark: 1 << 20 })
    let buf = Buffer.alloc(0)
    let base = 0
    stream.on('data', chunk => {
      buf = Buffer.concat([buf, chunk])
      let nl
      while ((nl = buf.indexOf(0x0a)) !== -1) {
        const line = buf.subarray(0, nl)
        const lineStart = base
        buf = buf.subarray(nl + 1)
        base += nl + 1
        scanned += nl + 1
        if (line.length) {
          const text = line.toString('utf8')
          if (matchFn(text)) {
            try {
              const record = JSON.parse(text)
              if (record?.type === 'model_io') hits.push({ lineStart, record })
            } catch { /* 损坏行跳过 */ }
          }
        }
        if (scanned >= maxBytes) { truncated = true; stream.destroy(); break }
      }
    })
    stream.on('close', () => resolve())
    stream.on('error', () => resolve())
  }).catch(() => {})
  return { scannedBytes: scanned, hits, truncated }
}
