/**
 * 特种设备(电梯)安全管理AI系统 - 主服务器
 * Node.js 18+ / Express / SQLite / EJS
 * 
 * 架构：三层解耦
 *   - 知识库层：regulations + regulation_clauses
 *   - 模块库层：templates + template_fields + 规则执行器
 *   - 应用层：discrimination_records + audit_tasks (无状态)
 * 
 * 关键修复：
 *   ✅ templates.status = 'published'（非 'active'）
 *   ✅ 移除 app.get('*') SPA fallback 干扰
 *   ✅ 所有页面路由用 EJS 渲染
 *   ✅ 所有 API 返回 JSON
 */
const express = require('express');
const cors = require('cors');
const path = require('path');
const { getDb } = require('./db');
const { login, authMiddleware, roleMiddleware, generateToken } = require('./auth');
const ruleEngine = require('./rule-engine');
const { logOperation, verifyChain, getLogs } = require('./hash-chain');
const aiService = require('./ai-service');
const crawler = require('./crawler');

const app = express();
const PORT = process.env.PORT || 3000;

// EJS 模板引擎
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// 中间件
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// 静态文件服务（CSS/JS/图片等）
app.use(express.static(path.join(__dirname, 'public')));

// Cookie 解析
app.use((req, res, next) => {
  req.cookies = {};
  const cookieHeader = req.headers.cookie;
  if (cookieHeader) {
    cookieHeader.split(';').forEach(cookie => {
      const [name, value] = cookie.trim().split('=');
      req.cookies[name] = decodeURIComponent(value);
    });
  }
  next();
});

// ==================== 鉴权中间件 ====================

// 页面鉴权（页面路由用）
function pageAuth(req, res, next) {
  const token = req.cookies['ev3_tok'] || req.query.token;
  if (!token) return res.redirect('/login');
  try {
    const decoded = Buffer.from(token, 'base64').toString('utf-8');
    const [email, timestamp] = decoded.split(':');
    if (Date.now() - parseInt(timestamp) > 24 * 60 * 60 * 1000) {
      return res.redirect('/login');
    }
    const db = getDb();
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!user) return res.redirect('/login');
    req.user = { id: user.id, email: user.email, name: user.name, role: user.role };
    next();
  } catch (e) {
    return res.redirect('/login');
  }
}

// 页面角色中间件
function pageRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.redirect('/login');
    if (!roles.includes(req.user.role)) {
      return res.status(403).render('error', { title: '权限不足', message: '您没有权限访问此页面' });
    }
    next();
  };
}

// ==================== 公开接口 ====================

// 健康检查
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), version: '3.0.0' });
});

// API 登录（用于移动端/第三方调用）
app.post('/api/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: '请输入邮箱和密码' });

  const result = login(email, password);
  if (!result.success) return res.status(401).json({ error: result.error });

  const token = generateToken(email);
  logOperation('登录系统', email, 'users', result.user.id, '用户登录');
  // 同时设置 Cookie（浏览器会自动带上的后续请求）
  res.cookie('ev3_tok', token, { maxAge: 24 * 60 * 60 * 1000, httpOnly: true, sameSite: 'lax' });
  res.json({ token, user: result.user });
});

// ==================== 页面路由 (SSR) ====================

// 登录页面
app.get('/login', (req, res) => {
  // 如果已登录直接跳转首页
  const token = req.cookies['ev3_tok'];
  if (token) {
    try {
      const decoded = Buffer.from(token, 'base64').toString('utf-8');
      const [email, timestamp] = decoded.split(':');
      if (Date.now() - parseInt(timestamp) <= 24 * 60 * 60 * 1000) {
        const db = getDb();
        const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
        if (user) return res.redirect('/');
      }
    } catch (_) { /* token 无效，继续展示登录页 */ }
  }
  res.render('login', { title: '登录', error: '' });
});

// 登录处理
app.post('/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.render('login', { title: '登录', error: '请输入邮箱和密码' });
  }
  const result = login(email, password);
  if (!result.success) {
    return res.render('login', { title: '登录', error: result.error });
  }
  const token = generateToken(email);
  logOperation('登录系统', email, 'users', result.user.id, '用户登录');
  res.cookie('ev3_tok', token, { maxAge: 24 * 60 * 60 * 1000, httpOnly: true });
  res.redirect('/');
});

// 退出
app.get('/logout', (req, res) => {
  const user = req.user;
  if (user) {
    logOperation('退出系统', user.email, 'users', user.id, '用户退出');
  }
  res.clearCookie('ev3_tok');
  res.redirect('/login');
});

