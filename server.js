/**
 * 工具箱网站服务端（纯 Node.js，零依赖，无需数据库）
 * 数据保存在 ./data 目录下的 JSON 文件中
 * 启动：node server.js  访问：http://localhost:3000
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const TOOLS_FILE = path.join(DATA_DIR, 'tools.json');
const STATS_FILE = path.join(DATA_DIR, 'stats.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const SUBMISSIONS_FILE = path.join(DATA_DIR, 'submissions.json');
const QRCFG_FILE = path.join(DATA_DIR, 'qr-display.json');
const CATEGORIES_FILE = path.join(DATA_DIR, 'categories.json');
const PUBLIC_DIR = path.join(ROOT, 'public');

/* ---------------- 数据初始化 ---------------- */
function ensureData() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(TOOLS_FILE)) {
    let list = [];
    const src = path.join(ROOT, '清单.json');
    if (fs.existsSync(src)) {
      try { list = JSON.parse(fs.readFileSync(src, 'utf8')); } catch (e) { console.error('清单.json 解析失败', e); }
    }
    list = list.map((t, i) => Object.assign({ id: i + 1 }, t));
    fs.writeFileSync(TOOLS_FILE, JSON.stringify(list, null, 2), 'utf8');
  }
  if (!fs.existsSync(STATS_FILE)) {
    fs.writeFileSync(STATS_FILE, JSON.stringify({ total: 0, days: {}, ips: {}, clicks: {}, recent: [] }, null, 2), 'utf8');
  }
  if (!fs.existsSync(SUBMISSIONS_FILE)) {
    fs.writeFileSync(SUBMISSIONS_FILE, JSON.stringify([], null, 2), 'utf8');
  }
  if (!fs.existsSync(CATEGORIES_FILE)) {
    fs.writeFileSync(CATEGORIES_FILE, JSON.stringify([], null, 2), 'utf8');
  }
  if (!fs.existsSync(CONFIG_FILE)) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({ username: 'admin', password: 'admin123' }, null, 2), 'utf8');
  }
}
function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}
function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

/* ---------------- 管理员会话（内存中，重启失效） ---------------- */
const sessions = new Map(); // token -> expireTime
const SESSION_TTL = 2 * 60 * 60 * 1000; // 2小时
function createToken() {
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, Date.now() + SESSION_TTL);
  return token;
}
function isAuthed(req) {
  const h = req.headers['authorization'] || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!token || !sessions.has(token)) return false;
  if (Date.now() > sessions.get(token)) { sessions.delete(token); return false; }
  return true;
}

/* ---------------- 登录安全：加盐哈希 + 失败限速 ---------------- */
function hashPassword(pw) {
  const salt = crypto.randomBytes(8).toString('hex');
  const h = crypto.createHash('sha256').update(salt + pw).digest('hex');
  return `sha256:${salt}:${h}`;
}
function verifyPassword(pw, stored) {
  if (typeof stored !== 'string') return false;
  if (stored.startsWith('sha256:')) {
    const [, salt, h] = stored.split(':');
    return crypto.createHash('sha256').update(salt + pw).digest('hex') === h;
  }
  return pw === stored;   // 旧的明文格式：验证通过后自动升级为哈希
}
const loginFails = new Map();          // ip -> { count, until }
const FAIL_LIMIT = 5;                  // 连续失败 5 次
const FAIL_WINDOW = 10 * 60 * 1000;    // 封禁 10 分钟
function loginBlocked(ip) {
  const f = loginFails.get(ip);
  return !!f && f.count >= FAIL_LIMIT && Date.now() < f.until;
}
function recordLoginFail(ip) {
  const f = loginFails.get(ip) || { count: 0, until: 0 };
  if (f.count >= FAIL_LIMIT && Date.now() > f.until) {
    f.count = 0;   // 上一轮封禁已过期，重新计数
  }
  f.count++;
  if (f.count >= FAIL_LIMIT) f.until = Date.now() + FAIL_WINDOW;
  loginFails.set(ip, f);
}

