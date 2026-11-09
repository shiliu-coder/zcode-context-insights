// pricing.mjs 单测：成本口径（缓存命中按 cacheRead 价）、provider 判定、大小写与上限。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { estimateCostUsd, isPlanProvider, priceFor, contextLimitFor } from '../lib/pricing.mjs'

test('estimateCostUsd：非缓存输入按 input 价，缓存命中按 cacheRead 价', () => {
  const usd = estimateCostUsd('glm-5.3', { inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 2_000_000, cacheWriteTokens: 0 })
  // 1.19516*1 + 4.18306*0.1 + 0.29879*2 = 1.19516 + 0.418306 + 0.59758 = 2.211046
  assert.ok(Math.abs(usd - 2.211046) < 1e-9, `实际 ${usd}`)
})

test('estimateCostUsd：未收录模型返回 null，空 usage 返回 null', () => {
  assert.equal(estimateCostUsd('no-such-model', { inputTokens: 1 }), null)
  assert.equal(estimateCostUsd('glm-5.3', null), null)
})

test('priceFor 大小写不敏感；contextLimitFor 取窗口', () => {
  assert.equal(priceFor('GLM-5.3-FLASH').input, priceFor('glm-5.3-flash').input)
  assert.equal(contextLimitFor('glm-5.3'), 1000000)
  assert.equal(contextLimitFor('no-such'), null)
})

test('isPlanProvider：providerId 含 plan 判定为套餐', () => {
  assert.equal(isPlanProvider('account:bigmodel-individual-coding-plan'), true)
  assert.equal(isPlanProvider('builtin:bigmodel-coding-plan'), true)
  assert.equal(isPlanProvider('zhipuai'), false)
  assert.equal(isPlanProvider(undefined), false)
})
