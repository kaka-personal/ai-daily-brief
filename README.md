# AI Daily Brief

每天北京时间 08:00、12:00、18:00，用 GitHub Actions 自动抓取 AI 资讯，交给大模型（OpenAI 兼容接口）整理成中文早报，并在本仓库开一个 Issue。零依赖，只需要 Node 20+。

## 流程

```
定时触发 (cron) → 抓 RSS + Hacker News → 过滤最近 24h / 去重 → LLM 生成中文摘要 → 创建 Issue
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

- `sources.json`：RSS 源、Hacker News 关键词和最低分数、回看时长、最大条数、首个栏目名（`highlightsTitle`）
- 生成流程：模型先挑选并分组 → 抓取入选新闻的原文 → 逐条基于原文生成中文摘要、要点和"为什么重要"；数据写入 `docs/data/<日期>.json`，页面据此渲染卡片和详情弹窗
- `OPENAI_API_KEY` / `OPENAI_BASE_URL` / `OPENAI_MODEL`：任何 OpenAI 兼容的 `/chat/completions` 接口都可以用
- `BRIEF_TZ`：日期所用的时区，默认 `Asia/Shanghai`
- 推送时间：修改 `.github/workflows/daily-brief.yml` 里的 cron（使用 UTC 时间）。同一天多次运行会整体重新生成当天内容，并更新同一个 Issue

## 注意

- 公开仓库连续 60 天没有提交，定时任务会被 GitHub 自动停用，需要手动重新启用。
- 定时任务高峰期可能延迟几分钟到几十分钟。
