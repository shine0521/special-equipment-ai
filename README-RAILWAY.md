# 🚀 Railway 云端部署指南

## 快速开始（5分钟上线）

### 第一步：上传代码到 GitHub

Railway 通过 GitHub 自动部署，需要先把代码上传：

```bash
cd ~/special-equipment-v3/backend

# 初始化 Git（如果还没有）
git init
git add .
git commit -m "feat: 特种设备AI系统 v4.0"

# 创建 GitHub 仓库后添加远程（替换为你的仓库地址）
git remote add origin https://github.com/你的用户名/special-equipment-ai.git
git branch -M main
git push -u origin main
```

### 第二步：在 Railway 创建项目

1. 访问 [railway.app](https://railway.app)，用 GitHub 登录
2. 点击 **New Project** → **Deploy from GitHub repo**
3. 选择你刚推送的 `special-equipment-ai` 仓库
4. Railway 会自动检测为 Node.js 项目

### 第三步：配置持久化存储（⚠️ 关键！）

Railway 免费版使用临时文件系统，**每次重启数据会丢失**，必须开启持久化：

1. 在 Railway 项目面板，点击你的服务
2. 左侧菜单 → **Settings** → **Storage**
3. 点击 **Add Persistent Disk**
4. 记住生成的路径（通常是 `/var/opt/data`）
5. 在 **Variables** 中添加：
   ```
   DATA_DIR=/var/opt/data
   NODE_ENV=production
   ```

### 第四步：部署

Railway 会自动：
- 运行 `npm install` 安装依赖
- 运行 `npm run postinstall` 编译 `better-sqlite3`
- 运行 `npm start` 启动服务

等待约 2-3 分钟，看到 ✅ 状态即可。

### 第五步：访问系统

Railway 会分配一个 `.up.railway.app` 域名，例如：
```
https://special-equipment-ai.up.railway.app
```

移动端直接访问 `/mobile` 路径：
```
https://special-equipment-ai.up.railway.app/mobile
```

---

## 📋 演示账号

| 角色 | 邮箱 | 密码 |
|------|------|------|
| 管理员 | admin@demo.com | 123456 |
| 审核员 | auditor@demo.com | 123456 |
| 普通用户 | user@demo.com | 123456 |

---

## 🔧 常用配置

### 自定义域名
- Railway Settings → **Networking** → **Custom Domains**
- 添加你的域名并配置 DNS 指向

### 环境变量说明

| 变量名 | 说明 | 示例 |
|--------|------|------|
| `DATA_DIR` | SQLite 数据库持久化路径 | `/var/opt/data` |
| `PORT` | 监听端口（Railway 自动设置） | `3000` |
| `NODE_ENV` | 运行环境 | `production` |

### 开启AI增强（可选）

系统默认使用**规则引擎**，无需额外配置即可使用全部核心功能。

如需更强AI能力（需付费 GPU 实例）：
```bash
# 在 Railway 环境中安装 Ollama（高级）
```

---

## ⚠️ 注意事项

1. **免费版限制**：每月 500 小时、$5 额度、有限存储
2. **休眠策略**：免费版无流量时自动休眠（冷启动约 10-30 秒）
3. **SQLite 限制**：高并发写入场景建议升级到 Pro 套餐或换用 PostgreSQL
4. **数据备份**：定期通过 `/api/export` 或数据库工具导出重要数据

---

## 🔄 更新部署

代码推送到 GitHub 后，Railway 自动触发重新部署。

手动触发：
```bash
railway up
```

查看日志：
```bash
railway logs
```
