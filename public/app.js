/* ================= 前台逻辑 ================= */
const LS = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch (e) { return d; } },
  set(k, v) { localStorage.setItem(k, JSON.stringify(v)); }
};

let tools = [];
let extraCats = [];   // 管理员预建的空分类
let curCat = '全部';
let keyword = '';
let favs = LS.get('toolbox_favs', []);       // 收藏的工具 id（本地保存）
const FAV_CAT = '⭐ 我的收藏';

const $ = s => document.querySelector(s);
const grid = $('#grid'), catList = $('#catList'), search = $('#search');

/* ---------- 用户自动登录（IP 作为用户名，数据仅存本地） ---------- */
async function autoLogin() {
  let user = LS.get('toolbox_user', null);
  try {
    const r = await fetch('/api/me');
    const d = await r.json();
    if (!user || user.ip !== d.ip) {
      user = { ip: d.ip, name: '游客-' + (d.ip === '127.0.0.1' ? '本机' : d.ip), loginAt: Date.now() };
      LS.set('toolbox_user', user);
    }
    // 每个会话上报一次访问
    if (!sessionStorage.getItem('toolbox_visited')) {
      sessionStorage.setItem('toolbox_visited', '1');
      fetch('/api/visit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ua: navigator.userAgent })
      }).catch(() => {});
    }
  } catch (e) { /* 服务不可用时静默降级 */ }
  const chip = $('#userChip');
  if (user) chip.textContent = user.name;
}

/* ---------- 标签 ---------- */
function tagClass(tag) {
  if (!tag) return 'tag-other';
  if (tag.includes('开源')) return 'tag-oss';
  if (tag.includes('试用') || tag.includes('个人免费')) return 'tag-trial';
  if (tag.includes('免费')) return 'tag-free';
  return 'tag-other';
}
// 去掉标签文字里的 emoji，只保留文字（配合小圆点显示）
function tagText(tag) {
  return String(tag).replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2705}\u{FE0F}\u{2B50}]/gu, '').trim();
}

/* ---------- 渲染 ---------- */
function categories() {
  const map = new Map();
  tools.forEach(t => map.set(t.category, (map.get(t.category) || 0) + 1));
  extraCats.forEach(c => { if (!map.has(c)) map.set(c, 0); });
  return [...map.entries()].sort((a, b) => b[1] - a[1]);
}

function renderCats() {
  const cats = categories();
  const favCount = tools.filter(t => favs.includes(t.id)).length;
  let html = catItem('全部', tools.length) +
    (favCount ? catItem(FAV_CAT, favCount) : '') +
    cats.map(([c, n]) => catItem(c, n)).join('');
  catList.innerHTML = html;
  catList.querySelectorAll('.cat-item').forEach(el => {
    el.onclick = () => selectCat(el.dataset.cat);
  });
}
function catItem(name, cnt) {
  return `<div class="cat-item${name === curCat ? ' active' : ''}" data-cat="${name.replace(/"/g, '&quot;')}">
    <span>${name}</span><span class="cnt">${cnt}</span></div>`;
}

function selectCat(cat) {
  curCat = cat;
  renderCats();
  renderGrid();
  closeSidebarMobile();
  $('#curCat').textContent = cat;
}

function filtered() {
  const arr = tools.filter(t => {
    if (curCat === FAV_CAT && !favs.includes(t.id)) return false;
    if (curCat !== '全部' && curCat !== FAV_CAT && t.category !== curCat) return false;
    if (keyword) {
      const k = keyword.toLowerCase();
      return (t.name + t.desc + t.category + (t.tag || '')).toLowerCase().includes(k);
    }
    return true;
  });
  // 无链接的卡片排到末尾（保持原有相对顺序），链接补充后自动回到原位
  const linked = t => t.url && /^https?:\/\//.test(t.url) ? 0 : 1;
  return arr.slice().sort((a, b) => linked(a) - linked(b));
}

