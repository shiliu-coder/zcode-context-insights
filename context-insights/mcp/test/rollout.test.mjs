// rollout.mjs 集成测试：临时目录隔离，覆盖增量索引/偏移续读/尾读/搜索/会话解析。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'ci-test-'))
const rolloutDir = join(root, 'rollout')
const indexFile = join(root, 'index.json')
mkdirSync(rolloutDir, { recursive: true })
process.env.CONTEXT_INSIGHTS_ROLLOUT_DIR = rolloutDir
process.env.CONTEXT_INSIGHTS_INDEX_FILE = indexFile
process.env.CONTEXT_INSIGHTS_CONFIG_DIR = join(root, 'config')

const { updateIndex, tailLastLine, readLineAt, searchSessionFile, listSessions, resolveSession } = await import('../lib/rollout.mjs')

const file = join(rolloutDir, 'model-io-sess_test1.jsonl')
const rec = (ts, marker) => JSON.stringify({
  type: 'model_io', completedAt: ts, durationMs: 100,
  model: { modelId: 'glm-5.3', providerId: 'zhipuai' },
  request: { body: { model: 'glm-5.3', system: '', tools: [], messages: [
    { role: 'user', content: [{ type: 'text', text: `Primary working directory: /tmp/proj\n${marker ?? ''}` }] },
  ] } },
  response: { usage: { inputTokens: 500, outputTokens: 10, cacheReadTokens: 400, cacheWriteTokens: 0 }, toolCalls: [] },
})

before(async () => {
  writeFileSync(file, rec('2026-11-09T01:00:00Z', 'first') + '\n' + rec('2026-11-09T02:00:00Z', 'needle-second') + '\n')
})

after(() => { rmSync(root, { recursive: true, force: true }) })

test('updateIndex：首次全量，工作区/标题从首条消息提取', async () => {
  const idx = await updateIndex()
  const e = idx.sessions.sess_test1
  assert.equal(e.requests.length, 2)
  assert.equal(e.requests[0].off, 0)
  assert.equal(e.workspace, '/tmp/proj')
})

test('updateIndex：追加一行后增量续读，偏移单调且命中新行', async () => {
  appendFileSync(file, rec('2026-11-09T03:00:00Z', 'third') + '\n')
  const idx = await updateIndex()
  const reqs = idx.sessions.sess_test1.requests
  assert.equal(reqs.length, 3)
  assert.ok(reqs[2].off > reqs[1].off)
  const rec2 = readLineAt(file, reqs[1].off)
  assert.equal(rec2.completedAt, '2026-11-09T02:00:00Z')
})

test('readLineAt：偏移指向的行可精确解析', async () => {
  const idx = JSON.parse((await import('node:fs')).readFileSync(indexFile, 'utf8'))
  const off = idx.sessions.sess_test1.requests[0].off
  const rec1 = readLineAt(file, off)
  assert.equal(rec1.completedAt, '2026-11-09T01:00:00Z')
})

test('tailLastLine：返回最后一条完整记录', async () => {
  const last = await tailLastLine(file)
  assert.equal(last.completedAt, '2026-11-09T03:00:00Z')
})

test('searchSessionFile：谓词命中且跳过未命中行', async () => {
  const { hits, scannedBytes, truncated } = await searchSessionFile(file, t => t.includes('needle-second'))
  assert.equal(hits.length, 1)
  assert.equal(hits[0].record.completedAt, '2026-11-09T02:00:00Z')
  assert.equal(truncated, false)
  assert.ok(scannedBytes > 0)
})

test('listSessions/resolveSession：会话按片段唯一解析', () => {
  const list = listSessions()
  assert.ok(list.some(s => s.sid === 'sess_test1'))
  const hit = resolveSession('test1')
  assert.equal(hit.sid, 'sess_test1')
  assert.equal(resolveSession('不存在的片段xyz'), null)
})
