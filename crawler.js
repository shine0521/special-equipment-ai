/**
 * 特种设备行业信息爬虫
 * 支持定时抓取 + 增量更新
 * 数据存入 research_tasks 表
 */

const https = require('https');
const http = require('http');
const { URL } = require('url');
const { getDb } = require('./db');

// 爬虫配置
const CRAWLER_CONFIG = {
  // 目标站点（需要用户提供登录凭证的网站需要先配置）
  targets: [
    {
      name: '市场监管总局',
      url: 'https://www.samr.gov.cn',
      type: 'government',
      selectors: ['.news-list a', '.article-list a', '.policy-list a'],
      articleSelector: '.article-content, .detail-content, .content',
      titleSelector: 'h1, .article-title, .title',
      listUrl: 'https://www.samr.gov.cn/tssps/',
      followSelectors: ['a[href*="tssps"]']
    },
    {
      name: '中国特种设备检测研究院',
      url: 'https://www.csei.org.cn',
      type: 'research',
      selectors: ['.news-list a', '.article-list a'],
      articleSelector: '.article-content, .detail-content',
      titleSelector: 'h1, .article-title',
      listUrl: 'https://www.csei.org.cn/news/',
      followSelectors: ['a[href*="csei"]']
    },
    {
      name: '国家标准化委员会',
      url: 'https://open.samr.gov.cn',
      type: 'standard',
      selectors: ['.standard-list a', '.norms-list a'],
      articleSelector: '.content, .detail',
      titleSelector: 'h1, h2',
      listUrl: 'https://open.samr.gov.cn/bzgk/',
      followSelectors: ['a[href*="bzgk"]']
    }
  ],
  // 爬取间隔（毫秒）
  intervalMs: 60 * 60 * 1000, // 1小时
  // 每次最多爬取文章数
  maxArticlesPerSite: 20,
  // 请求超时（毫秒）
  timeout: 15000,
  // User-Agent
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 SpecialEquipmentBot/1.0'
};

let crawlerInterval = null;

/**
 * 简单HTTP GET（支持HTTPS）
 */
