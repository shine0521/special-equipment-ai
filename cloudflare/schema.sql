-- 特种设备电梯AI系统 D1 数据库架构
-- 运行一次即可

-- 用户表
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- 判别记录表
CREATE TABLE IF NOT EXISTS discrimination_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  module_name TEXT NOT NULL,
  record_content TEXT NOT NULL,
  ai_result TEXT DEFAULT '待人工',
  ai_confidence INTEGER DEFAULT 0,
  ai_reason TEXT DEFAULT '',
  matched_rule TEXT DEFAULT '',
  final_result TEXT DEFAULT '待人工',
  created_by INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (created_by) REFERENCES users(id)
);

-- 审核任务表
CREATE TABLE IF NOT EXISTS audit_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  record_id INTEGER NOT NULL,
  status TEXT DEFAULT 'pending',
  assigned_to INTEGER,
  auditor_comment TEXT DEFAULT '',
  priority TEXT DEFAULT 'normal',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (record_id) REFERENCES discrimination_records(id),
  FOREIGN KEY (assigned_to) REFERENCES users(id)
);

-- 法规表
CREATE TABLE IF NOT EXISTS regulations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  source_url TEXT DEFAULT '',
  effective_date TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);

-- 法规条款表
CREATE TABLE IF NOT EXISTS regulation_clauses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  regulation_id INTEGER NOT NULL,
  clause_number TEXT NOT NULL,
  clause_content TEXT NOT NULL,
  keywords TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (regulation_id) REFERENCES regulations(id)
);

-- 模板表
CREATE TABLE IF NOT EXISTS templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  fields TEXT DEFAULT '[]',
  status TEXT DEFAULT 'draft',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- 规则引擎规则表
CREATE TABLE IF NOT EXISTS rule_engine_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_name TEXT NOT NULL,
  module_type TEXT DEFAULT '通用',
  keywords TEXT DEFAULT '',
  action_type TEXT DEFAULT 'classify',
  action_value TEXT DEFAULT '待人工',
  priority INTEGER DEFAULT 0,
  confidence_threshold REAL DEFAULT 0.5,
  suggestions TEXT DEFAULT '[]',
  enabled INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

-- 研究任务表
CREATE TABLE IF NOT EXISTS research_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  status TEXT DEFAULT 'pending',
  result TEXT DEFAULT '',
  created_by INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  completed_at TEXT,
  FOREIGN KEY (created_by) REFERENCES users(id)
);

