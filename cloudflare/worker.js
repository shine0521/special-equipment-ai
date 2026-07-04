/**
 * 特种设备电梯AI系统 - Cloudflare Worker
 * 替代 Express.js，部署到 Cloudflare Workers
 * 
 * 架构：
 *   - Session 管理：KV（ev3_sessions 命名空间）
 *   - 数据存储：D1（SQLite，elevator-ai-db）
 *   - 哈希链：D1 存储区块
 *   - 规则引擎：内置（无需 Ollama/Transformers）
 */

const SALT = 'ev3_2024_elevator_safety_alt';


// ============ 密码哈希 (Web Crypto API) ============
async function hashPassword(password) {
  const data = new TextEncoder().encode(SALT + password);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}


// ============ Session 管理 ============
async function getSession(request, env) {
  const cookies = parseCookies(request.headers.get('Cookie') || '');
  const token = cookies['ev3_tok'];
  if (!token) return null;
  try {
    const key = 'sess:' + token;
    const data = await env.SESSIONS.get(key);
    if (!data) return null;
    return JSON.parse(data);
  } catch {
    return null;
  }
}

async function createSession(user, env) {
  const token = await generateToken(user.email);
  const session = {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    created: Date.now()
  };
  await env.SESSIONS.put('sess:' + token, JSON.stringify(session), { expirationTtl: 86400 });
  return token;
}

async function generateToken(email) {
  const data = new TextEncoder().encode(email + ':' + Date.now() + ':' + Math.random());
  const hash = await crypto.subtle.digest('SHA-256', data);
  return btoa(String.fromCharCode(...new Uint8Array(hash))).replace(/\//g, '_').replace(/\+/g, '-').slice(0, 64);
}


// ============ 响应构建 ============
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
  });
}

function html(content, status = 200) {
  return new Response(content, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8' }
  });
}

function redirect(location) {
  return new Response(null, { status: 302, headers: { 'Location': location } });
}

function requireAuth(session) {
  if (!session) return json({ error: '未登录' }, 401);
  return null;
}

function requireRole(session, ...roles) {
  const denied = requireAuth(session);
  if (denied) return denied;
  if (!roles.includes(session.role)) return json({ error: '权限不足' }, 403);
  return null;
}


// ============ 路由处理 ============

// 首页 / 仪表盘
async function handleDashboard(session, env) {
  const today = new Date().toISOString().slice(0, 10);
  
  const todayCount = await env.DB
    .prepare("SELECT COUNT(*) as c FROM discrimination_records WHERE date(created_at) = ?")
    .bind(today).first();
  
  const pendingCount = await env.DB
    .prepare("SELECT COUNT(*) as c FROM audit_tasks WHERE status = 'pending'").first();
  
  const activeTemplates = await env.DB
    .prepare("SELECT COUNT(*) as c FROM templates WHERE status = 'published'").first();
  
  const total = await env.DB
    .prepare("SELECT COUNT(*) as c FROM discrimination_records").first();
  
  const compliant = await env.DB
    .prepare("SELECT COUNT(*) as c FROM discrimination_records WHERE final_result = '合规'").first();
  
  const recent = await env.DB
    .prepare("SELECT * FROM discrimination_records ORDER BY id DESC LIMIT 6")
    .all();
  
  const chartData = await env.DB
    .prepare(`SELECT date(created_at) as day,
              SUM(CASE WHEN final_result='合规' THEN 1 ELSE 0 END) as ok,
              SUM(CASE WHEN final_result='不合规' THEN 1 ELSE 0 END) as ng,
              SUM(CASE WHEN final_result='待人工' THEN 1 ELSE 0 END) as mb
              FROM discrimination_records
              WHERE created_at >= date('now', '-7 days')
              GROUP BY date(created_at) ORDER BY day`)
    .all();
  
  const compliantRate = total?.c > 0 ? Math.round((compliant?.c / total.c) * 100) + '%' : '0%';
  
  return html(DASHBOARD_HTML
    .replace('{{user.name}}', session.name)
    .replace('{{user.role}}', session.role)
    .replace('{{todayDiscriminations}}', todayCount?.c || 0)
    .replace('{{pendingAudits}}', pendingCount?.c || 0)
    .replace('{{activeTemplates}}', activeTemplates?.c || 0)
    .replace('{{compliantRate}}', compliantRate)
    .replace('{{recentRecords}}', recent?.results?.map(r => `
      <tr onclick="location.href='/record/${r.id}'" style="cursor:pointer">
        <td>${r.id}</td>
        <td>${r.module_name || '-'}</td>
        <td>${r.record_content?.slice(0, 40) || ''}...</td>
        <td><span class="badge badge-${r.final_result === '合规' ? 'success' : r.final_result === '不合规' ? 'danger' : 'warning'}">${r.final_result}</span></td>
        <td>${r.created_at?.slice(0, 16)}</td>
      </tr>`).join('') || '')
    .replace('{{chartData}}', JSON.stringify(chartData.results || []))
  );
}


