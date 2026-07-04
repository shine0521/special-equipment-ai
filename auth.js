/**
 * 身份鉴权模块
 * 三类角色：user(普通用户)、auditor(审核员)、admin(管理员)
 */
const crypto = require('crypto');
const { getDb } = require('./db');

// 简单的密码哈希（生产环境应用bcrypt）
function hashPassword(password) {
  return crypto.createHash('sha256').update(password + 'special-equipment-salt').digest('hex');
}

// 验证密码
function verifyPassword(password, hash) {
  return hashPassword(password) === hash;
}

// 登录
function login(email, password) {
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user) return { success: false, error: '用户不存在' };
  if (!verifyPassword(password, user.password_hash)) return { success: false, error: '密码错误' };
  
  return {
    success: true,
    user: { id: user.id, email: user.email, name: user.name, role: user.role }
  };
}

// 鉴权中间件（支持 Authorization header、token query、ev3_tok cookie）
function authMiddleware(req, res, next) {
  const token = req.headers['authorization'] || req.query.token || (req.cookies && req.cookies['ev3_tok']);
  if (!token) return res.status(401).json({ error: '未登录，请先登录' });
  
  try {
    const decoded = Buffer.from(token, 'base64').toString('utf-8');
    const [email, timestamp] = decoded.split(':');
    const elapsed = Date.now() - parseInt(timestamp);
    
    // Token 24小时过期
    if (elapsed > 24 * 60 * 60 * 1000) {
      return res.status(401).json({ error: '登录已过期，请重新登录' });
    }
    
    const db = getDb();
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!user) return res.status(401).json({ error: '用户不存在' });
    
    req.user = { id: user.id, email: user.email, name: user.name, role: user.role };
    next();
  } catch (e) {
    return res.status(401).json({ error: '无效的登录凭证' });
  }
}

// 角色权限中间件
function roleMiddleware(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: '未登录' });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: '权限不足，需要角色：' + roles.join('/') });
    }
    next();
  };
}

// 生成Token
function generateToken(email) {
  const timestamp = Date.now();
  return Buffer.from(`${email}:${timestamp}`).toString('base64');
}

module.exports = { login, authMiddleware, roleMiddleware, generateToken, hashPassword };
