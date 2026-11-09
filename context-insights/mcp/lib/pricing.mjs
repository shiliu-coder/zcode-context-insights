// 价格表加载与成本估算：内置 models.dev 抓取表 + 用户覆盖文件合并。
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const moduleDir = dirname(fileURLToPath(import.meta.url))

/** 用户配置目录（价格覆盖文件放这里）；环境变量可重定向。 */
export function configDir() {
  return process.env.CONTEXT_INSIGHTS_CONFIG_DIR || join(homedir(), '.zcode', 'context-insights')
}

function loadPricing() {
  const table = {}
  // 三层合并（后者覆盖前者）：内置表 < 自动层（pricing_refresh 抓取快照） < 用户手写（pricing.json）
  const builtin = JSON.parse(readFileSync(join(moduleDir, '..', 'pricing-builtin.json'), 'utf8')).models
  for (const [id, entry] of Object.entries(builtin)) table[id.toLowerCase()] = entry
  try {
    const auto = JSON.parse(readFileSync(join(configDir(), 'pricing-auto.json'), 'utf8')).models
    if (auto && typeof auto === 'object') for (const [id, entry] of Object.entries(auto)) table[id.toLowerCase()] = entry
  } catch { /* 无自动层属正常 */ }
  try {
    const user = JSON.parse(readFileSync(join(configDir(), 'pricing.json'), 'utf8')).models
    if (user && typeof user === 'object') for (const [id, entry] of Object.entries(user)) table[id.toLowerCase()] = entry
  } catch { /* 无覆盖文件属正常情况，静默 */ }
  return table
}

let pricingTable = loadPricing()

/** 重新加载价格表（pricing_refresh 写入自动层后调用）。 */
export function reloadPricing() {
  pricingTable = loadPricing()
}

/** 取某 modelId 的价格条目；无条目返回 null（成本输出 N/A）。 */
export function priceFor(modelId) {
  return pricingTable[String(modelId || '').toLowerCase()] || null
}

/** 套餐类 provider（providerId 含 "plan"）：实际按订阅计费，输出需标注。 */
export function isPlanProvider(providerId) {
  return typeof providerId === 'string' && providerId.toLowerCase().includes('plan')
}

/**
 * 按每百万 token 牌价估算一次请求的美元成本；模型不在表内返回 null。
 * 口径：inputTokens 须为**不含缓存命中**的输入（缓存部分按 cacheRead 价单列），
 * 与 providers 对缓存命中的实际计费方式一致。
 */
export function estimateCostUsd(modelId, u) {
  const p = priceFor(modelId)
  if (!p || !u) return null
  const sum = (u.inputTokens || 0) * (p.input || 0) + (u.outputTokens || 0) * (p.output || 0)
    + (u.cacheReadTokens || 0) * (p.cacheRead || 0) + (u.cacheWriteTokens || 0) * (p.cacheWrite || 0)
  return sum / 1e6
}

/** 模型上下文窗口大小（token），用于占用率；未知返回 null。 */
export function contextLimitFor(modelId) {
  return priceFor(modelId)?.contextLimit || null
}

/** 合并后的价格表全部条目（pricing_info 展示用）。 */
export function pricingTableEntries() {
  return Object.entries(pricingTable).map(([id, entry]) => ({ id, entry }))
}