// 登录
async function handleLogin(request, env) {
  if (request.method === 'GET') {
    return html(LOGIN_HTML);
  }
  
  const form = await request.formData();
  const email = form.get('email') || '';
  const password = form.get('password') || '';
  
  if (!email || !password) {
    return html(LOGIN_HTML.replace('{{error}}', '请输入邮箱和密码'));
  }
  
  const user = await env.DB
    .prepare("SELECT * FROM users WHERE email = ?")
    .bind(email).first();
  
  if (!user) {
    return html(LOGIN_HTML.replace('{{error}}', '用户不存在'));
  }
  
  const passwordHash = await hashPassword(password);
  if (passwordHash !== user.password_hash) {
    return html(LOGIN_HTML.replace('{{error}}', '密码错误'));
  }
  
  const token = await createSession(user, env);
  
  return new Response(null, {
    status: 302,
    headers: {
      'Location': '/',
      'Set-Cookie': `ev3_tok=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`
    }
  });
}


// AI 分类
async function handleAiClassify(request, session, env) {
  const { content, moduleName } = await request.json();
  if (!content) return json({ error: '内容不能为空' }, 400);
  
  const templates = await env.DB
    .prepare("SELECT * FROM templates WHERE status = 'published'").all();
  
  const rules = await env.DB
    .prepare("SELECT * FROM rule_engine_rules WHERE enabled = 1").all();
  
  let matched = null;
  let confidence = 0;
  let reason = '';
  
  const contentLower = content.toLowerCase();
  
  for (const rule of rules.results || []) {
    const keywords = (rule.keywords || '').split(',').map(k => k.trim().toLowerCase()).filter(Boolean);
    let hits = 0;
    for (const kw of keywords) {
      if (kw && contentLower.includes(kw)) hits++;
    }
    const score = keywords.length > 0 ? hits / keywords.length : 0;
    if (score > confidence && score > 0.3) {
      confidence = score;
      matched = rule;
    }
  }
  
  const result = matched ? matched.action_value : '待人工';
  const ruleResult = matched?.rule_name || '通用分类';
  
  return json({
    result,
    confidence: Math.round(confidence * 100),
    matchedRule: ruleResult,
    reason: matched ? `命中规则「${matched.rule_name}」` : '无匹配规则，建议人工审核',
    suggestions: matched?.suggestions ? JSON.parse(matched.suggestions) : [],
    method: 'rule'
  });
}


// 提交判别记录
async function handleDiscriminate(request, session, env) {
  const { content, moduleName, aiResult, aiConfidence, aiReason, matchedRule } = await request.json();
  
  const record = await env.DB
    .prepare(`INSERT INTO discrimination_records
      (module_name, record_content, ai_result, ai_confidence, ai_reason, matched_rule, final_result, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING *`)
    .bind(
      moduleName || '电梯设备检查',
      content,
      aiResult || '待人工',
      aiConfidence || 0,
      aiReason || '',
      matchedRule || '',
      aiResult || '待人工',
      session.id
    ).first();
  
  // 哈希链
  await appendHashChain(env, 'discrimination_records', record.id, `新增判别记录: ${aiResult || '待人工'}`);
  
  // 如需审核，创建任务
  if (aiResult === '待人工' || aiResult === '不合规') {
    await env.DB
      .prepare(`INSERT INTO audit_tasks (record_id, status, assigned_to, priority)
        VALUES (?, 'pending', NULL, ?)`)
      .bind(record.id, aiResult === '不合规' ? 'high' : 'normal');
  }
  
  return json({ success: true, record });
}


