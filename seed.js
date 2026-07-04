/**
 * 数据初始化脚本
 * 预置：用户账号、法规数据、模板、判别记录（含完整JSON form_data/rule_results）、审核任务等
 *
 * 关键修复：
 *   ✅ 添加用户时创建对应的 hash 链日志
 *   ✅ 模板 status 用 'published'（非 'active'）
 *   ✅ 判别记录含真实的 form_data 和 rule_results JSON
 *   ✅ 审核任务关联真实 '待人工' 记录
 */
const { getDb } = require('./db');
const { hashPassword } = require('./auth');
const { logOperation } = require('./hash-chain');
const ruleEngine = require('./rule-engine');

console.log('🔧 开始初始化数据库...');

const db = getDb();

// === 清空旧数据 ===
const tables = [
  'operation_logs', 'audit_tasks', 'discrimination_records',
  'template_fields', 'templates', 'regulation_clauses',
  'regulations', 'users'
];
for (const t of tables) {
  db.prepare(`DELETE FROM ${t}`).run();
  db.prepare(`DELETE FROM sqlite_sequence WHERE name='${t}'`).run();
}
console.log('  ✅ 已清空旧数据');

// ==================== 1. 创建用户 ====================
const insertUser = db.prepare(
  'INSERT INTO users (email, password_hash, name, role) VALUES (?, ?, ?, ?)'
);
insertUser.run('admin@demo.com', hashPassword('123456'), '系统管理员', 'admin');
insertUser.run('auditor@demo.com', hashPassword('123456'), '审核员张三', 'auditor');
insertUser.run('user@demo.com', hashPassword('123456'), '普通用户李四', 'user');
console.log('  ✅ 预置3个账号（密码均为123456）：admin@demo.com / auditor@demo.com / user@demo.com');

// 创建用户对应的 hash 链日志
logOperation('系统初始化', 'system', 'system', 0, '数据库结构创建完成，共计8张表');
logOperation('用户创建', 'system', 'users', 1, '创建管理员账号 admin@demo.com');
logOperation('用户创建', 'system', 'users', 2, '创建审核员账号 auditor@demo.com');
logOperation('用户创建', 'system', 'users', 3, '创建用户账号 user@demo.com');
console.log('  ✅ 用户相关操作日志已记录至哈希链');

// ==================== 2. 创建法规数据（3部核心电梯法规） ====================
const insertRegulation = db.prepare(
  'INSERT INTO regulations (code, name, source, effective_date) VALUES (?, ?, ?, ?)'
);
const insertClause = db.prepare(
  'INSERT INTO regulation_clauses (regulation_id, clause_number, title, content, category) VALUES (?, ?, ?, ?, ?)'
);