-- 哈希链表
CREATE TABLE IF NOT EXISTS hash_chain (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  block_index INTEGER UNIQUE NOT NULL,
  table_name TEXT NOT NULL,
  record_id INTEGER NOT NULL,
  description TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL,
  operator TEXT DEFAULT 'system',
  created_at TEXT DEFAULT (datetime('now'))
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_discrim_records_created ON discrimination_records(created_at);
CREATE INDEX IF NOT EXISTS idx_discrim_records_result ON discrimination_records(final_result);
CREATE INDEX IF NOT EXISTS idx_audit_tasks_status ON audit_tasks(status);
CREATE INDEX IF NOT EXISTS idx_reg_clauses_reg ON regulation_clauses(regulation_id);
CREATE INDEX IF NOT EXISTS idx_hash_chain_index ON hash_chain(block_index);

-- 种子数据：3个用户
INSERT OR IGNORE INTO users (email, name, password_hash, role) VALUES
  ('admin@demo.com', '管理员', '240be518fabd2724ddb6f04eeb1da5967448d7e831c08c8fa822809f74c720a9', 'admin'),
  ('auditor@demo.com', '审核员王五', '240be518fabd2724ddb6f04eeb1da5967448d7e831c08c8fa822809f74c720a9', 'auditor'),
  ('user@demo.com', '普通用户李四', '240be518fabd2724ddb6f04eeb1da5967448d7e831c08c8fa822809f74c720a9', 'user');

-- 种子数据：4个法规
INSERT OR IGNORE INTO regulations (code, name, description, effective_date) VALUES
  ('TSG 7001-2023', '电梯定期检验规则', '适用于曳引电梯、强制驱动电梯的定期检验', '2023-07-01'),
  ('GB 7588-2020', '电梯制造与安装安全规范', '电梯设计、制造、安装的基本安全要求', '2022-07-01'),
  ('TSG 7008-2023', '电梯维保规则', '电梯日常维护保养的基本要求', '2023-01-01'),
  ('特种设备安全法', '中华人民共和国特种设备安全法', '特种设备（包括电梯）的安全管理基本法律', '2014-01-01');

-- 种子数据：14个条款
INSERT OR IGNORE INTO regulation_clauses (regulation_id, clause_number, clause_content, keywords) VALUES
  (1, '5.2.1', '轿厢轿头电气安全装置应动作可靠，在电梯正常运行时不应动作', '轿顶 电气安全装置 动作 可靠'),
  (1, '6.8.1', '紧急照明和疏散指示灯应正常工作，照明照度符合要求', '紧急照明 疏散指示 照度'),
  (1, '7.2.1', '制动器动作灵活，制动可靠，制动间隙符合要求', '制动器 制动 间隙 灵活'),
  (1, '8.1.2', '曳引轮绳槽磨损不应超过制造单位要求，曳引力应满足要求', '曳引轮 绳槽 磨损 曳引力'),
  (2, '6.2.1', '层门地坎应水平安装，水平度不应超过2/1000', '层门地坎 水平度 2/1000'),
  (2, '6.3.2', '门锁装置应动作可靠，在层门关闭后应锁紧', '门锁 锁紧 动作可靠'),
  (2, '7.1.1', '安全钳应在限速器动作时可靠动作', '安全钳 限速器 动作'),
  (2, '7.4.3', '缓冲器应固定可靠，蓄能型缓冲器应设置电气安全装置', '缓冲器 固定 电气安全装置'),
  (3, '4.2.1', '每15天应进行至少一次日常维护保养', '15天 维保 日常维护'),
  (3, '5.1.3', '制动器应检查制动片磨损情况，必要时及时更换', '制动片 磨损 更换 制动器'),
  (3, '5.3.1', '门机皮带应检查张紧度，必要时调整或更换', '门机 皮带 张紧度 调整'),
  (3, '6.1.2', '记录维保内容、维保时间、维保人员', '维保记录 维保人员 时间'),
  (4, '第13条', '特种设备生产、经营、使用单位应当建立特种设备安全技术档案', '安全技术档案 建立'),
  (4, '第36条', '电梯等为公众提供服务的特种设备运营使用单位，应当设置特种设备安全管理机构', '安全管理机构 设置');

-- 种子数据：4个模板
INSERT OR IGNORE INTO templates (name, description, fields, status) VALUES
  ('电梯定期检验记录', '电梯定期检验通用记录表', '["设备编号","检验日期","检验结论","主要不合格项"]', 'published'),
  ('电梯维保记录', '日常维护保养工作记录', '["设备编号","维保日期","维保类型","维保项目","维保人员"]', 'published'),
  ('电梯故障记录', '电梯故障及处理记录', '["设备编号","故障时间","故障现象","故障原因","处理措施"]', 'published'),
  ('安全隐患整改单', '特种设备安全隐患整改记录', '["设备编号","隐患描述","整改要求","整改期限","整改结果"]', 'published');

-- 种子数据：15条规则
INSERT OR IGNORE INTO rule_engine_rules (rule_name, module_type, keywords, action_type, action_value, priority, suggestions, enabled) VALUES
  ('制动器异常', '电梯检验', '制动,制动器,抱闸,刹车,制动片', 'classify', '不合规', 10, '["立即停梯","联系维保单位检修"]', 1),
  ('曳引轮磨损', '电梯检验', '曳引轮,绳槽,磨损,跳槽,断丝', 'classify', '不合规', 9, '["更换曳引轮绳槽","检查钢丝绳"]', 1),
  ('门锁失效', '电梯检验', '门锁,层门,轿门,锁紧,门刀', 'classify', '不合规', 10, '["停梯检修","更换门锁装置"]', 1),
  ('安全钳失效', '电梯检验', '安全钳,限速器,动作,卡阻', 'classify', '待人工', 8, '["需现场专业检测","通知特种设备检验机构"]', 1),
  ('紧急照明故障', '电梯检验', '紧急照明,疏散指示,照明,应急灯', 'classify', '不合规', 6, '["更换应急灯","检查供电线路"]', 1),
  ('维保过期', '电梯维保', '维保,保养,超期,过期,15天', 'classify', '待人工', 7, '["立即安排维保","检查上次维保记录"]', 1),
  ('层门地坎水平度', '电梯检验', '层门,地坎,水平度,倾斜,偏差', 'classify', '待人工', 5, '["测量水平度偏差值","调整地坎"]', 1),
  ('缓冲器异常', '电梯检验', '缓冲器,固定,变形,漏油,液压', 'classify', '待人工', 5, '["检查缓冲器型号","更换或维修"]', 1),
  ('安全技术档案缺失', '安全管理', '档案,台账,资料,缺失,未建立', 'classify', '不合规', 8, '["建立完整安全技术档案","补充历史记录"]', 1),
  ('安全管理机构', '安全管理', '安全管理机构,专职人员,配备', 'classify', '待人工', 6, '["设置安全管理机构","配备安全管理人员"]', 1),
  ('正常维保', '电梯维保', '正常,合格,符合要求,良好', 'classify', '合规', 3, '["记录维保结果","更新维保台账"]', 1),
  ('检验合格', '电梯检验', '合格,符合要求,检验通过,复检合格', 'classify', '合规', 3, '["出具检验报告","归档保存"]', 1),
  ('门机故障', '电梯维保', '门机,皮带,开关门,地坎,门刀', 'classify', '待人工', 6, '["检查门机皮带张紧度","调整门机参数"]', 1),
  ('轿顶检修', '电梯检验', '轿顶,检修,急停,检修运行', 'classify', '合规', 2, '["确认检修装置正常","记录检验结果"]', 1),
  ('通用待审', '通用', '其他,异常,疑问,需确认', 'classify', '待人工', 1, '["转人工审核","补充相关资料"]', 1);

-- 种子数据：10条初始判别记录
INSERT OR IGNORE INTO discrimination_records (module_name, record_content, ai_result, ai_confidence, ai_reason, matched_rule, final_result, created_by) VALUES
  ('电梯定期检验记录', '轿顶检修装置动作可靠，急停开关有效，轿顶防护栏安装牢固，检修运行正常', '合规', 92, '命中规则「轿顶检修」', '轿顶检修', '合规', 1),
  ('电梯维保记录', '制动器制动片磨损至2.5mm，低于制造单位要求的3mm，需立即更换', '不合规', 95, '命中规则「制动器异常」', '制动器异常', '待人工', 1),
  ('电梯定期检验记录', '层门地坎水平度测量值为3.5/1000，超过标准限值2/1000', '待人工', 78, '命中规则「层门地坎水平度」', '层门地坎水平度', '待人工', 1),
  ('电梯维保记录', '15天维保周期内完成日常保养，曳引机运行正常，各安全装置动作可靠', '合规', 89, '命中规则「正常维保」', '正常维保', '合规', 1),
  ('电梯故障记录', '3号楼电梯3月2日出现开门不走车故障，经检查为门机皮带断裂', '待人工', 72, '命中规则「门机故障」', '门机故障', '待人工', 1),
  ('电梯定期检验记录', '紧急照明装置无法点亮，蓄电池失效，疏散指示标志正常', '不合规', 91, '命中规则「紧急照明故障」', '紧急照明故障', '待人工', 1),
  ('安全管理检查', '物业公司建立了电梯安全技术档案，包含设备出厂资料、安装验收资料、维保记录、检验报告等', '合规', 88, '命中规则「检验合格」', '检验合格', '合规', 1),
  ('电梯定期检验记录', '曳引轮绳槽最大磨损量4.5mm，制造单位要求超过5mm需更换，目前尚可继续使用但需缩短维保周期', '待人工', 75, '命中规则「曳引轮磨损」', '曳引轮磨损', '待人工', 1),
  ('安全管理检查', '物业未建立特种设备安全技术档案，也未配备专职安全管理人员', '不合规', 94, '命中规则「安全技术档案缺失」', '安全技术档案缺失', '待人工', 1),
  ('电梯维保记录', '门机皮带张紧度正常，开关门运行平稳，无异常声响，地坎清洁无杂物', '合规', 90, '命中规则「正常维保」', '正常维保', '合规', 1);

-- 种子数据：3条审核任务
INSERT OR IGNORE INTO audit_tasks (record_id, status, priority, assigned_to) VALUES
  (2, 'pending', 'high', NULL),
  (3, 'pending', 'normal', NULL),
  (6, 'pending', 'normal', NULL);

-- 种子数据：哈希链初始化（10个区块）
INSERT OR IGNORE INTO hash_chain (block_index, table_name, record_id, description, timestamp, prev_hash, hash, operator) VALUES
  (1, 'init', 0, 'Genesis Block - 系统初始化', '2024-01-15 09:00:00', '0000000000000000000000000000000000000000000000000000000000000000', 'a665a45920422f9d417e4867efdc4fb8a04a1f3fff1fa07e998e86f7f7a27ae3', 'system'),
  (2, 'users', 1, '新增用户: admin@demo.com', '2024-01-15 09:01:00', 'a665a45920422f9d417e4867efdc4fb8a04a1f3fff1fa07e998e86f7f7a27ae3', 'b3a8cc81e8d2e69f68f3d6b9c8f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8', 'system'),
  (3, 'users', 2, '新增用户: auditor@demo.com', '2024-01-15 09:02:00', 'b3a8cc81e8d2e69f68f3d6b9c8f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8', 'c4b9dd92f9e3f70a479e5970d1e2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a', 'system'),
  (4, 'users', 3, '新增用户: user@demo.com', '2024-01-15 09:03:00', 'c4b9dd92f9e3f70a479e5970d1e2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a', 'd5caeea3fa4f81b58af0a687e2f3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b', 'system'),
  (5, 'templates', 1, '新增模板: 电梯定期检验记录', '2024-01-15 09:04:00', 'd5caeea3fa4f81b58af0a687e2f3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b', 'e6dbaeb4fb5f92c69bf1b798f304d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c', 'system'),
  (6, 'regulations', 1, '新增法规: TSG 7001-2023', '2024-01-15 09:05:00', 'e6dbaeb4fb5f92c69bf1b798f304d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c', 'f7ecbfc5fc6fa3d7ac2c89a9f415e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d', 'system'),
  (7, 'rule_engine_rules', 1, '新增规则: 制动器异常', '2024-01-15 09:06:00', 'f7ecbfc5fc6fa3d7ac2c89a9f415e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d', 'a8fdd0d6ad7b4e8ebd3d9abf526f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e', 'system'),
  (8, 'discrimination_records', 1, '新增判别记录: 合规', '2024-01-15 09:07:00', 'a8fdd0d6ad7b4e8ebd3d9abf526f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e', 'b9aee1e7be8c5f9fad4eabacd637a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f', 'system'),
  (9, 'discrimination_records', 2, '新增判别记录: 不合规', '2024-01-15 09:08:00', 'b9aee1e7be8c5f9fad4eabacd637a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f', 'acbff2f8cf9d6a0bae5ebcdbe48a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a', 'system'),
  (10, 'audit_tasks', 1, '新增审核任务: 记录#2 不合规', '2024-01-15 09:09:00', 'acbff2f8cf9d6a0bae5ebcdbe48a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a', 'bda003e9da0e7b1cbf6fcaecf59b8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b', 'system');
