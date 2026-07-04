/**
 * 司法留痕模块 - 哈希链 + 操作日志
 * 所有增删改查操作强制记录，生成SHA-256哈希链
 */
const crypto = require('crypto');
const { getDb } = require('./db');

// 计算SHA-256哈希
function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

// 记录操作日志并生成哈希链
function logOperation(action, userEmail, targetType, targetId, detail) {
  const db = getDb();
  
  // 获取上一条日志的哈希
  const lastLog = db.prepare('SELECT hash FROM operation_logs ORDER BY id DESC LIMIT 1').get();
  const prevHash = lastLog ? lastLog.hash : '0x' + '0'.repeat(64);
  
  // 使用统一的时间戳格式（存入DB的格式）
  const ts = new Date().toISOString().replace('T', ' ').replace(/\..+/, '');
  
  // 计算当前日志哈希
  const hashInput = JSON.stringify({
    action, userEmail, targetType, targetId, detail,
    prevHash, timestamp: ts
  });
  const hash = sha256(hashInput);
  
  // 写入日志（显式传入时间戳确保哈希一致）
  db.prepare(`
    INSERT INTO operation_logs (action, user_email, target_type, target_id, detail, prev_hash, hash, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(action, userEmail, targetType, targetId, detail, prevHash, hash, ts);
  
  return { hash, prevHash };
}

// 验证哈希链完整性
function verifyChain() {
  const db = getDb();
  const logs = db.prepare('SELECT * FROM operation_logs ORDER BY id ASC').all();
  
  let prevHash = '0x' + '0'.repeat(64);
  let isValid = true;
  const errors = [];
  
  for (const log of logs) {
    // 验证前后哈希链连接
    if (log.prev_hash !== prevHash) {
      isValid = false;
      errors.push({
        id: log.id,
        expectedPrevHash: prevHash,
        actualPrevHash: log.prev_hash
      });
    }
    
    // 验证当前哈希
    const hashInput = JSON.stringify({
      action: log.action,
      userEmail: log.user_email,
      targetType: log.target_type,
      targetId: log.target_id,
      detail: log.detail,
      prevHash: log.prev_hash,
      timestamp: log.timestamp
    });
    const computedHash = sha256(hashInput);
    
    if (computedHash !== log.hash) {
      isValid = false;
      errors.push({
        id: log.id,
        expectedHash: computedHash,
        actualHash: log.hash
      });
    }
    
    prevHash = log.hash;
  }
  
  return {
    isValid,
    totalBlocks: logs.length,
    chainRoot: logs.length > 0 ? logs[logs.length - 1].hash : null,
    errors
  };
}

// 获取操作日志列表
function getLogs(page = 1, pageSize = 20) {
  const db = getDb();
  const offset = (page - 1) * pageSize;
  const logs = db.prepare('SELECT * FROM operation_logs ORDER BY id DESC LIMIT ? OFFSET ?').all(pageSize, offset);
  const total = db.prepare('SELECT COUNT(*) as count FROM operation_logs').get().count;
  return { data: logs, total, page, pageSize, totalPages: Math.ceil(total / pageSize) };
}

module.exports = { logOperation, verifyChain, getLogs };