function httpGet(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;
    const reqOptions = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: {
        'User-Agent': CRAWLER_CONFIG.userAgent,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        ...options.headers
      },
      timeout: CRAWLER_CONFIG.timeout
    };

    const req = lib.request(reqOptions, (res) => {
      // 处理重定向
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        const redirectUrl = new URL(res.headers.location, url).href;
        return httpGet(redirectUrl, options).then(resolve).catch(reject);
      }

      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode}`));
      }

      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });

    req.on('timeout', () => { req.destroy(); reject(new Error('请求超时')); });
    req.on('error', reject);
    req.end();
  });
}

/**
 * 从HTML中提取纯文本
 */
function extractText(html, selector) {
  const match = html.match(new RegExp(`<[^>]+${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^>]*>([\\s\\S]*?)</[^>]+>`, 'i'));
  return match ? match[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() : '';
}

/**
 * 从HTML中提取链接
 */
function extractLinks(html, baseUrl, selector) {
  const links = [];
  const base = new URL(baseUrl);
  const linkMatches = html.match(new RegExp(`<a[^>]+href=["']([^"']+)["']`, 'gi')) || [];

  for (const link of linkMatches) {
    const hrefMatch = link.match(/href=["']([^"']+)["']/);
    if (hrefMatch) {
      try {
        const absUrl = new URL(hrefMatch[1], baseUrl).href;
        // 过滤同域链接
        if (new URL(absUrl).hostname === base.hostname) {
          links.push(absUrl);
        }
      } catch (_) { /* 无效URL */ }
    }
  }
  return [...new Set(links)];
}

/**
 * 获取文章内容
 */
async function fetchArticle(url) {
  try {
    const html = await httpGet(url, { headers: { 'Accept': 'text/html,*/*' } });
    const titleMatch = html.match(/<h1[^>]*>([^<]+)<\/h1>/i) ||
                       html.match(/<title[^>]*>([^<]+)<\/title>/i);
    const contentMatch = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i) ||
                        html.match(/<div[^>]*(?:class|id)=["'][^"']*(?:content|article|detail|body)[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi);
    const content = contentMatch
      ? contentMatch.slice(0, 3).join('\n').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
      : '';

    const title = titleMatch ? titleMatch[1].replace(/\s+/g, ' ').trim() : '无标题';
    return { title, content: content.slice(0, 2000), url, success: true };
  } catch (err) {
    return { title: '', content: '', url, success: false, error: err.message };
  }
}

/**
 * 爬取单个目标站点
 */
async function crawlSite(target) {
  console.log(`[爬虫] 正在抓取: ${target.name} (${target.listUrl})`);
  const results = [];

  try {
    // 1. 获取列表页
    const listHtml = await httpGet(target.listUrl);

    // 2. 提取文章链接
    const articleLinks = [];
    const linkMatches = listHtml.match(/<a[^>]+href=["']([^"']+)["'][^>]*>([^<]*?(?:政策|通知|公告|标准|规范|检验|安全|电梯|特种设备)[^<]*?)<\/a>/gi) || [];

    for (const linkTag of linkMatches.slice(0, CRAWLER_CONFIG.maxArticlesPerSite)) {
      const hrefMatch = linkTag.match(/href=["']([^"']+)["']/);
      const textMatch = linkTag.match(/>([^<]+)</);
      if (hrefMatch) {
        try {
          const absUrl = new URL(hrefMatch[1], target.listUrl).href;
          const title = textMatch ? textMatch[1].trim() : absUrl;
          if (title && title.length > 5) {
            articleLinks.push({ url: absUrl, title });
          }
        } catch (_) { /* 无效URL */ }
      }
    }

    console.log(`[爬虫] ${target.name}: 发现 ${articleLinks.length} 篇相关文章`);

    // 3. 抓取文章内容（限制并发3个）
    const batchSize = 3;
    for (let i = 0; i < articleLinks.length; i += batchSize) {
      const batch = articleLinks.slice(i, i + batchSize);
      const batchResults = await Promise.all(batch.map(l => fetchArticle(l.url)));
      results.push(...batchResults.filter(r => r.success && r.content.length > 50));
    }

  } catch (err) {
    console.error(`[爬虫] ${target.name} 抓取失败:`, err.message);
  }

  return results;
}

/**
 * 保存到数据库（research_tasks表）
 */
function saveArticles(articles, siteName) {
  if (!articles || articles.length === 0) return 0;

  const db = getDb();
  let saved = 0;

  // 查重（根据url）
  const existing = new Set(
    (db.prepare('SELECT url FROM research_tasks WHERE url IS NOT NULL').all() || [])
      .map(r => r.url)
  );

  const stmt = db.prepare(`
    INSERT INTO research_tasks (task_type, title, content, source, url, created_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
  `);

  const insertMany = db.transaction((items) => {
    for (const item of items) {
      if (!existing.has(item.url)) {
        stmt.run('crawler', item.title, item.content, siteName, item.url);
        existing.add(item.url);
        saved++;
      }
    }
  });

  insertMany(articles);
  return saved;
}

/**
 * 全量爬取
 */
async function runCrawler() {
  console.log(`[爬虫] ========== ${new Date().toLocaleString('zh-CN')} 开始抓取 ==========`);
  let totalSaved = 0;
  let totalArticles = 0;

  for (const target of CRAWLER_CONFIG.targets) {
    const articles = await crawlSite(target);
    const saved = saveArticles(articles, target.name);
    totalArticles += articles.length;
    totalSaved += saved;
    console.log(`[爬虫] ${target.name}: 抓取${articles.length}篇, 新增${saved}篇`);
  }

  console.log(`[爬虫] ========== 完成! 共${totalArticles}篇, 新增${totalSaved}篇 ==========`);
  return { totalArticles, totalSaved };
}

/**
 * 启动定时爬虫
 */
function startCrawler() {
  if (crawlerInterval) {
    console.log('[爬虫] 已启动');
    return;
  }

  // 立即运行一次
  runCrawler().catch(console.error);

  // 设置定时任务
  crawlerInterval = setInterval(() => {
    runCrawler().catch(console.error);
  }, CRAWLER_CONFIG.intervalMs);

  console.log(`[爬虫] 定时任务已启动，每 ${CRAWLER_CONFIG.intervalMs / 60000} 分钟执行一次`);
}

/**
 * 停止定时爬虫
 */
function stopCrawler() {
  if (crawlerInterval) {
    clearInterval(crawlerInterval);
    crawlerInterval = null;
    console.log('[爬虫] 已停止');
  }
}

/**
 * 获取爬虫状态
 */
function getCrawlerStatus() {
  return {
    running: !!crawlerInterval,
    intervalMinutes: CRAWLER_CONFIG.intervalMs / 60000,
    targets: CRAWLER_CONFIG.targets.map(t => ({ name: t.name, url: t.listUrl, type: t.type }))
  };
}

/**
 * 手动触发一次爬取
 */
async function triggerCrawl() {
  return runCrawler();
}

module.exports = {
  startCrawler,
  stopCrawler,
  getCrawlerStatus,
  triggerCrawl,
  runCrawler,
  crawlSite,
  CRAWLER_CONFIG
};
