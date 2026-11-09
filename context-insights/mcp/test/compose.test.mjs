// compose.mjs 单测：组成分桶、system-reminder 归类、tool_use id→工具名归因、CJK 加权、detail 明细。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { composeFromRequest } from '../lib/compose.mjs'

function record(overrides = {}) {
  return {
    type: 'model_io',
    model: { modelId: 'glm-5.3', providerId: 'zhipuai' },
    completedAt: '2026-11-09T08:00:00.000Z',
    request: {
      body: {
        model: 'glm-5.3',
        system: [{ type: 'text', text: 'SYS'.repeat(100) }],
        tools: [{ name: 'tool_a', description: 'd', input_schema: {} }],
        messages: [
          { role: 'user', content: [{ type: 'text', text: '<system-reminder>注入</system-reminder>真实用户输入' }] },
          { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/x' } }] },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'R'.repeat(1000) }] },
          { role: 'system', content: '会话级摘要' },
        ],
      },
    },
    response: { usage: { inputTokens: 1000, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 } },
    ...overrides,
  }
}

const partOf = (c, key) => c.parts.find(p => p.key === key)

test('基础分桶：system/工具定义/用户/工具结果/工具调用/system消息/注入 各归其位', () => {
  const c = composeFromRequest(record())
  assert.equal(partOf(c, 'system').label, '系统提示词')
  assert.equal(partOf(c, 'tools').blocks, 1)
  assert.equal(partOf(c, 'user').blocks, 1) // tool_result 的 user 消息不进用户桶
  assert.equal(partOf(c, 'toolResults').blocks, 1)
  assert.equal(partOf(c, 'toolCalls').blocks, 1)
  assert.equal(partOf(c, 'systemMsgs').chars, 15) // '会话级摘要' 5 个汉字 × CJK 权重 3
  assert.equal(partOf(c, 'injected').chars, 41) // 标签 35 ASCII + '注入' 2 汉字 × 权重 3
})

test('按工具归因：tool_use id 映射到 Read，结果与调用分列', () => {
  const c = composeFromRequest(record())
  const read = c.toolAttribution.find(a => a.name === 'Read')
  assert.ok(read, '缺少 Read 归因')
  assert.equal(read.results.blocks, 1)
  assert.equal(read.calls.blocks, 1)
})

test('CJK 加权：等字符数的中文比英文分到更多 token 估算', () => {
  const r = record({
    request: { body: { model: 'glm-5.3', system: '', tools: [], messages: [
      { role: 'user', content: [{ type: 'text', text: '甲'.repeat(300) }] },
    ] } },
    // 单桶时占比恒为 100%，无法对比——改为双桶：两条 user 消息在同一请求里不可行，
    // 用 system(英文) vs user(中文) 对比：
  })
  const mixed = record()
  // 把 system 文本换成等长的中文，重跑：system estTokens 应显著高于英文版
  const zhSys = record()
  zhSys.request.body.system = [{ type: 'text', text: '系'.repeat(300) }]
  const en = composeFromRequest(mixed)
  const zh = composeFromRequest(zhSys)
  const enSys = en.parts.find(p => p.key === 'system').estTokens
  const zhSysTok = zh.parts.find(p => p.key === 'system').estTokens
  assert.ok(zhSysTok > enSys * 2, `中文 system(${zhSysTok}) 应明显高于英文(${enSys})`)
})

test('detail 模式：消息级明细行数与角色', () => {
  const c = composeFromRequest(record(), { detail: true })
  assert.ok(Array.isArray(c.messages) && c.messages.length === 4)
  assert.equal(c.messages[0].role, 'user')
  assert.ok(c.messages.every(m => typeof m.estTokens === 'number'))
})

test('窗口占用率：windowTokens 为精确值，contextLimit 来自价格表', () => {
  const c = composeFromRequest(record())
  assert.equal(c.windowTokens, 1000)
  assert.equal(c.contextLimit, 1000000)
})
