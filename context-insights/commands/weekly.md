---
description: 周报：本周用量/健康度/子 agent 汇总（dsh-context 的 ZCode 版）
---

请用 `context-insights` MCP 服务器的工具生成一份**紧凑周报**（Markdown，控制在 60 行内，避免挤占会话窗口）：

1. `context_insights {range: "7d", brief: true}` —— 用量 KPI、模型分布、工作区分布、会话榜。
2. `context_health {range: "7d", limit: 5}` —— 健康度排名（最差前 5 + 最优 3）。
3. `session_digest {recent: 5}` —— 最近 5 个主会话的一句话速览。
4. `subagents {status: "recent"}` —— 近 24h 子 agent 动向（仅一行总览即可，不贴全表）。

输出结构：

```
# 周报（<起止日期>）

## 一句话总览
（本周 N 会话 / N 请求 / X token / 成本 $Y / 缓存省了 $Z；健康度平均分）

## 值得注意
（最差健康度会话及其主要扣分项；压缩次数；子 agent 开销比异常者）

## 最近会话
（digest 批量速览原样嵌入）

## 建议
（最多 3 条，来自健康度建议与观察，不要编造数字）
```

工具返回什么就写什么，不要估算；若某工具返回空数据则跳过对应小节。
