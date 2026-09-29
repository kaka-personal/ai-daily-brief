# AI Daily Brief

用 GitHub Actions 每小时检查一次 AI 资讯，有新新闻时，交给大模型（OpenAI 兼容接口）整理成中文早报，并在本仓库开一个 Issue。零依赖，只需要 Node 20+。

## 流程

```
每小时 → 抓 RSS + Hacker News → 与今天已处理的链接对比 → 没有新条目就结束；有则只对新条目挑选分组、生成详情并追加到当天页面 → 部署 Pages、更新 Issue
```

## 部署

1. 仓库 Settings → Secrets and variables → Actions：
   - **Secrets** 页新建 `OPENAI_API_KEY`
   - **Variables** 页新建 `OPENAI_BASE_URL`（例如 `https://xxx/v1`）和 `OPENAI_MODEL`
2. 仓库 Settings → Pages → Build and deployment → Source 选 **GitHub Actions**（免费账号需要仓库为 Public）。
3. 进入 Actions 页面，启用 workflow，点击 **Run workflow** 手动跑一次验证。每天的早报会存档到 `docs/briefs/`，网站地址为 `https://<用户名>.github.io/ai-daily-brief/`。
4. 仓库页面点击 **Watch → Custom → Issues**，之后会收到邮件或 App 推送。

## 本地调试

```bash
npm run dry:raw   # 只抓数据，不调用模型，也不创建 Issue
npm run dry       # 调用模型生成早报，只打印不创建 Issue（需先设置下面三个环境变量）
```

## 配置

- `sources.json`：RSS 源、Hacker News 关键词和最低分数、回看时长、最大条数、固定栏目（`sections`，第一个是今日要点，每天都按这个顺序显示）
- 生成流程：模型先挑选并分组 → 抓取入选新闻的原文 → 逐条基于原文生成中文摘要、要点和"为什么重要"；数据写入 `docs/data/<日期>.json`，页面据此渲染卡片和详情弹窗
- `OPENAI_API_KEY` / `OPENAI_BASE_URL` / `OPENAI_MODEL`：任何 OpenAI 兼容的 `/chat/completions` 接口都可以用
- `BRIEF_TZ`：日期所用的时区，默认 `Asia/Shanghai`
- 检查频率：workflow 每次运行结束后等待约 58 分钟再触发下一次（`next` job，自我接力），约每小时一轮；cron 只作备用（GitHub 定时任务对本仓库一直未触发）。要停止，在 Actions 页面取消正在运行的那次，或禁用该 workflow；链条断了手动 Run workflow 一次即可恢复。没有新条目的运行不调用模型、不部署；当天已处理的链接记录在 `docs/data/<日期>.json` 的 `seen` 字段

## 注意

- 公开仓库连续 60 天没有提交，定时任务会被 GitHub 自动停用，需要手动重新启用。
- 定时任务高峰期可能延迟几分钟到几十分钟。