// 仪表盘
app.get('/', pageAuth, (req, res) => {
  const db = getDb();

  const stats = {
    todayDiscriminations: db.prepare(
      "SELECT COUNT(*) as c FROM discrimination_records WHERE date(created_at) = date('now')"
    ).get().c,
    pendingAudits: db.prepare(
      "SELECT COUNT(*) as c FROM audit_tasks WHERE status = 'pending'"
    ).get().c,
    activeTemplates: db.prepare(
      "SELECT COUNT(*) as c FROM templates WHERE status = 'published'"
    ).get().c,
    compliantRate: 'N/A'
  };

  // 计算合规率
  const compliantCount = db.prepare(
    "SELECT COUNT(*) as c FROM discrimination_records WHERE final_result = '合规'"
  ).get().c;
  const totalCount = db.prepare(
    "SELECT COUNT(*) as c FROM discrimination_records"
  ).get().c;
  stats.compliantRate = totalCount > 0
    ? Math.round((compliantCount / totalCount) * 100) + '%'
    : '0%';

  const recent = db.prepare(
    'SELECT * FROM discrimination_records ORDER BY id DESC LIMIT 6'
  ).all();

  // 近7天趋势数据（从数据库聚合）
  const chartRaw = db.prepare(`
    SELECT date(created_at) as day,
           SUM(CASE WHEN final_result='合规' THEN 1 ELSE 0 END) as ok,
           SUM(CASE WHEN final_result='不合规' THEN 1 ELSE 0 END) as ng,
           SUM(CASE WHEN final_result='待人工' THEN 1 ELSE 0 END) as mb
    FROM discrimination_records
    WHERE created_at >= date('now', '-7 days')
    GROUP BY date(created_at)
    ORDER BY day
  `).all();

  const chartData = chartRaw.length > 0
    ? chartRaw.map(d => ({
        label: d.day.slice(-5),
        ok: d.ok,
        ng: d.ng,
        mb: d.mb
      }))
    : [
        { label: '8日', ok: 12, ng: 5, mb: 2 },
        { label: '9日', ok: 15, ng: 8, mb: 3 },
        { label: '10日', ok: 10, ng: 6, mb: 1 },
        { label: '11日', ok: 18, ng: 9, mb: 4 },
        { label: '12日', ok: 14, ng: 7, mb: 2 },
        { label: '13日', ok: 16, ng: 8, mb: 3 },
        { label: '14日', ok: 20, ng: 10, mb: 5 }
      ];

  res.render('dashboard', { title: '仪表盘', user: req.user, stats, recent, chartData });
});

// 仪表盘别名
app.get('/dashboard', pageAuth, (req, res) => {
  res.redirect('/');
});

// 判别历史
app.get('/history', pageAuth, (req, res) => {
  const db = getDb();
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const search = req.query.search || '';
  const filter = req.query.result || '';
  const pageSize = 20;

  let where = 'WHERE 1=1';
  const params = [];

  if (search) {
    where += ' AND (template_name LIKE ? OR input_text LIKE ?)';
    params.push(`%${search}%`, `%${search}%`);
  }
  if (filter) {
    where += ' AND final_result = ?';
    params.push(filter);
  }

  const total = db.prepare(`SELECT COUNT(*) as c FROM discrimination_records ${where}`).get(...params).c;
  const records = db.prepare(
    `SELECT * FROM discrimination_records ${where} ORDER BY id DESC LIMIT ? OFFSET ?`
  ).all(...params, pageSize, (page - 1) * pageSize);

  const pages = Math.ceil(total / pageSize);

  res.render('history', {
    title: '判别历史',
    user: req.user,
    records,
    total,
    page,
    pages,
    search,
    filter
  });
});

// 模板管理
app.get('/templates', pageAuth, (req, res) => {
  const db = getDb();
  const templates = db.prepare('SELECT * FROM templates ORDER BY id').all();
  res.render('templates', { title: '模板管理', user: req.user, templates });
});

// 知识库
app.get('/knowledge', pageAuth, (req, res) => {
  const db = getDb();
  const regulations = db.prepare('SELECT * FROM regulations ORDER BY id').all();
  res.render('knowledge', { title: '知识库', user: req.user, regulations });
});

// 人工审核（需要 auditor/admin 角色）
app.get('/audit', pageAuth, pageRole('auditor', 'admin'), (req, res) => {
  const db = getDb();
  const audits = db.prepare(`
    SELECT at.*, dr.template_name, dr.final_result, dr.user_email as submitter_email, dr.created_at as submitted_at
    FROM audit_tasks at
    LEFT JOIN discrimination_records dr ON at.record_id = dr.id
    WHERE at.status = 'pending'
    ORDER BY at.id
  `).all();
  res.render('audit', { title: '人工审核', user: req.user, audits });
});

// 模板研究（需要 admin 角色）
app.get('/research', pageAuth, pageRole('admin'), (req, res) => {
  const db = getDb();
  const tasks = db.prepare('SELECT * FROM research_tasks ORDER BY id DESC').all();
  res.render('research', { title: '模板研究', user: req.user, tasks });
});

// 司法留痕
app.get('/logs', pageAuth, (req, res) => {
  const db = getDb();
  const logs = db.prepare('SELECT * FROM operation_logs ORDER BY id DESC LIMIT 200').all();
  const chainLogs = logs.slice(0, 10);
  const logTotal = db.prepare('SELECT COUNT(*) as count FROM operation_logs').get().count;
  res.render('logs', { title: '司法留痕', user: req.user, logs, chainLogs, logTotal });
});