// 哈希链
async function appendHashChain(env, table, recordId, description) {
  const prev = await env.DB
    .prepare("SELECT hash FROM hash_chain ORDER BY block_index DESC LIMIT 1").first();
  
  const prevHash = prev?.hash || '0'.repeat(64);
  const timestamp = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
  const data = `${table}:${recordId}:${description}:${timestamp}`;
  
  const encoder = new TextEncoder();
  const hashData = encoder.encode(prevHash + data);
  const hashBuffer = await crypto.subtle.digest('SHA-256', hashData);
  const hash = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
  
  const blockIndex = await env.DB
    .prepare("SELECT COALESCE(MAX(block_index), 0) + 1 as idx FROM hash_chain").first();
  
  await env.DB
    .prepare(`INSERT INTO hash_chain (block_index, table_name, record_id, description, timestamp, prev_hash, hash, operator)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(blockIndex.idx, table, recordId, description, timestamp, prevHash, hash, 'system');
}


// ============ 内联 HTML 模板 ============

const LOGIN_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>登录 - 特种设备电梯AI系统</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'PingFang SC','Microsoft YaHei',sans-serif;background:linear-gradient(135deg,#0f2027,#203a43,#2c5364);min-height:100vh;display:flex;align-items:center;justify-content:center}
.card{background:#fff;border-radius:16px;padding:40px;width:380px;box-shadow:0 20px 60px rgba(0,0,0,0.3)}
.logo{text-align:center;margin-bottom:30px}
.logo h1{color:#0f2027;font-size:22px;font-weight:700}
.logo p{color:#666;font-size:13px;margin-top:4px}
.logo .icon{font-size:48px;margin-bottom:10px}
.error{background:#fee;border:1px solid #fca;padding:12px;border-radius:8px;color:#c00;font-size:13px;margin-bottom:16px;text-align:center}
form{display:flex;flex-direction:column;gap:16px}
input{padding:12px 16px;border:1.5px solid #ddd;border-radius:10px;font-size:15px;transition:border-color .2s}
input:focus{outline:none;border-color:#2c5364}
.btn{background:linear-gradient(135deg,#203a43,#2c5364);color:#fff;border:none;padding:14px;border-radius:10px;font-size:16px;font-weight:600;cursor:pointer;transition:transform .1s}
.btn:hover{transform:translateY(-1px)}
.hint{text-align:center;margin-top:20px;font-size:12px;color:#999}
.hint span{color:#2c5364;font-weight:600}
</style>
</head>
<body>
<div class="card">
<div class="logo"><div class="icon">🏢</div><h1>特种设备电梯AI系统</h1><p>特种设备安全智能判别平台</p></div>
<div class="error" id="err">{{error}}</div>
<form method="POST" action="/login">
<input name="email" type="email" placeholder="邮箱" required>
<input name="password" type="password" placeholder="密码" required>
<button type="submit" class="btn">登录系统</button>
</form>
<div class="hint">演示账号: admin@demo.com / 123456</div>
</div>
<script>document.querySelector('.error').style.display='none';</script>
</body></html>`;

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>仪表盘 - 特种设备电梯AI系统</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'PingFang SC','Microsoft YaHei',sans-serif;background:#f0f2f5;min-height:100vh}
.header{background:linear-gradient(135deg,#1a3a4a,#0d2137);color:#fff;padding:20px 32px;display:flex;justify-content:space-between;align-items:center}
.header h1{font-size:18px;font-weight:600}
.header-right{font-size:13px;opacity:.8}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px;padding:24px 32px}
.stat{background:#fff;border-radius:12px;padding:24px;box-shadow:0 2px 8px rgba(0,0,0,.06)}
.stat-num{font-size:32px;font-weight:700;color:#1a3a4a}
.stat-label{color:#888;font-size:13px;margin-top:4px}
.main{padding:0 32px 32px;display:grid;grid-template-columns:1fr 320px;gap:20px}
.card{background:#fff;border-radius:12px;padding:24px;box-shadow:0 2px 8px rgba(0,0,0,.06)}
.card h3{font-size:15px;color:#333;margin-bottom:16px;padding-bottom:12px;border-bottom:2px solid #f0f2f5}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;padding:10px 8px;color:#888;font-weight:500;border-bottom:1px solid #f0f2f5}
td{padding:10px 8px;border-bottom:1px solid #f5f5f5;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
tr:hover{background:#fafafa;cursor:pointer}
.badge{display:inline-block;padding:2px 10px;border-radius:12px;font-size:12px;font-weight:500}
.badge-success{background:#e6f7e6;color:#2e7d32}
.badge-danger{background:#ffebee;color:#c62828}
.badge-warning{background:#fff8e1;color:#f57f17}
.nav{display:flex;gap:8px;margin-bottom:16px}
.nav a{padding:8px 16px;background:#f0f2f5;border-radius:8px;font-size:13px;color:#333;text-decoration:none;transition:background .2s}
.nav a:hover,.nav a.active{background:#1a3a4a;color:#fff}
.role-badge{background:#4caf50;color:#fff;padding:2px 10px;border-radius:10px;font-size:12px}
</style>
</head>
<body>
<div class="header">
<h1>🏢 特种设备电梯AI系统</h1>
<div class="header-right">{{user.name}} <span class="role-badge">{{user.role}}</span> | <a href="/logout" style="color:#fff;margin-left:8px">退出</a></div>
</div>
<div class="stats">
<div class="stat"><div class="stat-num">{{todayDiscriminations}}</div><div class="stat-label">今日判别</div></div>
<div class="stat"><div class="stat-num">{{pendingAudits}}</div><div class="stat-label">待审任务</div></div>
<div class="stat"><div class="stat-num">{{activeTemplates}}</div><div class="stat-label">激活模板</div></div>
<div class="stat"><div class="stat-num">{{compliantRate}}</div><div class="stat-label">合规率</div></div>
</div>
<div class="main">
<div class="card">
<h3>📋 最新判别记录</h3>
<table><thead><tr><th>ID</th><th>模块</th><th>内容摘要</th><th>结果</th><th>时间</th></tr></thead>
<tbody>{{recentRecords}}</tbody></table>
</div>
<div class="card">
<h3>⚡ 快捷操作</h3>
<div class="nav"><a href="/discriminate">新建判别</a><a href="/history">判别历史</a><a href="/audit">审核任务</a></div>
<div class="nav"><a href="/knowledge">合规知识库</a><a href="/templates">模板管理</a></div>
</div>
</div>
</body></html>`;


// ============ 主入口 ============
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const session = await getSession(request, env);

    // 公开路由
    if (path === '/login' || path === '/api/login') {
      return handleLogin(request, env);
    }
    if (path === '/api/health') {
      return json({ status: 'ok', env: 'cloudflare-workers', version: '4.0.0' });
    }

    // 需认证
    if (!session) {
      if (path.startsWith('/api/')) return json({ error: '未登录' }, 401);
      return redirect('/login');
    }

    // 登出
    if (path === '/logout') {
      const cookies = parseCookies(request.headers.get('Cookie') || '');
      if (cookies.ev3_tok) {
        await env.SESSIONS.delete('sess:' + cookies.ev3_tok);
      }
      return new Response(null, {
        status: 302,
        headers: { 'Location': '/login', 'Set-Cookie': 'ev3_tok=; Path=/; Max-Age=0' }
      });
    }

    // 页面
    if (path === '/' || path === '/dashboard') return handleDashboard(session, env);
    if (path === '/discriminate') return html(DISCRIMINATE_HTML);
    if (path === '/history') return handleHistory(session, env);
    if (path === '/audit') return handleAudit(session, env);
    if (path === '/templates') return handleTemplates(session, env);
    if (path === '/knowledge') return handleKnowledge(session, env);
    if (path === '/logs') return handleLogs(session, env);
    if (path === '/settings') return handleSettings(session, env);

    // API
    if (path === '/api/user/me') return json({ user: session });
    if (path === '/api/dashboard/stats') return handleDashboardStats(session, env);
    if (path === '/api/ai/classify' && request.method === 'POST') return handleAiClassify(request, session, env);
    if (path === '/api/discriminate' && request.method === 'POST') return handleDiscriminate(request, session, env);
    if (path === '/api/discrimination-records') return handleRecords(session, env, url);
    if (path === '/api/templates') return handleTemplatesApi(session, env, request);
    if (path === '/api/regulations') return handleRegulationsApi(session, env, request);
    if (path === '/api/audit-tasks') return handleAuditTasksApi(session, env, request);
    if (path === '/api/operation-logs') return handleLogsApi(session, env, url);
    if (path === '/api/ai/status') return json({ method: 'rule', available: true, confidence: 95 });

    return html('<h1>404 Not Found</h1><p>页面不存在</p>', 404);
  }
};


// ============ 辅助函数 ============
function parseCookies(header) {
  const result = {};
  if (!header) return result;
  for (const part of header.split(';')) {
    const [name, ...val] = part.trim().split('=');
    if (name) result[name.trim()] = decodeURIComponent(val.join('='));
  }
  return result;
}

async function handleDashboardStats(session, env) {
  const today = new Date().toISOString().slice(0, 10);
  const todayC = await env.DB.prepare("SELECT COUNT(*) as c FROM discrimination_records WHERE date(created_at) = ?").bind(today).first();
  const pendingC = await env.DB.prepare("SELECT COUNT(*) as c FROM audit_tasks WHERE status = 'pending'").first();
  const activeC = await env.DB.prepare("SELECT COUNT(*) as c FROM templates WHERE status = 'published'").first();
  const total = await env.DB.prepare("SELECT COUNT(*) as c FROM discrimination_records").first();
  const compliant = await env.DB.prepare("SELECT COUNT(*) as c FROM discrimination_records WHERE final_result = '合规'").first();
  return json({
    todayDiscriminations: todayC?.c || 0,
    pendingAudits: pendingC?.c || 0,
    activeTemplates: activeC?.c || 0,
    compliantRate: total?.c > 0 ? Math.round((compliant?.c / total.c) * 100) + '%' : '0%'
  });
}

async function handleRecords(session, env, url) {
  const page = parseInt(url.searchParams.get('page')) || 1;
  const limit = 20;
  const offset = (page - 1) * limit;
  const search = url.searchParams.get('search') || '';
  const filter = url.searchParams.get('result') || '';
  
  let query = "SELECT * FROM discrimination_records WHERE 1=1";
  const bindings = [];
  if (search) { query += " AND record_content LIKE ?"; bindings.push('%' + search + '%'); }
  if (filter) { query += " AND final_result = ?"; bindings.push(filter); }
  query += " ORDER BY id DESC LIMIT ? OFFSET ?";
  bindings.push(limit, offset);
  
  const rows = await env.DB.prepare(query).bind(...bindings).all();
  const total = await env.DB.prepare("SELECT COUNT(*) as c FROM discrimination_records").first();
  
  return json({ records: rows.results, total: total?.c || 0, page, limit });
}

async function handleLogs(session, env) {
  const logs = await env.DB.prepare("SELECT * FROM hash_chain ORDER BY block_index DESC LIMIT 50").all();
  return html(LOG_HTML.replace('{{logs}}', logs.results?.map(l => `
    <tr><td>${l.block_index}</td><td>${l.table_name}</td><td>${l.record_id}</td>
    <td>${l.description}</td><td>${l.timestamp}</td>
    <td style="font-family:monospace;font-size:11px;max-width:100px;overflow:hidden">${l.hash}</td></tr>`).join('')));
}

async function handleTemplates(session, env) {
  const templates = await env.DB.prepare("SELECT * FROM templates ORDER BY id").all();
  return html(TEMPLATE_HTML.replace('{{templates}}', templates.results?.map(t => `
    <div class="template-card">
      <h4>${t.name}</h4><p>${t.description || ''}</p>
      <span class="badge badge-${t.status === 'published' ? 'success' : 'warning'}">${t.status}</span>
    </div>`).join('')));
}

async function handleKnowledge(session, env) {
  const regs = await env.DB.prepare("SELECT * FROM regulations ORDER BY code").all();
  return html(KNOWLEDGE_HTML.replace('{{regulations}}', regs.results?.map(r => `
    <div class="reg-card">
      <h4>${r.code} - ${r.name}</h4>
      <p>${r.description || '暂无描述'}</p>
    </div>`).join('')));
}

async function handleAudit(session, env) {
  if (!['auditor','admin'].includes(session.role)) return json({ error: '权限不足' }, 403);
  const tasks = await env.DB.prepare("SELECT * FROM audit_tasks WHERE status = 'pending' ORDER BY priority DESC, id DESC LIMIT 50").all();
  return html(AUDIT_HTML.replace('{{tasks}}', tasks.results?.map(t => `
    <tr><td>${t.id}</td><td>${t.record_id}</td><td><span class="badge badge-warning">待审核</span></td>
    <td>${t.priority === 'high' ? '🔴 高' : '🟡 普通'}</td><td>${t.created_at?.slice(0,16)}</td>
    <td><button onclick="approve(${t.id})">✅</button><button onclick="reject(${t.id})">❌</button></td></tr>`).join('')));
}

async function handleSettings(session, env) {
  return html(SETTINGS_HTML.replace('{{user.name}}', session.name).replace('{{user.email}}', session.email));
}

async function handleTemplatesApi(session, env, request) {
  if (request.method === 'GET') {
    const rows = await env.DB.prepare("SELECT * FROM templates ORDER BY id").all();
    return json(rows.results);
  }
  if (session.role !== 'admin') return json({ error: '权限不足' }, 403);
  const body = await request.json();
  const result = await env.DB
    .prepare("INSERT INTO templates (name, description, status) VALUES (?, ?, 'draft') RETURNING *")
    .bind(body.name, body.description).first();
  return json(result, 201);
}

async function handleRegulationsApi(session, env, request) {
  if (request.method === 'GET') {
    const rows = await env.DB.prepare("SELECT * FROM regulations ORDER BY code").all();
    return json(rows.results);
  }
  if (session.role !== 'admin') return json({ error: '权限不足' }, 403);
  const body = await request.json();
  const result = await env.DB
    .prepare("INSERT INTO regulations (code, name, description) VALUES (?, ?, ?) RETURNING *")
    .bind(body.code, body.name, body.description).first();
  return json(result, 201);
}

async function handleAuditTasksApi(session, env, request) {
  if (!['auditor','admin'].includes(session.role)) return json({ error: '权限不足' }, 403);
  if (request.method === 'GET') {
    const rows = await env.DB.prepare("SELECT * FROM audit_tasks ORDER BY id DESC LIMIT 50").all();
    return json(rows.results);
  }
  const { id, action, comment } = await request.json();
  const newStatus = action === 'approve' ? 'approved' : 'rejected';
  await env.DB.prepare("UPDATE audit_tasks SET status = ?, auditor_comment = ? WHERE id = ?")
    .bind(newStatus, comment || '', id);
  return json({ success: true });
}

async function handleLogsApi(session, env, url) {
  const page = parseInt(url.searchParams.get('page')) || 1;
  const rows = await env.DB.prepare("SELECT * FROM hash_chain ORDER BY block_index DESC LIMIT 20 OFFSET ?")
    .bind((page - 1) * 20).all();
  return json(rows.results);
}

const DISCRIMINATE_HTML = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>新建判别</title><style>body{font-family:'PingFang SC',sans-serif;background:#f0f2f5;padding:24px}.container{max-width:700px;margin:0 auto;background:#fff;border-radius:12px;padding:32px}textarea{width:100%;height:120px;padding:12px;border:1.5px solid #ddd;border-radius:10px;resize:vertical;font-size:14px}button{padding:12px 24px;background:#1a3a4a;color:#fff;border:none;border-radius:8px;cursor:pointer;font-size:15px}.result{margin-top:20px;padding:16px;background:#f8fafc;border-radius:8px;border-left:4px solid #1a3a4a}</style></head><body><div class=container><h2>⚡ 新建合规判别</h2><p style=color:#888;margin-bottom:16px>输入设备检查记录内容，AI将自动分析合规性</p><textarea id=content placeholder="请输入检查内容，如：电梯维保记录显示最近一次保养日期为2024年1月15日，曳引机运行正常..."></textarea><br><br><button onclick=submitDiscriminate()>提交判别</button><div id=result></div></div><script>async function submitDiscriminate(){const c=document.getElementById('content').value;if(!c)return;document.getElementById('result').innerHTML='⏳ 分析中...';const r=await fetch('/api/ai/classify',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({content:c,moduleName:'电梯设备检查'}),credentials:'include'});const d=await r.json();document.getElementById('result').innerHTML='<pre>'+JSON.stringify(d,null,2)+'</pre>';await fetch('/api/discriminate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({content:c,moduleName:'电梯设备检查',aiResult:d.result,aiConfidence:d.confidence,aiReason:d.reason,matchedRule:d.matchedRule}),credentials:'include'});}</script></body></html>`;

const HISTORY_HTML = `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>判别历史</title><style>body{font-family:'PingFang SC',sans-serif;background:#f0f2f5;padding:24px}table{width:100%;border-collapse:collapse;background:#fff;border-radius:12px;overflow:hidden}th,td{padding:12px 16px;text-align:left;border-bottom:1px solid #eee;font-size:14px}th{background:#1a3a4a;color:#fff}</style></head><body><h2>📋 判别历史</h2><p id=status>加载中...</p><table id=tbl><thead><tr><th>ID</th><th>模块</th><th>内容</th><th>结果</th><th>时间</th></tr></thead><tbody id=tbody></tbody></table><script>fetch('/api/discrimination-records',{credentials:'include'}).then(r=>r.json()).then(d=>{document.getElementById('status').textContent='共 '+d.total+' 条记录';d.records.forEach(r=>{const b=r.final_result==='合规'?'badge-success':r.final_result==='不合规'?'badge-danger':'badge-warning';document.getElementById('tbody').innerHTML+='<tr><td>'+r.id+'</td><td>'+r.module_name+'</td><td>'+(r.record_content||'').slice(0,50)+'</td><td><span class="badge '+b+'">'+r.final_result+'</span></td><td>'+r.created_at?.slice(0,16)+'</td></tr>'})})</script><style>.badge{display:inline-block;padding:2px 10px;border-radius:12px;font-size:12px}.badge-success{background:#e6f7e6;color:#2e7d32}.badge-danger{background:#ffebee;color:#c62828}.badge-warning{background:#fff8e1;color:#f57f17}</style></body></html>`;

const AUDIT_HTML = `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>审核任务</title><style>body{font-family:'PingFang SC',sans-serif;background:#f0f2f5;padding:24px}h2{margin-bottom:16px}table{width:100%;border-collapse:collapse;background:#fff;border-radius:12px}th,td{padding:12px 16px;border-bottom:1px solid #eee}th{background:#1a3a4a;color:#fff}button{padding:6px 12px;border:none;border-radius:6px;cursor:pointer;margin-right:4px}button:first-of-type{background:#4caf50;color:#fff}button:last-of-type{background:#f44336;color:#fff}</style></head><body><h2>🔍 审核任务</h2><table><thead><tr><th>ID</th><th>记录ID</th><th>状态</th><th>优先级</th><th>创建时间</th><th>操作</th></tr></thead><tbody>{{tasks}}</tbody></table><script>async function approve(id){await fetch('/api/audit-tasks',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id,action:'approve'}),credentials:'include'});location.reload()}async function reject(id){await fetch('/api/audit-tasks',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id,action:'reject'}),credentials:'include'});location.reload()}</script></body></html>`;

const TEMPLATE_HTML = `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>模板管理</title><style>body{font-family:'PingFang SC',sans-serif;background:#f0f2f5;padding:24px}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:16px}.template-card{background:#fff;border-radius:12px;padding:20px}.badge{display:inline-block;padding:2px 10px;border-radius:12px;font-size:12px}.badge-success{background:#e6f7e6;color:#2e7d32}.badge-warning{background:#fff8e1;color:#f57f17}</style></head><body><h2>📝 模板管理</h2><div class=grid>{{templates}}</div></body></html>`;

const KNOWLEDGE_HTML = `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>合规知识库</title><style>body{font-family:'PingFang SC',sans-serif;background:#f0f2f5;padding:24px}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:16px}.reg-card{background:#fff;border-radius:12px;padding:20px}h4{margin-bottom:8px;color:#1a3a4a}</style></head><body><h2>📚 合规知识库</h2><div class=grid>{{regulations}}</div></body></html>`;

const LOG_HTML = `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>操作日志</title><style>body{font-family:'PingFang SC',sans-serif;background:#f0f2f5;padding:24px}table{width:100%;border-collapse:collapse;background:#fff;border-radius:12px;overflow:hidden}th,td{padding:10px 12px;border-bottom:1px solid #eee;font-size:13px}th{background:#1a3a4a;color:#fff}</style></head><body><h2>🔗 哈希链日志</h2><table><thead><tr><th>区块</th><th>表</th><th>记录ID</th><th>描述</th><th>时间</th><th>哈希</th></tr></thead><tbody>{{logs}}</tbody></table></body></html>`;

const SETTINGS_HTML = `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>系统设置</title><style>body{font-family:'PingFang SC',sans-serif;background:#f0f2f5;padding:24px}.card{background:#fff;border-radius:12px;padding:32px;max-width:500px}</style></head><body><h2>⚙️ 系统设置</h2><div class=card><p><strong>姓名：</strong>{{user.name}}</p><p><strong>邮箱：</strong>{{user.email}}</p><p><strong>角色：</strong>{{user.role}}</p></div></body></html>`;