function renderGrid() {
  const list = filtered();
  $('#countInfo').textContent = `共 ${list.length} 个工具`;
  $('#empty').hidden = list.length > 0;
  grid.innerHTML = list.map(t => {
    const hasUrl = t.url && /^https?:\/\//.test(t.url);
    const fav = favs.includes(t.id);
    return `<article class="card ${hasUrl ? 'linked' : 'no-link'}" data-id="${t.id}"${hasUrl ? ` data-url="${esc(t.url)}"` : ''}>
      <button class="fav-btn${fav ? ' on' : ''}" title="收藏">★</button>
      <div class="card-top">
        <span class="card-name" title="${esc(t.name)}">${esc(t.name)}</span>
        ${t.tag ? `<span class="tag ${tagClass(t.tag)}" title="${esc(t.tag)}"><i></i>${esc(tagText(t.tag))}</span>` : ''}
      </div>
      <div class="card-cat">${esc(t.category)}</div>
      <div class="card-desc">${esc(t.desc || '')}</div>
      <div class="card-foot">
        ${hasUrl
          ? `<a class="card-link" href="${esc(t.url)}" target="_blank" rel="noopener noreferrer" title="打开 ${esc(t.name)}">打开 ↗</a>`
          : `<button class="link-add" title="推荐这个工具的网址">＋ 补充链接</button>`}
      </div>
    </article>`;
  }).join('');

  // 点击即计数（用于热门榜）
  grid.querySelectorAll('.card-link[href]').forEach(a => {
    a.addEventListener('click', () => {
      const id = Number(a.closest('.card').dataset.id);
      fetch('/api/click', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id })
      }).catch(() => {});
    });
  });

  // 整卡可点：点卡片任意位置打开链接（收藏按钮与链接本体除外）
  grid.querySelectorAll('.card.linked').forEach(card => {
    card.addEventListener('click', e => {
      if (e.target.closest('.fav-btn') || e.target.closest('a')) return;
      const url = card.dataset.url;
      if (!url) return;
      fetch('/api/click', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: Number(card.dataset.id) })
      }).catch(() => {});
      window.open(url, '_blank', 'noopener');
    });
  });

  // 无链接卡片：补充链接入口
  grid.querySelectorAll('.link-add').forEach(btn => {
    btn.onclick = e => {
      e.stopPropagation();
      const card = btn.closest('.card');
      openLinkModal(Number(card.dataset.id), card.querySelector('.card-name').textContent);
    };
  });

  grid.querySelectorAll('.fav-btn').forEach(btn => {
    btn.onclick = e => {
      e.stopPropagation();
      const id = Number(btn.closest('.card').dataset.id);
      favs = favs.includes(id) ? favs.filter(f => f !== id) : [...favs, id];
      LS.set('toolbox_favs', favs);
      renderCats(); renderGrid();
    };
  });
}
function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

/* ---------- 搜索实时过滤 ---------- */
search.addEventListener('input', () => {
  keyword = search.value.trim();
  if (keyword && curCat !== '全部') { curCat = '全部'; renderCats(); $('#curCat').textContent = '全部'; }
  renderGrid();
});

/* ---------- 侧边栏（移动端） ---------- */
function closeSidebarMobile() {
  $('#sidebar').classList.remove('open');
  $('#backdrop').classList.remove('show');
}
$('#hamburger').onclick = () => {
  $('#sidebar').classList.toggle('open');
  $('#backdrop').classList.toggle('show', $('#sidebar').classList.contains('open'));
};
$('#backdrop').onclick = closeSidebarMobile;

/* ---------- 概览：热门榜 + 底部统计 ---------- */
async function loadOverview() {
  try {
    const r = await fetch('/api/overview');
    const o = await r.json();
    renderFooter(o);
    renderPopular(o.popular || []);
  } catch (e) { /* 忽略 */ }
}

function renderFooter(o) {
  $('#footTotal').textContent = o.total ?? '-';
  $('#footToday').textContent = o.today ?? '-';
  $('#footTools').textContent = o.toolCount ?? '-';
  $('#footUnique').textContent = o.unique ?? '-';
}