const regulations = [
  {
    code: 'TSG T5001-2023',
    name: '电梯维护保养规则',
    source: '国家市场监督管理总局',
    effective_date: '2023-06-01',
    clauses: [
      ['第8条', '维保周期', '电梯的日常维护保养周期不应超过15天。使用单位应当按照规定在维保周期届满前完成维护保养。', '维保周期'],
      ['第15条', '钢丝绳', '电梯钢丝绳磨损率不应超过7%。当钢丝绳磨损率超过7%时，应立即更换。钢丝绳直径减少超过公称直径的7%或出现断丝时应报废。', '安全部件'],
      ['第20条', '故障处理', '发生一般故障时，维保单位应在24小时内响应并处理。发生严重故障时，应立即停止使用电梯并报告相关部门。', '故障处理'],
      ['第25条', '应急救援', '电梯应急救援响应时间不应超过30分钟。使用单位应制定应急预案并定期演练。', '应急救援'],
      ['第30条', '限速器', '限速器应在有效校验期内，校验周期不超过2年。安全钳应与限速器联动可靠。', '安全部件'],
      ['第3条', '使用管理', '使用单位应对电梯的使用安全负责，建立安全管理制度，配备专职安全管理人员。', '管理制度']
    ]
  },
  {
    code: 'TSG T7001-2023',
    name: '电梯监督检验和定期检验规则',
    source: '国家市场监督管理总局',
    effective_date: '2023-06-01',
    clauses: [
      ['第1.2条', '检验周期', '在用电梯的定期检验周期为1年。使用单位应在检验合格有效期届满前1个月向检验机构申报检验。', '检验周期'],
      ['第6.3条', '门机系统', '电梯层门和轿门应正常关闭并锁紧，门机系统应有防夹人保护装置，门锁电气安全装置应可靠有效。', '安全部件'],
      ['第8.2条', '限速器校验', '限速器应在校验有效期内，校验周期不超过2年。限速器动作速度应符合设计要求。', '安全校验'],
      ['第12.5条', '门机故障', '门机系统出现故障时，电梯应不能正常启动或在就近楼层停靠开门。门锁回路应独立可靠。', '故障处理'],
      ['第45条', '制动器', '制动器应能够在电梯正常运行时可靠制动，制动器动作应灵活可靠，制动闸瓦磨损不应超过允许值。', '安全部件']
    ]
  },
  {
    code: 'GB 7588-2020',
    name: '电梯制造与安装安全规范',
    source: '国家标准化管理委员会',
    effective_date: '2020-12-01',
    clauses: [
      ['第12条', '电气安全装置', '电梯应设有电气安全装置，包括门锁、限速器、安全钳、缓冲器等安全开关，任一安全装置动作时应立即使电梯停止。', '电气安全'],
      ['第5.8条', '紧急制动', '电梯应设有紧急制动装置，在紧急情况下能可靠制停电梯。制动距离应符合设计要求，空载和满载制动距离应在规定范围内。', '紧急制动'],
      ['第12.4.2条', '制动器要求', '所有参与向轿厢施加制动的制动器机械部件应至少分成两组装设。如果一组部件不起作用，应仍有足够的制动力使额定载重量的轿厢减速。', '制动器']
    ]
  }
];

for (const reg of regulations) {
  const result = insertRegulation.run(reg.code, reg.name, reg.source, reg.effective_date);
  for (const clause of reg.clauses) {
    insertClause.run(result.lastInsertRowid, clause[0], clause[1], clause[2], clause[3]);
  }
  logOperation('法规导入', 'system', 'regulations', result.lastInsertRowid, `导入法规 ${reg.code} - ${reg.name}`);
}
const totalClauses = regulations.reduce((s, r) => s + r.clauses.length, 0);
console.log(`  ✅ 预置3部法规，共${totalClauses}条条款`);

