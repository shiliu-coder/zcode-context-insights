---
description: 子 agent 会话管理：状态/父会话/成本一览（dsh-context 的 ZCode 版）
---

请使用 `context-insights` MCP 服务器的 `subagents` 工具查看子 agent 会话：

- 默认全量（紧凑表）；用户关心"正在跑的"传 `status: "running"`，按主会话筛选传 `parent`（id 片段）。
- 把工具返回的 Markdown **原样**呈现，开头补一行一句总览（共几个、运行中几个、孤立几个、子 agent 成本合计）。
- 若存在"孤立?"条目或运行中条目，在结尾提醒一句；不要编造工具未返回的数字。
