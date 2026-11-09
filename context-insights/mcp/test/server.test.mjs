// server.mjs 协议级测试：子进程 stdio，走真实 MCP 握手（环境隔离到临时 rollout）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = mkdtempSync(join(tmpdir(), 'ci-server-test-'))
const rolloutDir = join(root, 'rollout')
mkdirSync(rolloutDir, { recursive: true })
const here = dirname(fileURLToPath(import.meta.url))
const serverPath = join(here, '..', 'server.mjs')

writeFileSync(join(rolloutDir, 'model-io-sess_live1.jsonl'), JSON.stringify({
  type: 'model_io', completedAt: '2026-11-09T09:00:00Z', durationMs: 50, querySource: 'main_turn',
  model: { modelId: 'glm-5.3', providerId: 'zhipuai' },
  request: { body: { model: 'glm-5.3', system: '', tools: [], messages: [
    { role: 'user', content: [{ type: 'text', text: 'Primary working directory: /tmp/live' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'x1', name: 'Bash', input: { command: 'cargo test -p epoch-core' } }] },
  ] } },
  response: { usage: { inputTokens: 300, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 }, toolCalls: [{ id: 'x1', name: 'Bash', input: { command: 'cargo test -p epoch-core' } }] },
}) + '\n')

function rpc(msgs, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [serverPath], {
      env: { ...process.env, CONTEXT_INSIGHTS_ROLLOUT_DIR: rolloutDir, CONTEXT_INSIGHTS_INDEX_FILE: join(root, 'index.json'), CONTEXT_INSIGHTS_CONFIG_DIR: join(root, 'config') },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const timer = setTimeout(() => { child.kill(); reject(new Error('server 超时')) }, timeoutMs)
    let buf = ''
    const out = []
    child.stdout.on('data', d => {
      buf += d
      let nl
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        if (line.trim()) out.push(JSON.parse(line))
      }
    })
    child.on('close', () => { clearTimeout(timer); resolve(out) })
    child.stdin.write(msgs.map(m => JSON.stringify(m)).join('\n') + '\n')
    child.stdin.end()
  })
}

test('MCP 握手 + 工具清单 + 真实数据调用 + 搜索 includeTools + 未知方法报错', async () => {
  const out = await rpc([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'context_composition', arguments: {} } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'context_trend', arguments: {} } },
    { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'context_search', arguments: { query: 'cargo test', includeTools: true, range: 'all', limit: 3 } } },
    { jsonrpc: '2.0', id: 6, method: 'bogus/method', params: {} },
  ])
  const byId = Object.fromEntries(out.map(m => [m.id, m]))
  assert.equal(byId[1].result.serverInfo.name, 'context-insights')
  assert.ok(byId[2].result.tools.length >= 15, `工具数 ${byId[2].result.tools.length}`)
  const comp = byId[3].result.content[0].text
  assert.ok(comp.includes('上下文组成'), comp.slice(0, 200))
  assert.ok(comp.includes('live1'), '应命中合成会话 live1')
  const trend = byId[4].result.content[0].text
  assert.ok(trend.includes('上下文趋势'))
  const search = byId[5].result.content[0].text
  assert.ok(search.includes('工具调用') && search.includes('Bash'), `includeTools 应命中工具调用输入：\n${search.slice(0, 400)}`)
  assert.ok(search.includes('request=-'))
  assert.equal(byId[6].error.code, -32601)
}, { timeout: 90000 })

test.after?.(() => { rmSync(root, { recursive: true, force: true }) })