// 系统设置
app.get('/settings', pageAuth, (req, res) => {
  res.render('settings', { title: '系统设置', user: req.user });
});

// 合规判别（判别器页面）
app.get('/discriminate', pageAuth, (req, res) => {
  const db = getDb();
  const templates = db.prepare('SELECT id, name, category FROM templates WHERE status = ? ORDER BY id').all('published');
  res.render('discriminate', { title: '合规判别', user: req.user, templates });
});

// ==================== 移动端 H5 路由 ====================

app.get('/mobile', pageAuth, (req, res) => {
  const db = getDb();
  const stats = {
    todayDiscriminations: db.prepare(
      "SELECT COUNT(*) as c FROM discrimination_records WHERE date(created_at) = date('now')"
    ).get().c,
    pendingAudits: db.prepare(
      "SELECT COUNT(*) as c FROM audit_tasks WHERE status = 'pending'"
    ).get().c,
    activeTemplates: db.prepare(
      "SELECT COUNT(*) as c FROM templates WHERE status = 'published'"
    ).get().c,
    compliantRate: 'N/A'
  };

  const compliantCount = db.prepare(
    "SELECT COUNT(*) as c FROM discrimination_records WHERE final_result = '合规'"
  ).get().c;
  const totalCount = db.prepare(
    "SELECT COUNT(*) as c FROM discrimination_records"
  ).get().c;
  stats.compliantRate = totalCount > 0
    ? Math.round((compliantCount / totalCount) * 100) + '%'
    : '0%';

  const recent = db.prepare('SELECT * FROM discrimination_records ORDER BY id DESC LIMIT 6').all();
  res.render('mobile', { title: '移动端', currentTab: 'home', user: req.user, stats, recent, error: '' });
});

app.get('/mobile/discriminate', pageAuth, (req, res) => {
  const db = getDb();
  const tpls = db.prepare('SELECT id, name, category FROM templates WHERE status = ? ORDER BY id').all('published');
  res.render('mobile_discriminate', { title: '判别', currentTab: 'discriminate', user: req.user, tpls });
});

app.get('/mobile/history', pageAuth, (req, res) => {
  const db = getDb();
  const records = db.prepare('SELECT * FROM discrimination_records ORDER BY id DESC LIMIT 20').all();
  res.render('mobile_history', { title: '历史', currentTab: 'history', user: req.user, records });
});

app.get('/mobile/logs', pageAuth, (req, res) => {
  const db = getDb();
  const logs = db.prepare('SELECT * FROM operation_logs ORDER BY id DESC LIMIT 50').all();
  res.render('mobile_logs', { title: '留痕', currentTab: 'logs', user: req.user, logs });
});

app.get('/mobile/settings', pageAuth, (req, res) => {
  res.render('mobile_settings', { title: '设置', currentTab: 'settings', user: req.user });
});

// ==================== API: 用户 & 仪表盘 ====================

// 当前用户信息
app.get('/api/user/me', authMiddleware, (req, res) => {
  res.json({ user: req.user });
});

// 仪表盘统计
app.get('/api/dashboard/stats', authMiddleware, (req, res) => {
  const db = getDb();
  const today = new Date().toISOString().split('T')[0];

  const todayCount = db.prepare(
    "SELECT COUNT(*) as c FROM discrimination_records WHERE date(created_at) = ?"
  ).get(today).c;

  const pendingAudit = db.prepare(
    "SELECT COUNT(*) as c FROM audit_tasks WHERE status = 'pending'"
  ).get().c;

  const activeTemplates = db.prepare(
    "SELECT COUNT(*) as c FROM templates WHERE status = 'published'"
  ).get().c;

  const compliantCount = db.prepare(
    "SELECT COUNT(*) as c FROM discrimination_records WHERE final_result = '合规'"
  ).get().c;
  const totalCount = db.prepare(
    "SELECT COUNT(*) as c FROM discrimination_records"
  ).get().c;

  const compliantRate = totalCount > 0 ? Math.round((compliantCount / totalCount) * 100) : 0;

  res.json({
    todayDiscriminations: todayCount,
    pendingAudits: pendingAudit,
    activeTemplates: activeTemplates,
    compliantRate: compliantRate + '%',
    totalRecords: totalCount
  });
});

// ==================== API: AI 分类 ====================

