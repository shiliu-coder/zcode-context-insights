# context-insights

dsh-context 的 ZCode 版数据层移植：读取本地 ZCode 模型 IO 日志（`~/.zcode/cli/rollout/model-io-*.jsonl`），提供上下文组成拆解、逐请求趋势、跨会话用量洞察与成本估算。全部计算在本机完成；除显式调用 `pricing_refresh` 外不发起任何网络请求。

## 工具（MCP：context-insights）

| 工具 | 功能 |
|---|---|
| `context_composition(session?, request?, detail?)` | 指定会话某次请求（默认最近活跃会话的最后一条；`request` 如 `-2` 倒数第二条——Context Browser）的组成拆解；**按工具归因**（哪个工具的结果/调用回放在吃上下文）；`detail: true` 附消息级明细（哪几条消息最大）。 |
| `context_diff(session?, from?, to?)` | 组成增量：两个请求之间上下文长在哪里（from→to→增量表），默认 `-5` vs `-1`。 |
| `context_trend(session?)` | 逐请求输入/计费输入（扣缓存）/输出三条走势、自动压缩检测、**按轮次（turnId）聚合的最费 token 轮次**、**窗口压力投影**（按近 20 条增长节奏的中位增量外推到窗口 80%，剔除压缩骤降段）、模型耗时 vs 会话跨度、累计成本。 |
| `context_events(session?)` | 上下文事件时间线：自动压缩（输入骤降>40%）、工具集变更（MCP/插件加载）、单步大幅增长（+30k）。 |
| `fleet(session?)` | Agent 家族：主会话与时间窗内同工作区（含子路径）子 agent 卡片与家族合计；启发式归组。 |
| `subagents(status?, parent?, workspace?, limit?, live?)` | **子 agent 会话管理**：全部 subagent 注册表——状态推断（运行中=近 5 分钟有活动/近24h/已结束）、父会话归属（每个子 agent 单一归属，未匹配标"孤立?"）、时长/成本、**运行中实况**（尾部直读最近一条请求：最近工具动作链、当前窗口、token 速度 tok/分；`live: false` 关闭，上限 8 条），以及**按父会话汇总的子/父开销比**。rollout 为事后日志，不能终止会话，管理定位为可见性。 |
| `context_insights(range?, workspace?, query?, brief?)` | 跨会话 KPI（含**缓存省钱额**、**压缩事件计数**）、模型分布、**工作区分布**、会话榜；`brief: true` 精简输出（跳过每日柱/热力图/小时分布/四账本）——默认完整。可按工作区前缀与关键词过滤。 |
| `context_search(query, regex?, range?, workspace?, limit?)` | **跨会话全文搜索**：在用户消息/助手回复/工具结果中按子串或正则（`regex: true`）查找，返回会话、时间、片段与 `request=-N`（可直接传 `context_composition` 跳转该请求）。命中行才解析、重复内容去重；扫描字节上限 `CONTEXT_INSIGHTS_SEARCH_MAX_BYTES`（默认 4GB）。 |
| `context_export(kind?, range?, workspace?, query?)` | **CSV 导出**：`sessions`（会话汇总：token/成本/压缩次数/峰值）或 `requests`（逐请求明细）到 `~/.zcode/context-insights/exports/`；带 BOM，Excel/Numbers 直接打开。 |
| `context_health(session?, range?, workspace?, limit?)` | **会话健康度评分**：缓存效率 35% / 窗口纪律 25% / 压缩频率 20% / 成本效率 20%（启发式，数据不足的维度权重重分配），低分维度附改进建议；传 session 单会话诊断，省略则输出范围内**排名**（最差前 N 优先治理 + 最优前 3）。 |
| `session_digest(session?, recent?)` | **会话速览**：一段话回答"这个会话干了啥"——标题/跨度/轮次/token/成本/压缩/健康度/子 agent，加常用工具、触碰文件（读/写）、常跑命令与最后一条用户消息。`recent: N` 批量输出最近 N 个主会话的紧凑速览（每会话 2-3 行）。 |
| `context_compare(sessionA?, sessionB?)` | **会话对比**：两个会话的指标并排表（跨度/轮次/token/命中率/峰值/压缩/成本/健康度/子 agent/常用工具）；缺省取两个最近活跃的主会话。 |
| `session_list(limit?, range?, workspace?, query?)` | 会话清单（含模型、峰值窗口列；过滤与 insights 同口径）。 |
| `pricing_info` | 生效价格表（内置 < 自动层 < 手写）、计费口径与覆盖方法。 |
| `pricing_refresh` | 从 models.dev 在线刷新价格表到自动层 `pricing-auto.json`（手写 `pricing.json` 优先级更高，永不被覆盖）。**本插件唯一发起网络请求的工具**，仅在用户明确要求"刷新价格"时调用。 |

