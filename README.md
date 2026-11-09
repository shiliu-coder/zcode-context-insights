# zcode-context-insights

Context Insights 插件的公共发布市场仓库 —— 读取本地 ZCode 模型 IO 日志，提供上下文组成拆解、趋势/窗口压力投影、跨会话洞察与成本估算、全文搜索、CSV 导出、子 agent 会话管理与健康度评分。

功能与文档见 [context-insights/README.md](context-insights/README.md)。

## 安装

在 ZCode 中：**Plugin Marketplace → Add → Add Plugin Marketplace**，粘贴本仓库地址：

```
https://github.com/shiliu-coder/zcode-context-insights
```

然后在市场 **shiliu-coder-plugins** 中安装 **Context Insights**，重启 ZCode 生效。

## 仓库结构

```
marketplace.json          市场目录（shiliu-coder-plugins）
context-insights/         插件源码（.zcode-plugin 清单 + MCP server + 命令）
```

## License

MIT。功能设计参考 [bowenliang123/dsh-context](https://github.com/bowenliang123/dsh-context)（Apache-2.0）的数据层，为本项目原创实现，未复制其代码。
