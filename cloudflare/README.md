# Cloudflare 部署指南

## 概述

本目录包含将特种设备电梯AI系统部署到 Cloudflare Workers 的全部配置。

## 文件说明

- `worker.js` — Cloudflare Worker 主程序（内置所有页面和API）
- `wrangler.toml` — Workers 配置文件
- `schema.sql` — D1 数据库初始化脚本
- `.github/workflows/deploy.yml` — GitHub Actions 自动部署脚本

## 手动部署步骤

如果 GitHub Actions 自动部署失败，按以下步骤手动部署：

### 1. 安装 Wrangler

```bash
npm install -g wrangler
```

### 2. 登录 Cloudflare

```bash
wrangler login
# 会打开浏览器，完成 GitHub 授权
```

### 3. 创建 D1 数据库

```bash
wrangler d1 create elevator-ai-db
# 复制返回的 database_id
```

### 4. 更新 wrangler.toml

将 `YOUR_D1_DATABASE_ID` 替换为实际 ID：

```toml
[[d1_databases]]
binding = "DB"
database_name = "elevator-ai-db"
database_id = "实际的ID"  # 替换这里
```

同样更新 `YOUR_KV_NAMESPACE_ID`。

### 5. 创建 KV 命名空间

```bash
wrangler kv:namespace create "ev3_sessions"
# 复制返回的 id
```

### 6. 初始化数据库

```bash
wrangler d1 execute elevator-ai-db --file=./schema.sql --remote
```

### 7. 部署

```bash
wrangler deploy
```

### 8. 自定义域名（可选）

访问 https://dash.cloudflare.com → Workers & Pages → elevator-ai → Custom Domains

## GitHub Actions 自动部署

仓库已配置 GitHub Actions。只需：

1. 在 GitHub 仓库设置中添加 `CLOUDFLARE_API_TOKEN` secret
2. Token 需要以下权限：
   - `Workers AI: Edit`
   - `Workers KV Storage: Edit`  
   - `Workers: Edit`
   - `Account Settings: Read`

3. 每次 push 到 main 分支自动部署

## 演示账号

- 管理员：admin@demo.com / 123456
- 审核员：auditor@demo.com / 123456
- 普通用户：user@demo.com / 123456

## API 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | /api/login | 用户登录 |
| GET | /api/dashboard/stats | 仪表盘统计 |
| POST | /api/ai/classify | AI 分类 |
| POST | /api/discriminate | 提交判别记录 |
| GET | /api/discrimination-records | 判别历史 |
| GET | /api/audit-tasks | 审核任务 |
| POST | /api/audit-tasks | 审核操作 |
| GET | /api/templates | 模板列表 |
| GET | /api/regulations | 法规列表 |
| GET | /api/operation-logs | 操作日志 |
