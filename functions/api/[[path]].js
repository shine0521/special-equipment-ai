/**
 * Cloudflare Pages Functions - API 路由入口 (D1 Session 版)
 * 处理所有 /api/* 请求
 * 使用 D1 存储 Session 和所有数据
 */

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname.replace('/api/', '') || url.pathname;
  
  // 设置 CORS 头
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
  
  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }
  
  try {
    // 路由分发
    const result = await route(path, request, env, url);
    
    if (result instanceof Response) return result;
    
    return new Response(JSON.stringify(result), {
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  } catch (err) {
    console.error('API Error:', err);
    return new Response(JSON.stringify({ error: err.message || '服务器错误' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  }
}

async function route(path, request, env, url) {
  const method = request.method;
  
  // 登录
  if (path === 'login' && method === 'POST') {
    return handleLogin(request, env);
  }
  
  // 健康检查
  if (path === 'health') {
    return { status: 'ok', env: 'cloudflare-pages', version: '4.0.0-d1' };
  }
  
  // 获取 Session
  const session = await getSession(request, env);
  if (!session) {
    return new Response(JSON.stringify({ error: '未登录' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  // 用户信息
  if (path === 'user/me') {
    return { user: session };
  }
  
  // 仪表盘统计
  if (path === 'dashboard/stats') {
    return handleDashboardStats(env);
  }
  
  // AI 分类
  if (path === 'ai/classify' && method === 'POST') {
    return handleAiClassify(request, env);
  }
  
  // 提交判别
  if (path === 'discriminate' && method === 'POST') {
    return handleDiscriminate(request, env, session);
  }
  
  // 判别历史
  if (path === 'discrimination-records') {
    return handleRecords(url, env);
  }
  
  // 单条记录
  if (path.startsWith('discrimination-records/')) {
    const id = path.split('/')[1];
    return handleRecord(id, env);
  }
  
  // 模板
  if (path === 'templates') {
    return handleTemplates(method, request, env, session);
  }
  
  // 法规
  if (path === 'regulations') {
    return handleRegulations(method, request, env, session);
  }
  
  // 审核任务
  if (path === 'audit-tasks') {
    return handleAuditTasks(method, request, env, session);
  }
  
  // 日志
  if (path === 'operation-logs') {
    return handleLogs(url, env);
  }
  
  // AI 状态
  if (path === 'ai/status') {
    return { method: 'rule', available: true, confidence: 95 };
  }
  
  return { error: '未找到接口' };
}

// ============ Session (D1) ============
async function getSession(request, env) {
  const cookies = parseCookies(request.headers.get('Cookie') || '');
  const token = cookies['ev3_tok'];
  if (!token) return null;
  try {
    const row = await env.DB
      .prepare("SELECT data, expires_at FROM sessions WHERE id = ? AND expires_at > unixepoch()")
      .bind(token).first();
    if (!row) return null;
    return JSON.parse(row.data);
  } catch {
    return null;
  }
}

async function createSession(user, env) {
  const token = await generateToken(user.email);
  const session = { id: user.id, email: user.email, name: user.name, role: user.role, created: Date.now() };
  const expiresAt = Math.floor(Date.now() / 1000) + 86400; // 24小时
  await env.DB
    .prepare("INSERT OR REPLACE INTO sessions (id, data, expires_at) VALUES (?, ?, ?)")
    .bind(token, JSON.stringify(session), expiresAt)
    .run();
  return token;
}

async function deleteSession(token, env) {
  await env.DB
    .prepare("DELETE FROM sessions WHERE id = ?")
    .bind(token)
    .run();
}

async function generateToken(email) {
  const data = new TextEncoder().encode(email + ':' + Date.now() + ':' + Math.random());
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return btoa(String.fromCharCode(...new Uint8Array(hashBuffer))).replace(/\//g, '_').replace(/\+/g, '-').slice(0, 64);
}

function parseCookies(header) {
  const result = {};
  if (!header) return result;
  for (const part of header.split(';')) {
    const [name, ...val] = part.trim().split('=');
    if (name) result[name.trim()] = decodeURIComponent(val.join('='));
  }
  return result;
}

// ============ 登录 ============
async function handleLogin(request, env) {
  const { email, password } = await request.json();
  
  if (!email || !password) {
    return { error: '请输入邮箱和密码' };
  }
  
  const user = await env.DB
    .prepare("SELECT * FROM users WHERE email = ?")
    .bind(email).first();
  
  if (!user) return { error: '用户不存在' };
  
  const hash = await hashPassword(password);
  if (hash !== user.password_hash) return { error: '密码错误' };
  
  const token = await createSession(user, env);
  
  return new Response(null, {
    status: 302,
    headers: {
      'Location': '/',
      'Set-Cookie': `ev3_tok=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`
    }
  });
}

async function hashPassword(password) {
  const salt = 'ev3_2024_elevator_safety_alt';
  const data = new TextEncoder().encode(salt + password);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ============ 仪表盘统计 ============
async function handleDashboardStats(env) {
  const today = new Date().toISOString().slice(0, 10);
  
  const [todayC, pendingC, activeC, total, compliant] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) as c FROM discrimination_records WHERE date(created_at) = ?").bind(today).first(),
    env.DB.prepare("SELECT COUNT(*) as c FROM audit_tasks WHERE status = 'pending'").first(),
    env.DB.prepare("SELECT COUNT(*) as c FROM templates WHERE status = 'published'").first(),
    env.DB.prepare("SELECT COUNT(*) as c FROM discrimination_records").first(),
    env.DB.prepare("SELECT COUNT(*) as c FROM discrimination_records WHERE final_result = '合规'").first(),
  ]);
  
  return {
    todayDiscriminations: todayC?.c || 0,
    pendingAudits: pendingC?.c || 0,
    activeTemplates: activeC?.c || 0,
    compliantRate: total?.c > 0 ? Math.round((compliant?.c / total.c) * 100) + '%' : '0%'
  };
}

// ============ AI 分类 ============
async function handleAiClassify(request, env) {
  const { content, moduleName } = await request.json();
  if (!content) return { error: '内容不能为空' };
  
  const rules = await env.DB
    .prepare("SELECT * FROM rule_engine_rules WHERE enabled = 1").all();
  
  let matched = null;
  let confidence = 0;
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
  
  const result = matched?.action_value || '待人工';
  return {
    result,
    confidence: Math.round(confidence * 100),
    matchedRule: matched?.rule_name || '通用分类',
    reason: matched ? `命中规则「${matched.rule_name}」` : '无匹配规则，建议人工审核',
    suggestions: matched?.suggestions ? JSON.parse(matched.suggestions) : [],
    method: 'rule'
  };
}

// ============ 提交判别 ============
async function handleDiscriminate(request, env, session) {
  const { content, moduleName, aiResult, aiConfidence, aiReason, matchedRule } = await request.json();
  
  const record = await env.DB
    .prepare(`INSERT INTO discrimination_records
      (module_name, record_content, ai_result, ai_confidence, ai_reason, matched_rule, final_result, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING *`)
    .bind(
      moduleName || '电梯设备检查', content,
      aiResult || '待人工', aiConfidence || 0,
      aiReason || '', matchedRule || '',
      aiResult || '待人工', session.id
    ).first();
  
  // 哈希链
  await appendHashChain(env, 'discrimination_records', record.id, `新增判别: ${aiResult || '待人工'}`);
  
  // 自动创建审核任务
  if (aiResult === '待人工' || aiResult === '不合规') {
    await env.DB
      .prepare(`INSERT INTO audit_tasks (record_id, status, priority) VALUES (?, 'pending', ?)`)
      .bind(record.id, aiResult === '不合规' ? 'high' : 'normal');
  }
  
  return { success: true, record };
}

// ============ 判别历史 ============
async function handleRecords(url, env) {
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
  
  return { records: rows.results || [], total: total?.c || 0, page, limit };
}

// ============ 单条记录 ============
async function handleRecord(id, env) {
  const record = await env.DB
    .prepare("SELECT * FROM discrimination_records WHERE id = ?").bind(id).first();
  return record || { error: '记录不存在' };
}

// ============ 模板 ============
async function handleTemplates(method, request, env, session) {
  if (method === 'GET') {
    const rows = await env.DB.prepare("SELECT * FROM templates ORDER BY id").all();
    return rows.results || [];
  }
  if (session.role !== 'admin') return { error: '权限不足' };
  const { name, description } = await request.json();
  const result = await env.DB
    .prepare("INSERT INTO templates (name, description, status) VALUES (?, ?, 'draft') RETURNING *")
    .bind(name, description).first();
  return { success: true, template: result };
}

// ============ 法规 ============
async function handleRegulations(method, request, env, session) {
  if (method === 'GET') {
    const rows = await env.DB.prepare("SELECT * FROM regulations ORDER BY code").all();
    return rows.results || [];
  }
  if (session.role !== 'admin') return { error: '权限不足' };
  const { code, name, description } = await request.json();
  const result = await env.DB
    .prepare("INSERT INTO regulations (code, name, description) VALUES (?, ?, ?) RETURNING *")
    .bind(code, name, description).first();
  return { success: true, regulation: result };
}

// ============ 审核任务 ============
async function handleAuditTasks(method, request, env, session) {
  if (!['auditor', 'admin'].includes(session.role)) return { error: '权限不足' };
  
  if (method === 'GET') {
    const rows = await env.DB.prepare("SELECT * FROM audit_tasks ORDER BY id DESC LIMIT 50").all();
    return rows.results || [];
  }
  
  const { id, action, comment } = await request.json();
  const newStatus = action === 'approve' ? 'approved' : 'rejected';
  await env.DB.prepare("UPDATE audit_tasks SET status = ?, auditor_comment = ? WHERE id = ?")
    .bind(newStatus, comment || '', id);
  
  return { success: true };
}

// ============ 日志 ============
async function handleLogs(url, env) {
  const page = parseInt(url.searchParams.get('page')) || 1;
  const rows = await env.DB.prepare("SELECT * FROM hash_chain ORDER BY block_index DESC LIMIT 20 OFFSET ?")
    .bind((page - 1) * 20).all();
  return rows.results || [];
}

// ============ 哈希链 ============
async function appendHashChain(env, table, recordId, description) {
  const prev = await env.DB
    .prepare("SELECT hash FROM hash_chain ORDER BY block_index DESC LIMIT 1").first();
  const prevHash = prev?.hash || '0'.repeat(64);
  const timestamp = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
  const data = `${table}:${recordId}:${description}:${timestamp}`;
  
  const hashBuffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(prevHash + data));
  const hash = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
  
  const blockIndex = await env.DB
    .prepare("SELECT COALESCE(MAX(block_index), 0) + 1 as idx FROM hash_chain").first();
  
  await env.DB
    .prepare(`INSERT INTO hash_chain (block_index, table_name, record_id, description, timestamp, prev_hash, hash, operator)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(blockIndex.idx, table, recordId, description, timestamp, prevHash, hash, 'system');
}