/* ---------------- 访问统计 ---------------- */
function recordVisit(ip, ua) {
  const stats = readJSON(STATS_FILE, { total: 0, days: {}, ips: {}, recent: [] });
  const day = new Date().toISOString().slice(0, 10);
  stats.total++;
  stats.days[day] = (stats.days[day] || 0) + 1;
  if (!stats.ips[ip]) { stats.ips[ip] = { count: 0, first: new Date().toISOString() }; }
  stats.ips[ip].count++;
  stats.ips[ip].last = new Date().toISOString();
  stats.recent.unshift({ time: new Date().toISOString(), ip, ua: String(ua || '').slice(0, 200) });
  if (stats.recent.length > 300) stats.recent.length = 300;
  writeJSON(STATS_FILE, stats);
}

/* ---------------- HTTP 工具 ---------------- */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon'
};
function send(res, code, data, type) {
  const body = typeof data === 'string' ? data : JSON.stringify(data);
  res.writeHead(code, {
    'Content-Type': type || 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'   // 接口数据永不缓存，管理员更新后前台立即生效
  });
  res.end(body);
}
function getIP(req) {
  let ip = req.socket.remoteAddress || '';
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  if (ip === '::1' || ip === '127.0.0.1') ip = '127.0.0.1';
  return ip;
}
function readBody(req) {
  return new Promise(resolve => {
    let raw = '';
    req.on('data', c => { raw += c; if (raw.length > 6e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch (e) { resolve({}); } });
  });
}

/* ---------------- 请求处理 ---------------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = decodeURIComponent(url.pathname);

  /* --- API --- */
  if (pathname === '/api/me') {
    return send(res, 200, { ip: getIP(req) });
  }
  if (pathname === '/api/visit' && req.method === 'POST') {
    const body = await readBody(req);
    recordVisit(getIP(req), body.ua || req.headers['user-agent']);
    return send(res, 200, { ok: true });
  }
  if (pathname === '/api/tools' && req.method === 'GET') {
    return send(res, 200, readJSON(TOOLS_FILE, []));
  }
  // 前台概览：热门榜 + 底部统计数据（公开）
  if (pathname === '/api/overview' && req.method === 'GET') {
    const list = readJSON(TOOLS_FILE, []);
    const stats = readJSON(STATS_FILE, {});
    const clicks = stats.clicks || {};
    const today = new Date().toISOString().slice(0, 10);
    const sorted = list.slice().sort((a, b) => (clicks[b.id] || 0) - (clicks[a.id] || 0));
    const popular = sorted.slice(0, 10).map(t => ({
      id: t.id, name: t.name, category: t.category, url: t.url,
      tag: t.tag, desc: t.desc, clicks: clicks[t.id] || 0
    }));
    return send(res, 200, {
      total: stats.total || 0,
      today: (stats.days || {})[today] || 0,
      unique: Object.keys(stats.ips || {}).length,
      toolCount: list.length,
      popular
    });
  }
  // 工具点击计数（用于热门榜）
  if (pathname === '/api/click' && req.method === 'POST') {
    const body = await readBody(req);
    const id = Number(body.id);
    if (!id) return send(res, 400, { ok: false, msg: '缺少工具 id' });
    const stats = readJSON(STATS_FILE, { total: 0, days: {}, ips: {}, clicks: {}, recent: [] });
    stats.clicks = stats.clicks || {};
    stats.clicks[id] = (stats.clicks[id] || 0) + 1;
    writeJSON(STATS_FILE, stats);
    return send(res, 200, { ok: true, clicks: stats.clicks[id] });
  }
  // 用户为无链接工具补充网址（待审核）
  if (pathname === '/api/suggest-url' && req.method === 'POST') {
    const body = await readBody(req);
    const id = Number(body.id);
    let newUrl = String(body.url || '').trim();
    if (!id) return send(res, 400, { ok: false, msg: '缺少工具 id' });
    if (!newUrl) return send(res, 400, { ok: false, msg: '请填写网址' });
    if (!/^https?:\/\//i.test(newUrl)) newUrl = 'https://' + newUrl;
    if (!/^https?:\/\/[^\s.]+\.[^\s]+$/i.test(newUrl)) return send(res, 400, { ok: false, msg: '网址格式不正确' });
    const list = readJSON(TOOLS_FILE, []);
    const tool = list.find(t => t.id === id);
    if (!tool) return send(res, 404, { ok: false, msg: '工具不存在' });
    if (tool.url && /^https?:\/\//.test(tool.url)) return send(res, 400, { ok: false, msg: '该工具已有链接，无需补充' });
    const subs = readJSON(SUBMISSIONS_FILE, []);
    if (subs.some(s => s.type === 'link' && s.status === 'pending' && s.toolId === id)) {
      return send(res, 400, { ok: false, msg: '该工具的链接补充已在审核中，请耐心等待' });
    }
    const maxId = subs.reduce((m, s) => Math.max(m, s.id || 0), 0);
    subs.push({
      id: maxId + 1,
      type: 'link',
      toolId: id,
      name: tool.name,
      url: newUrl,
      ip: getIP(req),
      status: 'pending',
      createdAt: new Date().toISOString()
    });
    writeJSON(SUBMISSIONS_FILE, subs);
    return send(res, 200, { ok: true });
  }
  // 用户提交工具（待审核）
  if (pathname === '/api/submit' && req.method === 'POST') {
    const body = await readBody(req);
    const name = String(body.name || '').trim();
    let url = String(body.url || '').trim();
    if (!name || !url) return send(res, 400, { ok: false, msg: '工具名称和网址不能为空' });
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    if (!/^https?:\/\/[^\s.]+\.[^\s]+$/i.test(url)) return send(res, 400, { ok: false, msg: '网址格式不正确' });
    const subs = readJSON(SUBMISSIONS_FILE, []);
    if (subs.some(s => s.status === 'pending' && s.name === name)) {
      return send(res, 400, { ok: false, msg: '该工具已在待审核列表中，请耐心等待' });
    }
    const maxId = subs.reduce((m, s) => Math.max(m, s.id || 0), 0);
    subs.push({
      id: maxId + 1,
      name,
      url,
      category: String(body.category || '').trim() || '未分类',
      desc: String(body.desc || '').trim(),
      ip: getIP(req),
      status: 'pending',
      createdAt: new Date().toISOString()
    });
    writeJSON(SUBMISSIONS_FILE, subs);
    return send(res, 200, { ok: true });
  }
  if (pathname === '/api/login' && req.method === 'POST') {
    const ip = getIP(req);
    if (loginBlocked(ip)) {
      return send(res, 429, { ok: false, msg: '尝试次数过多，请 10 分钟后再试' });
    }
    const body = await readBody(req);
    const cfg = readJSON(CONFIG_FILE, {});
    if (body.username === cfg.username && verifyPassword(String(body.password || ''), cfg.password)) {
      // 明文密码在首次成功登录后自动升级为加盐哈希存储
      if (typeof cfg.password === 'string' && !cfg.password.startsWith('sha256:')) {
        cfg.password = hashPassword(cfg.password);
        writeJSON(CONFIG_FILE, cfg);
      }
      loginFails.delete(ip);
      return send(res, 200, { ok: true, token: createToken() });
    }
    recordLoginFail(ip);
    return send(res, 401, { ok: false, msg: '用户名或密码错误' });
  }

  // 站长联系方式二维码（公开读取）
  if (pathname === '/api/qr' && req.method === 'GET') {
    const type = url.searchParams.get('type');
    if (type !== 'qq' && type !== 'wechat') return send(res, 400, { ok: false, msg: 'type 无效' });
    const mimeByExt = { '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp' };
    for (const [ext, mime] of Object.entries(mimeByExt)) {
      const f = path.join(DATA_DIR, 'qr-' + type + ext);
      if (fs.existsSync(f)) {
        res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-cache' });
        return fs.createReadStream(f).pipe(res);
      }
    }
    return send(res, 404, { ok: false, msg: '未上传' });
  }
  // 二维码显示设置（公开读取）
  if (pathname === '/api/qr-config' && req.method === 'GET') {
    return send(res, 200, readJSON(QRCFG_FILE, {}));
  }
  // 分类列表（公开，含空分类）
  if (pathname === '/api/categories' && req.method === 'GET') {
    const list = readJSON(TOOLS_FILE, []);
    const map = new Map();
    list.forEach(t => map.set(t.category, (map.get(t.category) || 0) + 1));
    readJSON(CATEGORIES_FILE, []).forEach(c => { if (!map.has(c)) map.set(c, 0); });
    return send(res, 200, [...map.entries()].map(([name, count]) => ({ name, count })));
  }

  // 以下均为管理员接口
  if (pathname.startsWith('/api/')) {
    if (!isAuthed(req)) return send(res, 401, { ok: false, msg: '未登录或会话已过期' });

    if (pathname === '/api/stats' && req.method === 'GET') {
      return send(res, 200, readJSON(STATS_FILE, {}));
    }
    // 上传二维码 { type: 'qq'|'wechat', data: dataURL }
    if (pathname === '/api/qr' && req.method === 'POST') {
      const body = await readBody(req);
      const type = body.type;
      if (type !== 'qq' && type !== 'wechat') return send(res, 400, { ok: false, msg: 'type 无效' });
      const m = String(body.data || '').match(/^data:image\/(png|jpe?g|webp);base64,(.+)$/);
      if (!m) return send(res, 400, { ok: false, msg: '图片数据无效' });
      const buf = Buffer.from(m[2], 'base64');
      if (buf.length > 3 * 1024 * 1024) return send(res, 400, { ok: false, msg: '图片不能超过 3MB' });
      // 清掉旧格式文件，避免多份共存
      ['.png', '.jpg', '.webp'].forEach(ext => {
        const f = path.join(DATA_DIR, 'qr-' + type + ext);
        if (fs.existsSync(f)) fs.unlinkSync(f);
      });
      const ext = m[1] === 'png' ? '.png' : (m[1] === 'webp' ? '.webp' : '.jpg');
      fs.writeFileSync(path.join(DATA_DIR, 'qr-' + type + ext), buf);
      return send(res, 200, { ok: true });
    }
    // 清除二维码
    if (pathname === '/api/qr' && req.method === 'DELETE') {
      const type = url.searchParams.get('type');
      if (type !== 'qq' && type !== 'wechat') return send(res, 400, { ok: false, msg: 'type 无效' });
      ['.png', '.jpg', '.webp'].forEach(ext => {
        const f = path.join(DATA_DIR, 'qr-' + type + ext);
        if (fs.existsSync(f)) fs.unlinkSync(f);
      });
      const cfg = readJSON(QRCFG_FILE, {});
      delete cfg[type];
      writeJSON(QRCFG_FILE, cfg);
      return send(res, 200, { ok: true });
    }
    // 保存二维码显示设置 { type, settings: {fit,zoom,x,y} | null }
    if (pathname === '/api/qr-config' && req.method === 'POST') {
      const body = await readBody(req);
      const type = body.type;
      if (type !== 'qq' && type !== 'wechat') return send(res, 400, { ok: false, msg: 'type 无效' });
      const cfg = readJSON(QRCFG_FILE, {});
      if (!body.settings) {
        delete cfg[type];
        writeJSON(QRCFG_FILE, cfg);
        return send(res, 200, { ok: true });
      }
      const s = body.settings;
      const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Math.round(Number(v) || 0)));
      cfg[type] = {
        fit: ['contain', 'cover', 'fill'].includes(s.fit) ? s.fit : 'contain',
        zoom: clamp(s.zoom, 50, 200),
        x: clamp(s.x, -100, 100),
        y: clamp(s.y, -100, 100)
      };
      writeJSON(QRCFG_FILE, cfg);
      return send(res, 200, { ok: true, settings: cfg[type] });
    }
    // 待审核提交列表
    if (pathname === '/api/submissions' && req.method === 'GET') {
      const subs = readJSON(SUBMISSIONS_FILE, []);
      return send(res, 200, subs.slice().reverse());
    }
    // 审核通过：新工具 -> 加入工具库；补充链接 -> 更新对应工具
    if (pathname === '/api/submissions/approve' && req.method === 'POST') {
      const body = await readBody(req);
      const subs = readJSON(SUBMISSIONS_FILE, []);
      const sub = subs.find(s => s.id === Number(body.id));
      if (!sub) return send(res, 404, { ok: false, msg: '提交记录不存在' });
      const list = readJSON(TOOLS_FILE, []);
      if (sub.type === 'link') {
        const tool = list.find(t => t.id === sub.toolId);
        if (!tool) return send(res, 404, { ok: false, msg: '对应工具不存在' });
        tool.url = sub.url;
        writeJSON(TOOLS_FILE, list);
      } else {
        const maxId = list.reduce((m, t) => Math.max(m, t.id || 0), 0);
        const item = {
          id: maxId + 1,
          name: sub.name,
          category: sub.category || '未分类',
          tag: sub.tag || '🆓免费版',
          desc: sub.desc || '',
          url: sub.url
        };
        list.push(item);
        writeJSON(TOOLS_FILE, list);
      }
      sub.status = 'approved';
      sub.approvedAt = new Date().toISOString();
      writeJSON(SUBMISSIONS_FILE, subs);
      return send(res, 200, { ok: true });
    }
    // 拒绝 / 删除提交记录
    if (pathname === '/api/submissions' && req.method === 'DELETE') {
      const id = Number(url.searchParams.get('id'));
      let subs = readJSON(SUBMISSIONS_FILE, []);
      const before = subs.length;
      subs = subs.filter(s => s.id !== id);
      if (subs.length === before) return send(res, 404, { ok: false, msg: '记录不存在' });
      writeJSON(SUBMISSIONS_FILE, subs);
      return send(res, 200, { ok: true });
    }
    // 新增空分类
    if (pathname === '/api/categories' && req.method === 'POST') {
      const body = await readBody(req);
      const name = String(body.name || '').trim();
      if (!name) return send(res, 400, { ok: false, msg: '分类名不能为空' });
      if (name.length > 20) return send(res, 400, { ok: false, msg: '分类名不能超过 20 个字' });
      const list = readJSON(TOOLS_FILE, []);
      const extras = readJSON(CATEGORIES_FILE, []);
      if (list.some(t => t.category === name) || extras.includes(name)) {
        return send(res, 400, { ok: false, msg: '该分类已存在' });
      }
      extras.push(name);
      writeJSON(CATEGORIES_FILE, extras);
      return send(res, 200, { ok: true });
    }
    // 重命名分类（连同其下卡片）
    if (pathname === '/api/categories' && req.method === 'PUT') {
      const body = await readBody(req);
      const from = String(body.from || '').trim();
      const to = String(body.to || '').trim();
      if (!from || !to) return send(res, 400, { ok: false, msg: '参数不完整' });
      if (from === to) return send(res, 400, { ok: false, msg: '新名称与原名称相同' });
      const list = readJSON(TOOLS_FILE, []);
      const extras = readJSON(CATEGORIES_FILE, []);
      if (list.some(t => t.category === to) || extras.includes(to)) {
        return send(res, 400, { ok: false, msg: '目标分类名已存在' });
      }
      let changed = 0;
      list.forEach(t => { if (t.category === from) { t.category = to; changed++; } });
      writeJSON(TOOLS_FILE, list);
      const ei = extras.indexOf(from);
      if (ei > -1) { extras[ei] = to; writeJSON(CATEGORIES_FILE, extras); }
      return send(res, 200, { ok: true, changed });
    }
    // 删除分类：mode=migrate 将卡片迁移到 target；mode=purge 连同卡片一起删除
    if (pathname === '/api/categories' && req.method === 'DELETE') {
      const name = url.searchParams.get('name');
      const mode = url.searchParams.get('mode');
      const target = String(url.searchParams.get('target') || '').trim();
      if (!name) return send(res, 400, { ok: false, msg: '缺少分类名' });
      if (name === '未分类') return send(res, 400, { ok: false, msg: '「未分类」是兜底分类，不能删除' });
      const list = readJSON(TOOLS_FILE, []);
      const inCat = list.filter(t => t.category === name);
      if (inCat.length) {
        if (mode === 'migrate') {
          if (!target || target === name) return send(res, 400, { ok: false, msg: '请选择有效的目标分类' });
          list.forEach(t => { if (t.category === name) t.category = target; });
          writeJSON(TOOLS_FILE, list);
        } else if (mode === 'purge') {
          writeJSON(TOOLS_FILE, list.filter(t => t.category !== name));
        } else {
          return send(res, 400, { ok: false, msg: '请选择卡片处理方式' });
        }
      }
      writeJSON(CATEGORIES_FILE, readJSON(CATEGORIES_FILE, []).filter(c => c !== name));
      return send(res, 200, { ok: true, moved: inCat.length });
    }
    if (pathname === '/api/tools' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body.name) return send(res, 400, { ok: false, msg: '工具名称不能为空' });
      const list = readJSON(TOOLS_FILE, []);
      const maxId = list.reduce((m, t) => Math.max(m, t.id || 0), 0);
      const item = {
        id: maxId + 1,
        name: String(body.name).trim(),
        category: String(body.category || '未分类').trim(),
        tag: String(body.tag || '').trim(),
        desc: String(body.desc || '').trim(),
        url: String(body.url || '').trim()
      };
      list.push(item);
      writeJSON(TOOLS_FILE, list);
      return send(res, 200, { ok: true, item });
    }
    if (pathname === '/api/tools' && req.method === 'PUT') {
      const body = await readBody(req);
      const list = readJSON(TOOLS_FILE, []);
      const idx = list.findIndex(t => t.id === Number(body.id));
      if (idx === -1) return send(res, 404, { ok: false, msg: '工具不存在' });
      ['name', 'category', 'tag', 'desc', 'url'].forEach(k => {
        if (body[k] !== undefined) list[idx][k] = String(body[k]).trim();
      });
      writeJSON(TOOLS_FILE, list);
      return send(res, 200, { ok: true, item: list[idx] });
    }
    if (pathname === '/api/tools' && req.method === 'DELETE') {
      const id = Number(url.searchParams.get('id'));
      let list = readJSON(TOOLS_FILE, []);
      const before = list.length;
      list = list.filter(t => t.id !== id);
      if (list.length === before) return send(res, 404, { ok: false, msg: '工具不存在' });
      writeJSON(TOOLS_FILE, list);
      return send(res, 200, { ok: true });
    }
    return send(res, 404, { ok: false, msg: '接口不存在' });
  }

  /* --- 静态文件 --- */
  let file = pathname === '/' ? '/index.html' : pathname;
  const full = path.normalize(path.join(PUBLIC_DIR, file));
  if (!full.startsWith(PUBLIC_DIR)) return send(res, 403, 'Forbidden', 'text/plain');
  if (!fs.existsSync(full) || fs.statSync(full).isDirectory()) {
    return send(res, 404, '404 Not Found', 'text/plain; charset=utf-8');
  }
  const ext = path.extname(full).toLowerCase();
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(full).pipe(res);
});

ensureData();
server.listen(PORT, () => {
  console.log(`工具箱已启动: http://localhost:${PORT}`);
  console.log('管理员默认账号 admin / admin123（可在 data/config.json 修改）');
  console.log('隐藏入口：连续点击左上角标题 5 次，或按 Ctrl+Alt+A，或访问 #admin');
});