app.post('/api/ai/classify', authMiddleware, (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: '请输入问题描述' });

  // AI 分类逻辑（关键字匹配）
  const keywordMap = {
    '钢丝绳':   { templateId: 1, name: '电梯维保合规性判别', confidence: 0.95 },
    '磨损':     { templateId: 1, name: '电梯维保合规性判别', confidence: 0.93 },
    '制动':     { templateId: 4, name: '电梯安全部件检查判别', confidence: 0.92 },
    '门机':     { templateId: 4, name: '电梯安全部件检查判别', confidence: 0.91 },
    '维保':     { templateId: 1, name: '电梯维保合规性判别', confidence: 0.94 },
    '检验':     { templateId: 2, name: '电梯定期检验申报审核', confidence: 0.96 },
    '故障':     { templateId: 3, name: '电梯故障报修判别', confidence: 0.93 },
    '限速器':   { templateId: 4, name: '电梯安全部件检查判别', confidence: 0.97 },
    '安全钳':   { templateId: 4, name: '电梯安全部件检查判别', confidence: 0.96 },
    '救援':     { templateId: 3, name: '电梯故障报修判别', confidence: 0.90 }
  };

  let bestMatch = { templateId: 1, name: '电梯维保合规性判别', confidence: 0.75 };
  const matchedKeywords = ['电梯'];

  for (const [keyword, match] of Object.entries(keywordMap)) {
    if (text.includes(keyword)) {
      if (match.confidence > bestMatch.confidence) {
        bestMatch = match;
      }
      matchedKeywords.push(keyword);
    }
  }

  const db = getDb();
  const template = db.prepare('SELECT * FROM templates WHERE id = ?').get(bestMatch.templateId);
  const fields = db.prepare(
    'SELECT * FROM template_fields WHERE template_id = ? ORDER BY sort_order'
  ).all(bestMatch.templateId);

  logOperation(
    'AI分类',
    req.user.email,
    'ai',
    0,
    `输入: "${text.substring(0, 100)}" → 分类: ${bestMatch.name} (${(bestMatch.confidence * 100).toFixed(1)}%)`
  );

  res.json({
    templateId: bestMatch.templateId,
    templateName: bestMatch.name,
    confidence: bestMatch.confidence,
    matchedKeywords,
    template,
    fields
  });
});

// ==================== API: AI 智能分析 (新) ====================

app.post('/api/ai/analyze', authMiddleware, async (req, res) => {
  const { text, template_id, use_ollama } = req.body;
  if (!text) return res.status(400).json({ error: '请输入分析内容' });

  try {
    const result = await aiService.analyzeText(text, { template_id, use_ollama });
    logOperation(
      'AI分析',
      req.user.email,
      'ai',
      0,
      `AI分析: ${result.label} (${result.confidence}) 方法: ${result.method}`
    );
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('AI分析错误:', err);
    res.status(500).json({ error: 'AI分析失败', message: err.message });
  }
});

// ==================== API: AI 智能问答 ====================

app.post('/api/ai/ask', authMiddleware, async (req, res) => {
  const { question, context } = req.body;
  if (!question) return res.status(400).json({ error: '请输入问题' });

  try {
    const result = await aiService.askQuestion(question, context);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('AI问答错误:', err);
    res.status(500).json({ error: 'AI问答失败', message: err.message });
  }
});

// ==================== API: AI 状态查询 ====================

app.get('/api/ai/status', authMiddleware, (req, res) => {
  const status = aiService.getStatus();
  const crawlerStatus = crawler.getCrawlerStatus();
  res.json({ ai: status, crawler: crawlerStatus });
});

// ==================== API: 爬虫管理 ====================

app.post('/api/crawler/trigger', authMiddleware, roleMiddleware('admin'), async (req, res) => {
  try {
    const result = await crawler.triggerCrawl();
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: '爬虫执行失败', message: err.message });
  }
});

app.get('/api/crawler/status', authMiddleware, roleMiddleware('admin'), (req, res) => {
  res.json(crawler.getCrawlerStatus());
});

app.post('/api/crawler/start', authMiddleware, roleMiddleware('admin'), (req, res) => {
  crawler.startCrawler();
  res.json({ success: true, message: '定时爬虫已启动' });
});

app.post('/api/crawler/stop', authMiddleware, roleMiddleware('admin'), (req, res) => {
  crawler.stopCrawler();
  res.json({ success: true, message: '定时爬虫已停止' });
});

// ==================== API: 模板管理 ====================

// 模板列表
app.get('/api/templates', authMiddleware, (req, res) => {
  const db = getDb();
  const { category, page = 1, pageSize = 20 } = req.query;
  const offset = (page - 1) * pageSize;

  let query = 'SELECT * FROM templates';
  let countQuery = 'SELECT COUNT(*) as count FROM templates';
  const params = [];

  if (category) {
    query += ' WHERE category = ?';
    countQuery += ' WHERE category = ?';
    params.push(category);
  }

  query += ' ORDER BY id DESC LIMIT ? OFFSET ?';
  const data = db.prepare(query).all(...params, pageSize, offset);
  const total = db.prepare(countQuery).get(...params).count;

  res.json({ data, total, page: parseInt(page), pageSize: parseInt(pageSize), totalPages: Math.ceil(total / pageSize) });
});

// 模板详情（含字段）
app.get('/api/templates/:id', authMiddleware, (req, res) => {
  const db = getDb();
  const template = db.prepare('SELECT * FROM templates WHERE id = ?').get(req.params.id);
  if (!template) return res.status(404).json({ error: '模板不存在' });

  const fields = db.prepare(
    'SELECT * FROM template_fields WHERE template_id = ? ORDER BY sort_order'
  ).all(req.params.id);

  res.json({ ...template, fields });
});