斜杠命令（安装本插件后可用）：
- `/context` —— 当前会话的中文上下文报告（组成/工具归因/趋势/成本）。
- `/insights` —— 跨会话用量洞察（默认精简模式，避免长输出；要完整账本请明说）。
- `/subagents` —— 子 agent 会话一览（状态/父会话/成本）。
- `/weekly` —— 紧凑周报（KPI/健康度排名/最近会话/建议，≤60 行）。

所有时间戳与每日/小时分桶均按**本机时区**；走势条图超过 72 点自动降采样。

## 口径说明

- **组成分项 token 是估算**：按加权字符占比对总输入 token（精确值）分摊——CJK/全角字符权重 3、其余 1（GLM 分词下 1 个汉字 ≈ 1 token、约 4 个 ASCII 字符 ≈ 1 token）；不同 tokenizer 下仍有偏差。
- **窗口口径**：`usage.inputTokens` 按含缓存命中计入窗口；缓存命中率 = ΣcacheRead / Σinput。
- **成本**：按 models.dev 的 zhipuai 牌价折算（内置表见 `mcp/pricing-builtin.json`）。套餐类 provider（id 含 `plan`）实际按订阅计费，输出会标注"套餐 provider，此为按量牌价折算的等值成本"。

## 安装（公共市场）

