---
description: 上下文报告：组成/工具归因/趋势/事件/成本（dsh-context 的 ZCode 版）
---

请使用 `context-insights` MCP 服务器的工具，为**当前会话**（即最近活跃的会话）生成一份中文上下文报告：

1. 调用 `context_composition`（不传 session，默认最近活跃会话；`detail: true` 附消息明细）——组成拆解与按工具归因。
2. 调用 `context_trend`（不传 session）——逐请求趋势、最费 token 的轮次、压缩事件与累计成本。
3. 若用户想深入，再按需调用：`context_diff`（上下文长在哪里）、`context_events`（事件时间线）、`fleet`（子 agent 家族）、`context_insights`（跨会话洞察）。
4. 按下面的结构输出 Markdown 报告（数字用工具返回值，不要自行估算）：

```
## 上下文报告 · <会话短id>

### 当前窗口组成（按 token 估算占比）
模型 <modelId> · 窗口 <windowTokens> / <contextLimit>（<pressure>%）
| 组成部分 | 估算 token | 占比 |
|---|---|---|
（全部 parts，按占比降序）

### 工具归因（谁在吃上下文）
| 工具 | 结果 token | 调用回放 token |
|---|---|---|
（前几名）

### 逐请求趋势
- 请求数/轮次数、输入/输出/缓存 token 合计、缓存命中率、峰值窗口
- 最费 token 的轮次（如返回）
- 若检测到压缩事件，列出

### 成本
- 按量牌价折算：$<est.USD>（套餐 provider 时注明"套餐内，此为等值成本"）
```

注意：分项 token 是按字符占比对总输入 token 的估算（工具输出有标注），报告保留这一说明。