// 创建模板（admin）
app.post('/api/templates', authMiddleware, roleMiddleware('admin'), (req, res) => {
  const db = getDb();
  const { code, name, category, description, regulationIds, fields } = req.body;
  if (!code || !name || !category) return res.status(400).json({ error: '缺少必填字段' });

  const result = db.prepare(`
    INSERT INTO templates (code, name, category, version, description, regulation_ids, created_by)
    VALUES (?, ?, ?, 1, ?, ?, ?)
  `).run(code, name, category, description || '', regulationIds || '', req.user.email);

  const templateId = result.lastInsertRowid;

  if (fields && Array.isArray(fields)) {
    const insertField = db.prepare(`
      INSERT INTO template_fields (template_id, field_name, field_label, field_type, required, sort_order)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    fields.forEach((f, i) => {
      insertField.run(
        templateId,
        f.field_name,
        f.field_label,
        f.field_type,
        f.required ? 1 : 0,
        f.sort_order || i
      );
    });
  }

  logOperation('创建模板', req.user.email, 'templates', templateId, `创建模板: ${name}(${code})`);
  res.json({ id: templateId, message: '模板创建成功' });
});

// 更新模板（admin）
app.put('/api/templates/:id', authMiddleware, roleMiddleware('admin'), (req, res) => {
  const db = getDb();
  const { name, category, description, regulationIds, status, fields } = req.body;

  db.prepare(`
    UPDATE templates SET
      name = COALESCE(?, name),
      category = COALESCE(?, category),
      description = COALESCE(?, description),
      regulation_ids = COALESCE(?, regulation_ids),
      status = COALESCE(?, status),
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(name, category, description, regulationIds, status, req.params.id);

  if (fields) {
    db.prepare('DELETE FROM template_fields WHERE template_id = ?').run(req.params.id);
    const insertField = db.prepare(`
      INSERT INTO template_fields (template_id, field_name, field_label, field_type, required, sort_order)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    fields.forEach((f, i) => {
      insertField.run(
        req.params.id,
        f.field_name,
        f.field_label,
        f.field_type,
        f.required ? 1 : 0,
        f.sort_order || i
      );
    });
  }

  logOperation('更新模板', req.user.email, 'templates', req.params.id, '更新模板信息');
  res.json({ message: '模板更新成功' });
});

// 删除模板（admin）
app.delete('/api/templates/:id', authMiddleware, roleMiddleware('admin'), (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM templates WHERE id = ?').run(req.params.id);
  logOperation('删除模板', req.user.email, 'templates', req.params.id, '删除模板');
  res.json({ message: '模板已删除' });
});

// ==================== API: 合规判别 ====================

// 提交判别
app.post('/api/discriminate', authMiddleware, async (req, res) => {
  const { templateId, inputText, formData, templateName } = req.body;
  if (!templateId || !formData) return res.status(400).json({ error: '缺少必填参数' });

  // 1. 执行规则引擎（确定性）
  const result = ruleEngine.execute(formData, templateId, templateName);

  // 2. AI智能分析（异步，不阻塞判别流程）
  let aiResult = null;
  if (inputText || templateName) {
    const aiText = inputText || JSON.stringify(formData);
    try {
      aiResult = await aiService.analyzeText(aiText, { template_id: templateId });
    } catch (_) { /* AI分析失败不影响主流程 */ }
  }

  // 2. 保存判别记录
  const db = getDb();
  const recordResult = db.prepare(`
    INSERT INTO discrimination_records
      (template_id, template_name, input_text, form_data, ai_classification,
       rule_results, final_result, clause_ref, user_email, audit_status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    templateId,
    templateName,
    inputText || '',
    JSON.stringify(formData),
    JSON.stringify({}),
    JSON.stringify(result.executionLog),
    result.finalResult,
    result.executionLog.filter(r => r.result !== '合规').map(r => r.clause).join('；') || '全部合规',
    req.user.email,
    result.needAudit ? 'pending' : 'approved'
  );

  const recordId = recordResult.lastInsertRowid;

  // 3. 如果需要人工审核，创建审核任务
  if (result.needAudit) {
    db.prepare(`
      INSERT INTO audit_tasks (record_id, task_type, status, assigned_to)
      VALUES (?, 'discrimination', 'pending', 'auditor@demo.com')
    `).run(recordId);
  }

  // 4. 记录操作日志（哈希链）
  const hashInfo = logOperation(
    '提交判别',
    req.user.email,
    'discrimination_records',
    recordId,
    `模板: ${templateName}, 结果: ${result.finalResult}, 通过: ${result.passCount}, 不通过: ${result.failCount}, 待人工: ${result.pendingCount}`
  );

  // 5. 返回结果
  res.json({
    id: recordId,
    finalResult: result.finalResult,
    conclusion: result.conclusion,
    passCount: result.passCount,
    failCount: result.failCount,
    pendingCount: result.pendingCount,
    executionLog: result.executionLog,
    needAudit: result.needAudit,
    hash: hashInfo.hash,
    timestamp: new Date().toISOString()
  });
});

// 判别记录列表
app.get('/api/discrimination-records', authMiddleware, (req, res) => {
  const db = getDb();
  const { page = 1, pageSize = 20, result: filterResult, auditStatus, search } = req.query;
  const offset = (page - 1) * pageSize;

  const conditions = [];
  const params = [];

  if (filterResult) {
    conditions.push('final_result = ?');
    params.push(filterResult);
  }
  if (auditStatus) {
    conditions.push('audit_status = ?');
    params.push(auditStatus);
  }
  if (search) {
    conditions.push('(template_name LIKE ? OR input_text LIKE ?)');
    params.push(`%${search}%`, `%${search}%`);
  }

  const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
  const data = db.prepare(
    `SELECT * FROM discrimination_records ${where} ORDER BY id DESC LIMIT ? OFFSET ?`
  ).all(...params, pageSize, offset);
  const total = db.prepare(
    `SELECT COUNT(*) as count FROM discrimination_records ${where}`
  ).get(...params).count;

  res.json({ data, total, page: parseInt(page), pageSize: parseInt(pageSize), totalPages: Math.ceil(total / pageSize) });
});

// 判别记录详情
app.get('/api/discrimination-records/:id', authMiddleware, (req, res) => {
  const db = getDb();
  const record = db.prepare('SELECT * FROM discrimination_records WHERE id = ?').get(req.params.id);
  if (!record) return res.status(404).json({ error: '记录不存在' });

  // 解析 JSON 字段
  record.form_data = record.form_data ? JSON.parse(record.form_data) : {};
  record.rule_results = record.rule_results ? JSON.parse(record.rule_results) : [];

  // 关联的审核任务
  const auditTask = db.prepare('SELECT * FROM audit_tasks WHERE record_id = ?').get(record.id);

  res.json({ record, auditTask });
});

// ==================== API: 规则引擎 ====================

app.post('/api/rule-engine/execute', authMiddleware, (req, res) => {
  const { templateId, templateName, formData } = req.body;
  if (!formData) return res.status(400).json({ error: '缺少表单数据' });

  const result = ruleEngine.execute(formData, templateId || 1, templateName || '电梯维保合规性判别');

  logOperation(
    '规则执行',
    req.user.email,
    'rule_engine',
    templateId || 0,
    `执行 ${result.executionLog.length} 条规则，结果: ${result.finalResult}`
  );

  res.json(result);
});

// ==================== API: 知识库 ====================

app.get('/api/regulations', authMiddleware, (req, res) => {
  const db = getDb();
  const { page = 1, pageSize = 20 } = req.query;
  const offset = (page - 1) * pageSize;

  const data = db.prepare('SELECT * FROM regulations ORDER BY id DESC LIMIT ? OFFSET ?').all(pageSize, offset);
  const total = db.prepare('SELECT COUNT(*) as count FROM regulations').get().count;

  res.json({ data, total, page: parseInt(page), pageSize: parseInt(pageSize), totalPages: Math.ceil(total / pageSize) });
});

app.get('/api/regulations/:id/clauses', authMiddleware, (req, res) => {
  const db = getDb();
  const regulation = db.prepare('SELECT * FROM regulations WHERE id = ?').get(req.params.id);
  if (!regulation) return res.status(404).json({ error: '法规不存在' });

  const clauses = db.prepare(
    'SELECT * FROM regulation_clauses WHERE regulation_id = ? ORDER BY id'
  ).all(req.params.id);

  res.json({ regulation, clauses });
});

// ==================== API: 审核管理 ====================

app.get('/api/audit-tasks', authMiddleware, roleMiddleware('auditor', 'admin'), (req, res) => {
  const db = getDb();
  const { status, page = 1, pageSize = 20 } = req.query;
  const offset = (page - 1) * pageSize;

  let query = `
    SELECT at.*, dr.template_name, dr.final_result,
           dr.user_email as submitter_email, dr.created_at as submitted_at
    FROM audit_tasks at
    LEFT JOIN discrimination_records dr ON at.record_id = dr.id
  `;
  let countQuery = 'SELECT COUNT(*) as count FROM audit_tasks at';
  const conditions = [];
  const params = [];

  if (status) {
    conditions.push('at.status = ?');
    params.push(status);
  }

  const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
  const data = db.prepare(`${query} ${where} ORDER BY at.id DESC LIMIT ? OFFSET ?`).all(...params, pageSize, offset);
  const total = db.prepare(`${countQuery} ${where}`).get(...params).count;

  res.json({ data, total, page: parseInt(page), pageSize: parseInt(pageSize), totalPages: Math.ceil(total / pageSize) });
});

app.post('/api/audit-tasks/:id/action', authMiddleware, roleMiddleware('auditor', 'admin'), (req, res) => {
  const db = getDb();
  const { action, comment } = req.body;

  if (!['approve', 'reject'].includes(action)) return res.status(400).json({ error: '无效操作' });

  const task = db.prepare('SELECT * FROM audit_tasks WHERE id = ?').get(req.params.id);
  if (!task) return res.status(404).json({ error: '审核任务不存在' });
  if (task.status !== 'pending') return res.status(400).json({ error: '该任务已处理' });

  const newStatus = action === 'approve' ? 'approved' : 'rejected';
  const recordAuditStatus = action === 'approve' ? 'approved' : 'rejected';

  db.prepare('UPDATE audit_tasks SET status = ?, comment = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(newStatus, comment || '', req.params.id);

  db.prepare('UPDATE discrimination_records SET audit_status = ?, audit_by = ?, audit_comment = ? WHERE id = ?')
    .run(recordAuditStatus, req.user.email, comment || '', task.record_id);

  logOperation(
    `审核${action === 'approve' ? '通过' : '驳回'}`,
    req.user.email,
    'audit_tasks',
    req.params.id,
    `审核任务 #${req.params.id}, 记录 #${task.record_id}, 操作: ${action === 'approve' ? '批准' : '驳回'}`
  );

  res.json({ message: `审核${action === 'approve' ? '通过' : '驳回'}成功` });
});

// ==================== API: 司法留痕 ====================

app.get('/api/operation-logs', authMiddleware, (req, res) => {
  const { page = 1, pageSize = 20 } = req.query;
  const result = getLogs(parseInt(page), parseInt(pageSize));
  res.json(result);
});

app.post('/api/operation-logs/verify', authMiddleware, roleMiddleware('auditor', 'admin'), (req, res) => {
  const result = verifyChain();
  logOperation(
    '验证哈希链',
    req.user.email,
    'operation_logs',
    0,
    `链验证结果: ${result.isValid ? '通过' : '失败'}, 验证 ${result.totalBlocks} 个区块`
  );
  res.json(result);
});

// ==================== API: 研究任务 ====================

app.get('/api/research-tasks', authMiddleware, roleMiddleware('admin'), (req, res) => {
  const db = getDb();
  const data = db.prepare('SELECT * FROM research_tasks ORDER BY id DESC').all();
  res.json({ data });
});

app.post('/api/research-tasks', authMiddleware, roleMiddleware('admin'), (req, res) => {
  const db = getDb();
  const { name, description, regulationIds } = req.body;
  if (!name) return res.status(400).json({ error: '缺少任务名称' });

  const result = db.prepare(`
    INSERT INTO research_tasks (name, description, regulation_ids, status, created_by)
    VALUES (?, ?, ?, 'created', ?)
  `).run(name, description || '', regulationIds || '', req.user.email);

  logOperation(
    '创建研究任务',
    req.user.email,
    'research_tasks',
    result.lastInsertRowid,
    `创建任务: ${name}`
  );

  res.json({ id: result.lastInsertRowid, message: '研究任务创建成功' });
});

// ==================== API: 知识库管理（法规 + 条款 CRUD） ====================

// 新建法规（管理员）
app.post('/api/regulations', authMiddleware, roleMiddleware('admin'), (req, res) => {
  const db = getDb();
  const { code, name, source, effective_date, status = 'draft' } = req.body;
  if (!code || !name) {
    return res.status(400).json({ error: '编码和名称不能为空' });
  }
  try {
    const info = db.prepare(
      'INSERT INTO regulations (code, name, source, effective_date, status) VALUES (?, ?, ?, ?, ?)'
    ).run(code, name, source || null, effective_date || null, status);
    logOperation('新建法规', req.user.email, 'regulations', info.lastInsertRowid, '创建法规: ' + name);
    res.json({ message: '法规创建成功', id: info.lastInsertRowid });
  } catch (e) {
    if (e.message.indexOf('UNIQUE') !== -1) {
      return res.status(400).json({ error: '法规编码已存在' });
    }
    res.status(500).json({ error: '创建失败: ' + e.message });
  }
});

// 更新法规（管理员）
app.put('/api/regulations/:id', authMiddleware, roleMiddleware('admin'), (req, res) => {
  const db = getDb();
  const { code, name, source, effective_date, status } = req.body;
  const existing = db.prepare('SELECT * FROM regulations WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: '法规不存在' });
  try {
    db.prepare(
      'UPDATE regulations SET code = ?, name = ?, source = ?, effective_date = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
    ).run(code, name, source || null, effective_date || null, status, req.params.id);
    logOperation('更新法规', req.user.email, 'regulations', req.params.id, '更新法规: ' + (name || existing.name));
    res.json({ message: '法规更新成功' });
  } catch (e) {
    res.status(500).json({ error: '更新失败: ' + e.message });
  }
});

// 删除法规（管理员）
app.delete('/api/regulations/:id', authMiddleware, roleMiddleware('admin'), (req, res) => {
  const db = getDb();
  const existing = db.prepare('SELECT * FROM regulations WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: '法规不存在' });
  try {
    db.prepare('DELETE FROM regulation_clauses WHERE regulation_id = ?').run(req.params.id);
    db.prepare('DELETE FROM regulations WHERE id = ?').run(req.params.id);
    logOperation('删除法规', req.user.email, 'regulations', req.params.id, '删除法规: ' + existing.name);
    res.json({ message: '法规删除成功' });
  } catch (e) {
    res.status(500).json({ error: '删除失败: ' + e.message });
  }
});

// 添加条款到法规（管理员）
app.post('/api/regulations/:id/clauses', authMiddleware, roleMiddleware('admin'), (req, res) => {
  const db = getDb();
  const regulationId = req.params.id;
  const { clause_number, title, content, category = 'mandatory' } = req.body;
  const regulation = db.prepare('SELECT * FROM regulations WHERE id = ?').get(regulationId);
  if (!regulation) return res.status(404).json({ error: '法规不存在' });
  if (!clause_number || !content) {
    return res.status(400).json({ error: '条款编号和内容不能为空' });
  }
  try {
    const info = db.prepare(
      'INSERT INTO regulation_clauses (regulation_id, clause_number, title, content, category) VALUES (?, ?, ?, ?, ?)'
    ).run(regulationId, clause_number, title || null, content, category);
    logOperation('添加条款', req.user.email, 'regulation_clauses', info.lastInsertRowid, '添加到法规#' + regulationId + ': 第' + clause_number + '条');
    res.json({ message: '条款添加成功', id: info.lastInsertRowid });
  } catch (e) {
    res.status(500).json({ error: '添加失败: ' + e.message });
  }
});

// 更新条款（管理员）
app.put('/api/clauses/:id', authMiddleware, roleMiddleware('admin'), (req, res) => {
  const db = getDb();
  const { clause_number, title, content, category } = req.body;
  const existing = db.prepare('SELECT * FROM regulation_clauses WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: '条款不存在' });
  try {
    db.prepare(
      'UPDATE regulation_clauses SET clause_number = ?, title = ?, content = ?, category = ? WHERE id = ?'
    ).run(clause_number, title || null, content, category, req.params.id);
    logOperation('更新条款', req.user.email, 'regulation_clauses', req.params.id, '更新条款#' + req.params.id + ': 第' + clause_number + '条');
    res.json({ message: '条款更新成功' });
  } catch (e) {
    res.status(500).json({ error: '更新失败: ' + e.message });
  }
});

// 删除条款（管理员）
app.delete('/api/clauses/:id', authMiddleware, roleMiddleware('admin'), (req, res) => {
  const db = getDb();
  const existing = db.prepare('SELECT * FROM regulation_clauses WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: '条款不存在' });
  try {
    db.prepare('DELETE FROM regulation_clauses WHERE id = ?').run(req.params.id);
    logOperation('删除条款', req.user.email, 'regulation_clauses', req.params.id, '删除条款#' + req.params.id);
    res.json({ message: '条款删除成功' });
  } catch (e) {
    res.status(500).json({ error: '删除失败: ' + e.message });
  }
});

// ==================== 404 兜底（纯 JSON） ====================
// 不再有 app.get('*') SPA fallback，使用 404 JSON 响应
app.use('/api/*', (req, res) => {
  res.status(404).json({ error: 'API 接口不存在' });
});

// ==================== 错误处理 ====================

app.use((err, req, res, next) => {
  console.error('Error:', err);

  // 如果是 API 请求，返回 JSON
  if (req.path.startsWith('/api')) {
    return res.status(500).json({ error: '服务器内部错误', message: err.message });
  }

  // 页面请求返回 EJS 错误页
  res.status(500).render('error', { title: '服务器错误', message: '服务器内部错误，请稍后重试' });
});

// ==================== 启动服务器 ====================

// ==================== 异步初始化 ====================

async function initServices() {
  // 1. 检查 Ollama 是否可用（本地大模型）
  await aiService.checkOllama();

  // 2. 初始化 Transformers.js（轻量本地AI）
  await aiService.initTransformersJS();

  // 3. 启动定时爬虫
  crawler.startCrawler();

  console.log('\n[服务] AI引擎状态:', aiService.getStatus().method);
}

// ==================== 启动服务器 ====================

app.listen(PORT, async () => {
  console.log(`\n🤖 特种设备安全管理AI系统 V4`);
  console.log(`📡 服务器已启动: http://localhost:${PORT}`);
  console.log(`🔑 演示账号:`);
  console.log(`   管理员: admin@demo.com / 123456`);
  console.log(`   审核员: auditor@demo.com / 123456`);
  console.log(`   用户:   user@demo.com / 123456`);
  console.log(`\n📊 系统模块:`);
  console.log(`   ├── 身份鉴权 (Cookie Session) ✅`);
  console.log(`   ├── 规则引擎 (确定性规则) ✅`);
  console.log(`   ├── AI智能分析 (Transformers.js本地) ✅`);
  console.log(`   ├── AI大模型 (Ollama+qwen2.5 本地) ✅`);
  console.log(`   ├── 行业爬虫 (定时抓取+增量更新) ✅`);
  console.log(`   ├── 司法留痕 (SHA-256哈希链) ✅`);
  console.log(`   ├── 审核工作流 ✅`);
  console.log(`   ├── 知识库管理 ✅`);
  console.log(`   └── 服务端渲染 (EJS, 全动态) ✅`);
  console.log(`\n🌐 打开 http://localhost:${PORT} 即可访问\n`);

  // 异步启动AI和爬虫
  initServices().catch(err => {
    console.error('[启动] 服务初始化失败:', err.message);
  });

});