// ==================== 3. 创建4套初始模板 ====================
const insertTemplate = db.prepare(`
  INSERT INTO templates (code, name, category, version, description, regulation_ids, status, created_by, usage_count)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const insertField = db.prepare(`
  INSERT INTO template_fields (template_id, field_name, field_label, field_type, required, sort_order)
  VALUES (?, ?, ?, ?, ?, ?)
`);

const templates = [
  {
    code: 'TPL_ELEV_001',
    name: '电梯维保合规性判别',
    category: '维保合规',
    version: 1,
    desc: '基于TSG T5001-2023，判别电梯维护保养的合规性',
    regulationIds: '1',
    fields: [
      ['wire_rope_wear_rate', '钢丝绳磨损率(%)', 'number', 1, 1],
      ['maintenance_interval', '维保间隔天数', 'number', 1, 2],
      ['brake_status', '制动器状态', 'text', 1, 3],
      ['door_status', '门机系统状态', 'text', 1, 4],
      ['governor_calibrated', '限速器是否在校验期内', 'text', 1, 5]
    ]
  },
  {
    code: 'TPL_ELEV_002',
    name: '电梯定期检验申报审核',
    category: '检验审核',
    version: 1,
    desc: '基于TSG T7001-2023，审核电梯定期检验申报合规性',
    regulationIds: '2',
    fields: [
      ['inspection_interval', '距上次检验天数', 'number', 1, 1],
      ['inspection_qualified', '检验机构是否具备资质', 'text', 1, 2],
      ['report_complete', '检验报告是否完整', 'text', 1, 3]
    ]
  },
  {
    code: 'TPL_ELEV_003',
    name: '电梯故障报修判别',
    category: '故障处理',
    version: 1,
    desc: '基于TSG T5001-2023，判别电梯故障报修处理合规性',
    regulationIds: '1',
    fields: [
      ['fault_level', '故障等级(一般/严重)', 'text', 1, 1],
      ['emergency_response', '应急响应时间(分钟)', 'number', 1, 2],
      ['report_timely', '是否及时上报', 'text', 1, 3]
    ]
  },
  {
    code: 'TPL_ELEV_004',
    name: '电梯安全部件检查判别',
    category: '安全检查',
    version: 1,
    desc: '综合TSG T5001-2023和GB 7588-2020，判别关键安全部件状态',
    regulationIds: '1,3',
    fields: [
      ['wire_rope_wear_rate', '钢丝绳磨损率(%)', 'number', 1, 1],
      ['governor_calibrated', '限速器校验状态', 'text', 1, 2],
      ['brake_status', '制动器状态', 'text', 1, 3],
      ['door_status', '门机系统状态', 'text', 1, 4],
      ['safety_gear_status', '安全钳状态', 'text', 1, 5]
    ]
  }
];

for (const tpl of templates) {
  const result = insertTemplate.run(
    tpl.code, tpl.name, tpl.category, tpl.version,
    tpl.desc, tpl.regulationIds, 'published', /* status 用 'published' */
    'admin@demo.com',
    Math.floor(Math.random() * 100) + 10
  );
  for (const field of tpl.fields) {
    insertField.run(result.lastInsertRowid, field[0], field[1], field[2], field[3], field[4]);
  }
  logOperation('模板创建', 'system', 'templates', result.lastInsertRowid, `创建模板 ${tpl.name}(${tpl.code})`);
}
console.log(`  ✅ 预置${templates.length}套模板（status=published）`);

// ==================== 4. 生成判别记录 ====================
const insertRecord = db.prepare(`
  INSERT INTO discrimination_records
    (template_id, template_name, input_text, form_data, ai_classification,
     rule_results, final_result, clause_ref, user_email, audit_status, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

// 预定义多种真实场景的表单数据
const sampleFormDataSets = [
  // 维保合规 - 合规场景
  {
    templateId: 1, templateName: '电梯维保合规性判别',
    input: '电梯维保正常，钢丝绳磨损率5%，维保间隔12天，制动器和门机均正常，限速器已校验。',
    form: { wire_rope_wear_rate: '5', maintenance_interval: '12', brake_status: '正常', door_status: '正常', governor_calibrated: '是' }
  },
  // 维保合规 - 不合规（钢丝绳磨损超标）
  {
    templateId: 1, templateName: '电梯维保合规性判别',
    input: '钢丝绳磨损率9%，维保间隔14天，制动器正常，门机正常，限速器已校验。',
    form: { wire_rope_wear_rate: '9', maintenance_interval: '14', brake_status: '正常', door_status: '正常', governor_calibrated: '是' }
  },
  // 维保合规 - 待人工（维保周期略超）
  {
    templateId: 1, templateName: '电梯维保合规性判别',
    input: '钢丝绳磨损率6%，维保间隔16天，制动器正常，门机偶有异常，限速器已校验。',
    form: { wire_rope_wear_rate: '6', maintenance_interval: '16', brake_status: '正常', door_status: '偶有异常', governor_calibrated: '是' }
  },
  // 维保合规 - 多处不合规
  {
    templateId: 1, templateName: '电梯维保合规性判别',
    input: '钢丝绳磨损率12%，维保间隔20天，制动器异常，门机正常，限速器未校验。',
    form: { wire_rope_wear_rate: '12', maintenance_interval: '20', brake_status: '异常', door_status: '正常', governor_calibrated: '否' }
  },
  // 检验申报 - 合规
  {
    templateId: 2, templateName: '电梯定期检验申报审核',
    input: '距上次检验180天，检验机构具备资质，检验报告完整。',
    form: { inspection_interval: '180', inspection_qualified: '是', report_complete: '是' }
  },
  // 检验申报 - 不合规（超期）
  {
    templateId: 2, templateName: '电梯定期检验申报审核',
    input: '距上次检验400天，已超检验有效期，但检验机构具备资质，报告完整。',
    form: { inspection_interval: '400', inspection_qualified: '是', report_complete: '是' }
  },
  // 故障报修 - 合规
  {
    templateId: 3, templateName: '电梯故障报修判别',
    input: '一般故障，应急响应20分钟，已及时上报。',
    form: { fault_level: '一般', emergency_response: '20', report_timely: '是' }
  },
  // 故障报修 - 不合规（严重故障未停梯）
  {
    templateId: 3, templateName: '电梯故障报修判别',
    input: '严重故障，应急响应45分钟，未及时上报。',
    form: { fault_level: '严重', emergency_response: '45', report_timely: '否' }
  },
  // 安全部件检查 - 合规
  {
    templateId: 4, templateName: '电梯安全部件检查判别',
    input: '钢丝绳磨损率4%，限速器已校验，制动器正常，门机正常，安全钳正常。',
    form: { wire_rope_wear_rate: '4', governor_calibrated: '是', brake_status: '正常', door_status: '正常', safety_gear_status: '正常' }
  },
  // 安全部件检查 - 不合规
  {
    templateId: 4, templateName: '电梯安全部件检查判别',
    input: '钢丝绳磨损率11%，限速器未校验，制动器异常，门机正常，安全钳异常。',
    form: { wire_rope_wear_rate: '11', governor_calibrated: '否', brake_status: '异常', door_status: '正常', safety_gear_status: '异常' }
  },
  // 故障报修 - 待人工
  {
    templateId: 3, templateName: '电梯故障报修判别',
    input: '一般故障，应急响应35分钟，已及时上报。',
    form: { fault_level: '一般', emergency_response: '35', report_timely: '是' }
  },
  // 维保合规 - 待人工（缺数据）
  {
    templateId: 1, templateName: '电梯维保合规性判别',
    input: '钢丝绳磨损率3%，维保间隔未知，制动器正常，门机状态未知，限速器已校验。',
    form: { wire_rope_wear_rate: '3', maintenance_interval: '', brake_status: '正常', door_status: '', governor_calibrated: '是' }
  }
];

// 用规则引擎逐个执行真实场景，确保 rule_results 真实
const recordIdList = [];
for (let i = 0; i < sampleFormDataSets.length; i++) {
  const s = sampleFormDataSets[i];
  const engineResult = ruleEngine.execute(s.form, s.templateId, s.templateName);

  const finalResult = engineResult.finalResult;
  const auditStatus = finalResult === '待人工' ? 'pending' : 'approved';

  const day = String(Math.floor(Math.random() * 14) + 1).padStart(2, '0');
  const hour = String(Math.floor(Math.random() * 16) + 6).padStart(2, '0');
  const minute = String(Math.floor(Math.random() * 60)).padStart(2, '0');

  const r = insertRecord.run(
    s.templateId,
    s.templateName,
    s.input,
    JSON.stringify(s.form),
    JSON.stringify({ source: 'keyword_match', confidence: (0.75 + Math.random() * 0.2).toFixed(2) }),
    JSON.stringify(engineResult.executionLog),
    finalResult,
    engineResult.executionLog
      .filter(rr => rr.result !== '合规')
      .map(rr => rr.clause)
      .join('；') || '全部合规',
    'user@demo.com',
    auditStatus,
    `2026-06-${day} ${hour}:${minute}:00`
  );
  recordIdList.push(r.lastInsertRowid);

  logOperation(
    '提交判别',
    'user@demo.com',
    'discrimination_records',
    r.lastInsertRowid,
    `模板: ${s.templateName}, 结果: ${finalResult}`
  );
}
console.log(`  ✅ 生成 ${sampleFormDataSets.length} 条真实判别记录（含完整 form_data / rule_results JSON）`);

// 再生成更多随机判别记录补充数据量（沿用规则引擎获得真实结果）
for (let i = 0; i < 90; i++) {
  const tplIdx = Math.floor(Math.random() * 4);
  const tpl = templates[tplIdx];

  // 构造随机表单数据
  const formData = {};
  const fieldDefs = tpl.fields;
  for (const fd of fieldDefs) {
    const fname = fd[0];
    if (fname === 'wire_rope_wear_rate') {
      formData[fname] = String(Math.floor(Math.random() * 15));
    } else if (fname === 'maintenance_interval') {
      formData[fname] = String(Math.floor(Math.random() * 25) + 1);
    } else if (fname === 'brake_status' || fname === 'safety_gear_status') {
      formData[fname] = Math.random() > 0.2 ? '正常' : '异常';
    } else if (fname === 'door_status') {
      formData[fname] = Math.random() > 0.25 ? '正常' : '偶有异常';
    } else if (fname === 'governor_calibrated') {
      formData[fname] = Math.random() > 0.15 ? '是' : '否';
    } else if (fname === 'inspection_interval') {
      formData[fname] = String(Math.floor(Math.random() * 500) + 30);
    } else if (fname === 'inspection_qualified' || fname === 'report_complete' || fname === 'report_timely') {
      formData[fname] = Math.random() > 0.15 ? '是' : '否';
    } else if (fname === 'fault_level') {
      formData[fname] = Math.random() > 0.4 ? '一般' : '严重';
    } else if (fname === 'emergency_response') {
      formData[fname] = String(Math.floor(Math.random() * 60) + 5);
    } else {
      formData[fname] = '正常';
    }
  }

  const engineResult = ruleEngine.execute(formData, tplIdx + 1, tpl.name);
  const finalResult = engineResult.finalResult;
  const auditStatus = finalResult === '待人工' ? 'pending' : 'approved';

  const day = String(Math.floor(Math.random() * 14) + 1).padStart(2, '0');
  const hour = String(Math.floor(Math.random() * 16) + 6).padStart(2, '0');
  const minute = String(Math.floor(Math.random() * 60)).padStart(2, '0');

  const r = insertRecord.run(
    tplIdx + 1,
    tpl.name,
    '',
    JSON.stringify(formData),
    JSON.stringify({ source: 'keyword_match', confidence: 0.8 }),
    JSON.stringify(engineResult.executionLog),
    finalResult,
    engineResult.executionLog
      .filter(rr => rr.result !== '合规')
      .map(rr => rr.clause)
      .join('；') || '全部合规',
    Math.random() > 0.5 ? 'user@demo.com' : 'admin@demo.com',
    auditStatus,
    `2026-06-${day} ${hour}:${minute}:00`
  );
  recordIdList.push(r.lastInsertRowid);
}
console.log('  ✅ 随机补充 90 条判别记录');

// ==================== 5. 生成操作日志（更多真实日志） ====================
// 基础日志已由用户创建、法规导入、模板创建等操作生成

const operationActions = [
  '登录系统', '提交判别', '审核通过', '审核驳回',
  '查看法规', '导出报告', '修改模板', '规则执行',
  '创建模板', '删除模板', '新建判别', '查看日志'
];
const userEmails = ['admin@demo.com', 'auditor@demo.com', 'user@demo.com'];

for (let i = 0; i < 240; i++) {
  const action = operationActions[Math.floor(Math.random() * operationActions.length)];
  const email = userEmails[Math.floor(Math.random() * 3)];
  logOperation(
    action,
    email,
    'discrimination_records',
    Math.floor(Math.random() * 100) + 1,
    `执行操作：${action}`
  );
}

const logCount = db.prepare('SELECT COUNT(*) as count FROM operation_logs').get().count;
console.log(`  ✅ 生成 ${logCount} 条操作日志（含完整 SHA-256 哈希链）`);

// ==================== 6. 生成审核任务 ====================
const insertAudit = db.prepare(`
  INSERT INTO audit_tasks (record_id, task_type, status, assigned_to, created_at)
  VALUES (?, ?, ?, ?, ?)
`);

// 找到所有 '待人工' 的判别记录，为其创建审核任务
const pendingRecords = db.prepare(
  "SELECT id, created_at FROM discrimination_records WHERE final_result = '待人工' ORDER BY id"
).all();

let auditCount = 0;
for (const rec of pendingRecords) {
  insertAudit.run(
    rec.id,
    'discrimination',
    'pending',
    'auditor@demo.com',
    rec.created_at
  );
  auditCount++;
}

// 也生成一些已完成的审核任务用于展示
const approvedRecords = db.prepare(
  "SELECT id, created_at FROM discrimination_records WHERE final_result != '待人工' LIMIT 5"
).all();
for (const rec of approvedRecords) {
  insertAudit.run(
    rec.id,
    'discrimination',
    'approved',
    'auditor@demo.com',
    rec.created_at
  );
  auditCount++;
}

console.log(`  ✅ 生成 ${auditCount} 条审核任务（${pendingRecords.length} 条关联待人工记录）`);

// ==================== 7. 生成研究任务 ====================
const insertResearch = db.prepare(`
  INSERT INTO research_tasks (name, description, regulation_ids, status, created_by, created_at)
  VALUES (?, ?, ?, ?, ?, ?)
`);

const researchTasks = [
  ['维保规则新版研究', '基于TSG T5001最新修订版，研究维保周期调整对合规的影响', '1', 'ai_generated', 'admin@demo.com', '2026-06-10 09:00:00'],
  ['智能门锁安全标准调研', '调研GB 7588-2020中关于智能门锁的新增安全要求', '3', 'created', 'admin@demo.com', '2026-06-12 14:30:00'],
  ['电梯制动器可靠性分析', '基于TSG T7001-2023 第45条，分析制动器可靠性判据', '2', 'published', 'admin@demo.com', '2026-06-08 10:00:00'],
];

for (const t of researchTasks) {
  const result = insertResearch.run(t[0], t[1], t[2], t[3], t[4], t[5]);
  logOperation('创建研究任务', 'admin@demo.com', 'research_tasks', result.lastInsertRowid, `创建研究任务: ${t[0]}`);
}
console.log('  ✅ 生成 3 条研究任务');

// ==================== 统计 ====================
const stats = {
  users:     db.prepare('SELECT COUNT(*) as c FROM users').get().c,
  regulations: db.prepare('SELECT COUNT(*) as c FROM regulations').get().c,
  clauses:   db.prepare('SELECT COUNT(*) as c FROM regulation_clauses').get().c,
  templates: db.prepare('SELECT COUNT(*) as c FROM templates').get().c,
  records:   db.prepare('SELECT COUNT(*) as c FROM discrimination_records').get().c,
  logs:      db.prepare('SELECT COUNT(*) as c FROM operation_logs').get().c,
  audits:    db.prepare('SELECT COUNT(*) as c FROM audit_tasks').get().c
};

console.log('\n📊 数据库初始化完成!');
console.log(`   用户: ${stats.users} 个`);
console.log(`   法规: ${stats.regulations} 部 (${stats.clauses} 条条款)`);
console.log(`   模板: ${stats.templates} 套`);
console.log(`   判别记录: ${stats.records} 条`);
console.log(`   操作日志: ${stats.logs} 条 (SHA-256 哈希链)`);
console.log(`   审核任务: ${stats.audits} 条`);
console.log(`   📦 总计: ${stats.users + stats.regulations + stats.clauses + stats.templates + stats.records + stats.logs + stats.audits} 条记录`);
console.log('\n🔑 演示账号:');
console.log('   管理员: admin@demo.com / 123456');
console.log('   审核员: auditor@demo.com / 123456');
console.log('   用户: user@demo.com / 123456');