function renderPopular(list) {
  const box = $('#popularBox');
  if (!list.length) { box.hidden = true; return; }
  box.hidden = false;
  $('#popularList').innerHTML = list.map((t, i) => {
    const hasUrl = t.url && /^https?:\/\//.test(t.url);
    const node = hasUrl ? 'a' : 'div';
    const attr = hasUrl ? ` href="${esc(t.url)}" target="_blank" rel="noopener noreferrer"` : '';
    return `<${node} class="pop-item"${attr} data-id="${t.id}">
      <span class="pop-rank">${String(i + 1).padStart(2, '0')}</span>
      <div class="pop-name">${esc(t.name)}</div>
      <div class="pop-desc">${esc(t.desc || t.category)}</div>
      <div class="pop-meta${t.clicks ? '' : ' na'}">${t.clicks ? t.clicks + ' 次访问' : '新收录'}</div>
    </${node}>`;
  }).join('');

  $('#popularList').querySelectorAll('a.pop-item').forEach(a => {
    a.addEventListener('click', () => {
      fetch('/api/click', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: Number(a.dataset.id) })
      }).catch(() => {});
    });
  });
}

/* ---------- 提示条 ---------- */
let toastTimer = null;
function toast(msg) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast'; el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

/* ---------- 用户提交工具 ---------- */
const submitMask = $('#submitMask');
function fillCatOptions() {
  const cats = [...new Set([...tools.map(t => t.category), ...extraCats])];
  $('#catOptions2').innerHTML = cats.map(c => `<option value="${esc(c)}">`).join('');
}

// 弹窗内标签页：在线提交 / 扫码联系
document.querySelectorAll('.sm-tab').forEach(tab => {
  tab.onclick = () => {
    document.querySelectorAll('.sm-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    $('#sm-form').hidden = tab.dataset.sm !== 'form';
    $('#sm-contact').hidden = tab.dataset.sm !== 'contact';
  };
});

// 二维码加载状态：两张都没有时显示兜底提示
const qrState = { qq: false, wechat: false };

/* ---------- 补充链接 ---------- */
const linkMask = $('#linkMask');
let linkToolId = 0;
function openLinkModal(id, name) {
  linkToolId = id;
  $('#l_name').textContent = name;
  $('#l_url').value = '';
  $('#l_err').hidden = true;
  linkMask.hidden = false;
  setTimeout(() => $('#l_url').focus(), 50);
}
$('#l_cancel').onclick = () => linkMask.hidden = true;
$('#l_close').onclick = () => linkMask.hidden = true;
linkMask.addEventListener('click', e => { if (e.target === linkMask) linkMask.hidden = true; });
$('#l_send').onclick = async () => {
  const url = $('#l_url').value.trim();
  const err = $('#l_err');
  if (!url) { err.textContent = '请填写网址'; err.hidden = false; return; }
  const btn = $('#l_send');
  btn.disabled = true; btn.textContent = '提交中…';
  try {
    const r = await fetch('/api/suggest-url', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: linkToolId, url })
    });
    const d = await r.json();
    if (d.ok) {
      linkMask.hidden = true;
      toast('已提交，等待站长审核');
    } else {
      err.textContent = d.msg || '提交失败，请稍后再试';
      err.hidden = false;
    }
  } catch (e) {
    err.textContent = '网络异常，请稍后再试';
    err.hidden = false;
  }
  btn.disabled = false; btn.textContent = '提交审核';
};

/* 二维码显示设置（管理端可实时调整） */
let qrCfg = {};
function applyQrCfg() {
  [['#qrQQ', 'qq'], ['#qrWX', 'wechat']].forEach(([sel, key]) => {
    const img = $(sel);
    if (!img) return;
    const s = qrCfg[key];
    if (s) {
      img.style.objectFit = s.fit;
      img.style.transform = `translate(${s.x}%, ${s.y}%) scale(${s.zoom / 100})`;
    } else {
      img.style.objectFit = '';
      img.style.transform = '';
    }
  });
}
async function loadQrConfig() {
  try {
    qrCfg = await (await fetch('/api/qr-config')).json();
    applyQrCfg();
  } catch (e) { /* 忽略 */ }
}
window.addEventListener('qr-config-changed', loadQrConfig);
loadQrConfig();

function qrCheck() { $('#qrEmpty').hidden = qrState.qq || qrState.wechat; }
[['#qrQQ', '#qrCardQQ', 'qq'], ['#qrWX', '#qrCardWX', 'wechat']].forEach(([imgSel, cardSel, key]) => {
  const img = $(imgSel), card = $(cardSel);
  const update = () => {
    const ok = img.complete && img.naturalWidth > 0;
    card.classList.toggle('missing', !ok);
    qrState[key] = ok;
    qrCheck();
  };
  img.onload = update;
  img.onerror = update;
  // 图片可能在脚本执行前就已加载失败，这里补一次判断并重试
  if (img.complete) {
    update();
    if (!img.naturalWidth) img.src = '/api/qr?type=' + key + '&t=' + Date.now();
  }
});