本插件发布在 GitHub 公共市场仓库 [shiliu-coder/zcode-context-insights](https://github.com/shiliu-coder/zcode-context-insights)：

1. **Plugin Marketplace → Add → Add Plugin Marketplace**，粘贴 `https://github.com/shiliu-coder/zcode-context-insights`
2. 在该市场（shiliu-coder-plugins）中选择 **Context Insights → Install**
3. 重启 ZCode 后，新会话即可使用 `/context`、`/insights`、`/subagents`、`/weekly` 与全部工具

更新：改用 **Plugin Marketplace 中该市场的 Refresh / Update**，或 CLI `plugins update context-insights`。

## 配置

- 价格三层合并（后者覆盖前者）：内置表 `mcp/pricing-builtin.json` < 自动层 `~/.zcode/context-insights/pricing-auto.json`（`pricing_refresh` 生成）< 手写 `~/.zcode/context-insights/pricing.json`。手写条目优先级最高、不会被任何自动流程覆盖。结构：`{"models": {"<model-id 小写>": {"input": $/M, "output": $/M, "cacheRead": $/M, "cacheWrite": $/M, "contextLimit": n}}}`。

## 测试

零依赖测试套件（Node 内置 test runner，合成夹具 + 临时目录隔离，不依赖真实 20GB 数据）：

```sh
node --test mcp/test/
```

覆盖：成本口径、组成分桶与 CJK 加权、工具归因映射、增量索引与字节偏移、尾读/偏移直读、谓词搜索、MCP 协议握手与真实调用（子进程）。
- 环境变量：`CONTEXT_INSIGHTS_ROLLOUT_DIR`（数据目录）、`CONTEXT_INSIGHTS_CONFIG_DIR`（索引与价格目录）、`CONTEXT_INSIGHTS_INDEX_FILE`。

## 性能

rollout 历史可达数十 GB。首次调用 `context_trend`/`context_insights`/`session_list` 会构建增量索引（每会话只记录字节偏移，之后只读新增部分），大历史首次可能耗时数分钟，之后秒级。MCP server 按会话隔离、随会话长期存活，索引**每 60 秒自动增量刷新**（暖索引毫秒级），长会话中数据不会陈旧；多 server 并发写索引时落盘前按 size/mtime 合并。`context_composition` 只从文件尾读最后一条请求，始终很快。

`context_search` 的字节上限是**全局累计**的：单个超大文件（如超长会话）超过剩余上限时，该文件较早位置的内容可能扫不到——输出会明确标注截断；遇到这种情况调大 `CONTEXT_INSIGHTS_SEARCH_MAX_BYTES` 或收窄 range/workspace。

## 来源与致谢

功能设计参考 [bowenliang123/dsh-context](https://github.com/bowenliang123/dsh-context)（Apache-2.0）的数据层；DSH 的浏览器面板（洞察页/Context 标签页/Fleet）依赖 DSH Cordis UI 运行时，ZCode 无对应插件面，故以 Markdown 报告形式提供等价数据。

## 版本历史

| 版本 | 要点 |
|---|---|
| 0.1.0 | 数据层核心：组成/趋势/洞察/清单；20GB 增量索引 + 尾部直读 |
| 0.2.0 | 全功能对齐：Context Browser（任意请求）/Events/Fleet/工具·技能·文件·命令四账本/模型分布 |
| 0.3.0 | 诊断细化：按工具归因、消息级明细、组成增量 diff、轮次聚合、过滤、缓存省钱额、pricing_info |
| 0.4.0 | 细节打磨：CJK 加权估算、全输出本机时区、热力图本地日历、走势降采样、标题/路径清洗、`/insights` 命令 |
| 0.5.0 | 检索与出表：`context_search` 跨会话全文搜索（字节级预筛+去重+request 跳转）、`context_export` CSV 导出、insights 压缩 KPI 与工作区分布、session_list 过滤 |
| 0.6.0 | 子 agent 管理：`subagents` 注册表（状态推断/单一父归属/孤立标记/子父开销比）+ `/subagents` 命令；fleet 与 subagents 共用 computeFamily；insights `brief` 精简模式与 `/insights` 默认精简——控制输出体积、避免挤占会话窗口 |
| 0.7.0 | 实时性与前瞻：subagents **运行中实况**（最近工具动作链/token 速度/当前窗口，`live:false` 可关）；trend **窗口压力投影**（增长中位增量外推到窗口 80% 压缩触发区） |
| 0.8.0 | 评估与回顾：`context_health` 四维健康度评分（单会话诊断 + 最差排名）、`session_digest` 会话速览（"这个会话干了啥"）、`context_search` 正则模式（搜索基础设施谓词化） |
| 0.9.1 | 运行日志与代码审计修复：索引每 60s 自动增量刷新（修复长会话数据陈旧）、并发落盘合并（session 隔离下多 server 写同一索引）、耗时显示 fmtDur（消除 "Ms" 歧义）、父归属按启动时间序、CSV 公式注入防护、实况描述截断 |
| 1.0.0 | 里程碑：`context_compare` 会话对比、`session_digest` 批量速览（recent:N）、`/weekly` 周报命令；真机 dogfood 验证（60s 刷新在生产会话生效）。14 工具 + 4 命令，功能面收敛 |
| 1.1.0 | 工程加固：零依赖测试套件（`node --test mcp/test/`，16 例：成本口径/组成加权/索引增量/协议握手）；`pricing_refresh` 在线刷新价格表（opt-in 网络请求，写入自动层不覆盖手写配置）。15 工具 + 4 命令 |
