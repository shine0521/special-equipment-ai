/**
 * 数据库模块 - 使用SQLite作为本地数据库
 * 8张核心表：users, regulations, regulation_clauses, templates, template_fields, 
 *           discrimination_records, audit_tasks, operation_logs
 */
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// Railway 持久化存储路径: $DATA_DIR (Railway 官方变量)
const DATA_DIR = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname);
const DB_PATH = path.join(DATA_DIR, 'data.db');
let db;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initTables();
  }
  return db;
}

function initTables() {
  db.exec(`
    -- 1. 用户表
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      name TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('user','auditor','admin')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- 2. 法规表（知识库）
    CREATE TABLE IF NOT EXISTS regulations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      source TEXT,
      effective_date DATE,
      status TEXT DEFAULT 'active' CHECK(status IN ('active','archived','draft')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- 3. 法规条款表
    CREATE TABLE IF NOT EXISTS regulation_clauses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      regulation_id INTEGER NOT NULL REFERENCES regulations(id) ON DELETE CASCADE,
      clause_number TEXT NOT NULL,
      title TEXT,
      content TEXT NOT NULL,
      category TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- 4. 模板表
    CREATE TABLE IF NOT EXISTS templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      version INTEGER DEFAULT 1,
      description TEXT,
      regulation_ids TEXT,
      status TEXT DEFAULT 'published' CHECK(status IN ('draft','review','published','archived')),
      created_by TEXT,
      usage_count INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- 5. 模板字段表
    CREATE TABLE IF NOT EXISTS template_fields (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      template_id INTEGER NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
      field_name TEXT NOT NULL,
      field_label TEXT NOT NULL,
      field_type TEXT NOT NULL CHECK(field_type IN ('text','number','date','select','textarea')),
      required INTEGER DEFAULT 1,
      sort_order INTEGER DEFAULT 0,
      options TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- 6. 判别记录表
    CREATE TABLE IF NOT EXISTS discrimination_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      template_id INTEGER REFERENCES templates(id),
      template_name TEXT,
      input_text TEXT,
      form_data TEXT,
      ai_classification TEXT,
      rule_results TEXT,
      final_result TEXT NOT NULL CHECK(final_result IN ('合规','不合规','待人工')),
      reject_reason TEXT,
      clause_ref TEXT,
      user_email TEXT,
      audit_status TEXT DEFAULT 'pending' CHECK(audit_status IN ('pending','approved','rejected')),
      audit_by TEXT,
      audit_comment TEXT,
      hash TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- 7. 审核任务表
    CREATE TABLE IF NOT EXISTS audit_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      record_id INTEGER REFERENCES discrimination_records(id),
      task_type TEXT DEFAULT 'discrimination' CHECK(task_type IN ('discrimination','template_review')),
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending','processing','approved','rejected')),
      assigned_to TEXT,
      comment TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- 8. 操作日志表（司法留痕）
    CREATE TABLE IF NOT EXISTS operation_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL,
      user_email TEXT,
      target_type TEXT,
      target_id INTEGER,
      detail TEXT,
      prev_hash TEXT,
      hash TEXT NOT NULL,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- 9. 研究任务表
    CREATE TABLE IF NOT EXISTS research_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      regulation_ids TEXT,
      ai_draft TEXT,
      expert_changes TEXT,
      status TEXT DEFAULT 'created' CHECK(status IN ('created','ai_generated','expert_review','published')),
      template_id INTEGER REFERENCES templates(id),
      created_by TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- 索引
    CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
    CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
    CREATE INDEX IF NOT EXISTS idx_templates_code ON templates(code);
    CREATE INDEX IF NOT EXISTS idx_templates_category ON templates(category);
    CREATE INDEX IF NOT EXISTS idx_disc_records_result ON discrimination_records(final_result);
    CREATE INDEX IF NOT EXISTS idx_disc_records_audit ON discrimination_records(audit_status);
    CREATE INDEX IF NOT EXISTS idx_op_logs_hash ON operation_logs(hash);
    CREATE INDEX IF NOT EXISTS idx_op_logs_timestamp ON operation_logs(timestamp);
    CREATE INDEX IF NOT EXISTS idx_audit_tasks_status ON audit_tasks(status);
    CREATE INDEX IF NOT EXISTS idx_clauses_regulation ON regulation_clauses(regulation_id);
    CREATE INDEX IF NOT EXISTS idx_fields_template ON template_fields(template_id);
  `);
}

module.exports = { getDb };