$('#openSubmit').onclick = () => {
  fillCatOptions();
  submitMask.hidden = false;
  $('#s_err').hidden = true;
  $('#s_name').focus();
  closeSidebarMobile();
  // 每次打开都重新拉取二维码（绕过缓存），站长上传后无需重启服务
  [['#qrQQ', 'qq'], ['#qrWX', 'wechat']].forEach(([sel, key]) => {
    const img = $(sel);
    if (img) img.src = '/api/qr?type=' + key + '&t=' + Date.now();
  });
};
$('#s_cancel').onclick = () => submitMask.hidden = true;
$('#s_close').onclick = () => submitMask.hidden = true;
submitMask.addEventListener('click', e => { if (e.target === submitMask) submitMask.hidden = true; });

$('#s_send').onclick = async () => {
  const body = {
    name: $('#s_name').value.trim(),
    url: $('#s_url').value.trim(),
    category: $('#s_category').value.trim(),
    desc: $('#s_desc').value.trim()
  };
  const err = $('#s_err');
  if (!body.name || !body.url) {
    err.textContent = '工具名称和网址都必须填写';
    err.hidden = false;
    return;
  }
  const btn = $('#s_send');
  btn.disabled = true; btn.textContent = '提交中…';
  try {
    const r = await fetch('/api/submit', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const d = await r.json();
    if (d.ok) {
      submitMask.hidden = true;
      ['#s_name', '#s_url', '#s_category', '#s_desc'].forEach(s => $(s).value = '');
      toast('提交成功，等待管理员审核');
    } else {
      err.textContent = d.msg || '提交失败，请稍后再试';
      err.hidden = false;
    }
  } catch (e) {
    err.textContent = '网络异常，请稍后再试';
    err.hidden = false;
  }
  btn.disabled = false; btn.textContent = '提交审核';
};

/* ---------- 加载工具 ---------- */
async function loadToolsData() {
  try {
    const r = await fetch('/api/tools');
    tools = await r.json();
  } catch (e) { /* 保留旧数据 */ }
  try {
    extraCats = (await (await fetch('/api/categories')).json()).map(c => c.name);
  } catch (e) { extraCats = []; }
  renderCats();
  renderGrid();
}

/* 管理端新增/审核后局部刷新 */
window.addEventListener('tools-changed', () => {
  loadToolsData();
  loadOverview();
});

/* ---------- 卡片悬停提示（跟随鼠标小手下方） ---------- */
const cardTip = $('#cardTip');
let tipCard = null;
grid.addEventListener('mousemove', e => {
  const card = e.target.closest('.card');
  if (card !== tipCard) {
    tipCard = card;
    if (!card) { cardTip.hidden = true; return; }
    const name = card.querySelector('.card-name');
    const cat = card.querySelector('.card-cat');
    const desc = card.querySelector('.card-desc');
    const tag = card.querySelector('.tag');
    cardTip.innerHTML =
      `<b>${esc(name ? name.textContent : '')}</b>` +
      `<span>${esc(cat ? cat.textContent : '')}${tag ? ' · ' + esc(tag.title || tag.textContent) : ''}</span>` +
      (desc && desc.textContent ? `<p>${esc(desc.textContent)}</p>` : '');
    cardTip.hidden = false;
  }
  const pad = 14;
  let x = e.clientX + pad;
  let y = e.clientY + 22;   // 显示在鼠标小手下方
  const r = cardTip.getBoundingClientRect();
  if (x + r.width > innerWidth - 8) x = e.clientX - r.width - pad;
  if (y + r.height > innerHeight - 8) y = e.clientY - r.height - 12;
  cardTip.style.left = x + 'px';
  cardTip.style.top = y + 'px';
});
grid.addEventListener('mouseleave', () => { cardTip.hidden = true; tipCard = null; });

/* ---------- 初始化 ---------- */
autoLogin();
loadToolsData();
loadOverview();
