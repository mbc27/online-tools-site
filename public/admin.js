/* ================= 管理员逻辑（隐藏入口） =================
   入口：连续点击左上角标题 5 次 / Ctrl+Alt+A / URL 加 #admin
*/
(() => {
  const $ = s => document.querySelector(s);
  let token = localStorage.getItem('admin_token') || '';

  const loginMask = $('#adminLogin'), panel = $('#adminPanel');
  let tools = [];
  let editingId = null; // null=新增
  let adminKeyword = '';

  /* ---------- 隐藏入口 ---------- */
  let clickCount = 0, clickTimer = null;
  $('#logo').addEventListener('click', () => {
    clickCount++;
    clearTimeout(clickTimer);
    clickTimer = setTimeout(() => clickCount = 0, 2000);
    if (clickCount >= 5) { clickCount = 0; openLogin(); }
  });
  document.addEventListener('keydown', e => {
    if (e.ctrlKey && e.altKey && (e.key === 'a' || e.key === 'A')) openLogin();
  });
  if (location.hash === '#admin') openLogin();

  function openLogin() {
    if (token) { openPanel(); return; }
    loginMask.hidden = false;
    $('#adminUser').focus();
  }

  /* ---------- 登录 ---------- */
  async function doLogin() {
    const username = $('#adminUser').value.trim(), password = $('#adminPass').value;
    const r = await fetch('/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const d = await r.json();
    if (d.ok) {
      token = d.token;
      localStorage.setItem('admin_token', token);
      loginMask.hidden = true;
      $('#adminPass').value = ''; $('#loginErr').hidden = true;
      openPanel();
    } else {
      const err = $('#loginErr');
      err.textContent = d.msg || '登录失败';
      err.hidden = false;
    }
  }
  $('#loginBtn').onclick = doLogin;
  $('#adminPass').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
  $('#loginCancel').onclick = () => loginMask.hidden = true;

  function authHeaders() { return { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token }; }

  /* ---------- 管理面板 ---------- */
  function openPanel() { panel.hidden = false; loadTools(); loadSubs(); }
  $('#adminClose').onclick = () => panel.hidden = true;
  $('#adminLogout').onclick = () => {
    token = ''; localStorage.removeItem('admin_token');
    panel.hidden = true;
  };
  panel.addEventListener('click', e => { if (e.target === panel) panel.hidden = true; });

  // Tab 切换
  document.querySelectorAll('.tab').forEach(tab => {
    tab.onclick = () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      ['tools', 'subs', 'stats', 'contact', 'cats'].forEach(name => {
        const body = document.getElementById('tab-' + name);
        if (body) body.hidden = name !== tab.dataset.tab;
      });
      if (tab.dataset.tab === 'stats') loadStats();
      if (tab.dataset.tab === 'subs') loadSubs();
      if (tab.dataset.tab === 'cats') loadCats();
    };
  });

  /* ---------- 联系方式二维码 ---------- */
  const DEFAULT_ADJ = { fit: 'contain', zoom: 100, x: 0, y: 0 };
  function applyAdj(img, s) {
    img.style.objectFit = s.fit;
    img.style.transform = `translate(${s.x}%, ${s.y}%) scale(${s.zoom / 100})`;
  }
  function clearAdj(img) { img.style.objectFit = ''; img.style.transform = ''; }

  function bindQr(type, fileInputSel, pickBtnSel, delBtnSel, imgSel, adj) {
    const img = $(imgSel);
    function refresh() { img.src = '/api/qr?type=' + type + '&t=' + Date.now(); }
    img.onerror = () => { img.hidden = true; };
    img.onload = () => { img.hidden = false; };
    refresh();

    $(pickBtnSel).onclick = () => $(fileInputSel).click();
    $(fileInputSel).addEventListener('change', () => {
      const file = $(fileInputSel).files[0];
      if (!file) return;
      if (file.size > 3 * 1024 * 1024) { alert('图片不能超过 3MB'); return; }
      const reader = new FileReader();
      reader.onload = async () => {
        const r = await fetch('/api/qr', {
          method: 'POST', headers: authHeaders(),
          body: JSON.stringify({ type, data: reader.result })
        });
        const d = await r.json();
        if (r.status === 401) return sessionExpired();
        if (d.ok) refresh();
        else alert(d.msg || '上传失败');
      };
      reader.readAsDataURL(file);
      $(fileInputSel).value = '';
    });
    $(delBtnSel).onclick = async () => {
      const r = await fetch('/api/qr?type=' + type, { method: 'DELETE', headers: authHeaders() });
      if (r.status === 401) return sessionExpired();
      window.dispatchEvent(new Event('qr-config-changed'));
      refresh();
    };

    /* 显示区域实时调整 */
    const c = {
      fit: $(adj.fit), zoom: $(adj.zoom), zoomv: $(adj.zoomv),
      px: $(adj.px), py: $(adj.py), save: $(adj.save), reset: $(adj.reset)
    };
    const readCtrls = () => ({
      fit: c.fit.value, zoom: Number(c.zoom.value),
      x: Number(c.px.value), y: Number(c.py.value)
    });
    const setCtrls = s => {
      c.fit.value = s.fit; c.zoom.value = s.zoom;
      c.zoomv.textContent = s.zoom + '%';
      c.px.value = s.x; c.py.value = s.y;
    };
    const liveUpdate = () => {
      c.zoomv.textContent = c.zoom.value + '%';
      applyAdj(img, readCtrls());
    };
    [c.zoom, c.px, c.py].forEach(el => el.addEventListener('input', liveUpdate));
    c.fit.addEventListener('change', liveUpdate);

    c.save.onclick = async () => {
      c.save.disabled = true;
      const r = await fetch('/api/qr-config', {
        method: 'POST', headers: authHeaders(),
        body: JSON.stringify({ type, settings: readCtrls() })
      });
      c.save.disabled = false;
      if (r.status === 401) return sessionExpired();
      const d = await r.json();
      if (d.ok) {
        c.save.textContent = '已保存 ✓';
        setTimeout(() => c.save.textContent = '保存显示设置', 1500);
        window.dispatchEvent(new Event('qr-config-changed'));
      } else alert(d.msg || '保存失败');
    };
    c.reset.onclick = async () => {
      await fetch('/api/qr-config', {
        method: 'POST', headers: authHeaders(),
        body: JSON.stringify({ type, settings: null })
      });
      setCtrls(DEFAULT_ADJ);
      clearAdj(img);
      window.dispatchEvent(new Event('qr-config-changed'));
    };

    // 初始化：载入已保存的显示设置
    fetch('/api/qr-config').then(r => r.json()).then(cfg => {
      const s = cfg[type] || DEFAULT_ADJ;
      setCtrls(s);
      if (cfg[type]) applyAdj(img, s);
    }).catch(() => {});
  }
  bindQr('qq', '#fileQQ', '#pickQQ', '#delQQ', '#qrQQAdmin',
    { fit: '#fitQQ', zoom: '#zoomQQ', zoomv: '#zoomQQv', px: '#posxQQ', py: '#posyQQ', save: '#saveAdjQQ', reset: '#resetAdjQQ' });
  bindQr('wechat', '#fileWX', '#pickWX', '#delWX', '#qrWXAdmin',
    { fit: '#fitWX', zoom: '#zoomWX', zoomv: '#zoomWXv', px: '#posxWX', py: '#posyWX', save: '#saveAdjWX', reset: '#resetAdjWX' });

  /* ---------- 待审核 ---------- */
  async function loadSubs() {
    const r = await fetch('/api/submissions', { headers: authHeaders() });
    if (r.status === 401) return sessionExpired();
    const subs = await r.json();
    const pending = subs.filter(s => s.status === 'pending');
    const badge = $('#subsBadge');
    badge.hidden = pending.length === 0;
    badge.textContent = pending.length;

    $('#subsTbody').innerHTML = subs.map(s => {
      const isLink = s.type === 'link';
      return `<tr>
      <td><b>${esc(s.name)}</b></td>
      <td>${isLink ? '<span class="tag tag-free"><i></i>补充链接</span>' : '新工具'}</td>
      <td>${isLink ? '-' : esc(s.category || '未分类')}</td>
      <td class="desc" title="${esc(s.desc || '')}">${isLink ? '为该工具补充访问链接' : esc(s.desc || '-')}</td>
      <td class="url">${esc(s.url)}</td>
      <td>${new Date(s.createdAt).toLocaleString('zh-CN')}</td>
      <td class="actions">
        ${s.status === 'pending'
          ? `<button class="mini-btn ok" data-ok="${s.id}">通过</button>
             <button class="mini-btn danger" data-no="${s.id}">拒绝</button>`
          : `<button class="mini-btn" data-no="${s.id}">删除</button>`}
      </td>
    </tr>`;
    }).join('') || '<tr><td colspan="7" style="text-align:center;color:#999">暂无提交记录</td></tr>';

    $('#subsTbody').querySelectorAll('[data-ok]').forEach(b => b.onclick = async () => {
      b.disabled = true;
      const r2 = await fetch('/api/submissions/approve', {
        method: 'POST', headers: authHeaders(),
        body: JSON.stringify({ id: Number(b.dataset.ok) })
      });
      const d = await r2.json();
      if (r2.status === 401) return sessionExpired();
      if (d.ok) { loadSubs(); loadTools(); refreshFrontend(); }
      else alert(d.msg || '操作失败');
      b.disabled = false;
    });
    $('#subsTbody').querySelectorAll('[data-no]').forEach(b => b.onclick = async () => {
      if (!confirm('确定删除这条提交记录吗？')) return;
      const r2 = await fetch('/api/submissions?id=' + b.dataset.no, { method: 'DELETE', headers: authHeaders() });
      if (r2.status === 401) return sessionExpired();
      loadSubs();
    });
  }

  function sessionExpired() {
    alert('登录已过期，请重新登录');
    token = '';
    localStorage.removeItem('admin_token');
    panel.hidden = true;
  }
  function refreshFrontend() { window.dispatchEvent(new Event('tools-changed')); }

  /* ---------- 分类管理 ---------- */
  let cats = [];
  const catFormMask = $('#catFormMask');
  const catDelMask = $('#catDelMask');
  let renameFrom = '', delName = '', delCnt = 0;

  async function loadCats() {
    const r = await fetch('/api/categories', { headers: authHeaders() });
    if (r.status === 401) return sessionExpired();
    cats = await r.json();
    $('#catTbody').innerHTML = cats.map(c => `<tr>
      <td><b>${esc(c.name)}</b></td>
      <td>${c.count}</td>
      <td class="actions">
        <button class="mini-btn" data-rename="${esc(c.name)}">重命名</button>
        <button class="mini-btn danger" data-del="${esc(c.name)}" data-cnt="${c.count}">删除</button>
      </td>
    </tr>`).join('') || '<tr><td colspan="3" style="text-align:center;color:#999">暂无分类</td></tr>';

    $('#catTbody').querySelectorAll('[data-rename]').forEach(b => b.onclick = () => {
      renameFrom = b.dataset.rename;
      $('#cf_name').value = renameFrom;
      $('#cf_err').hidden = true;
      catFormMask.hidden = false;
      $('#cf_name').focus();
    });
    $('#catTbody').querySelectorAll('[data-del]').forEach(b => b.onclick = () => openCatDel(b.dataset.del, Number(b.dataset.cnt)));
  }

  let delArmTimer = null;
  function resetDelArm() {
    const btn = $('#cd_confirm');
    clearTimeout(delArmTimer);
    delete btn.dataset.armed;
    btn.textContent = '确认删除';
  }
  function openCatDel(name, cnt) {
    delName = name;
    delCnt = cnt;
    const hasCards = cnt > 0;
    $('#cd_tip').textContent = hasCards
      ? `「${name}」分类下有 ${cnt} 张卡片，请选择它们的去向：`
      : `确认删除空分类「${name}」吗？`;
    $('#cd_opts').hidden = !hasCards;
    $('#cd_err').hidden = true;
    // 目标分类下拉：未分类永远可选，排除被删分类自身
    const names = ['未分类', ...cats.map(c => c.name).filter(n => n !== name && n !== '未分类')];
    $('#cd_target').innerHTML = names.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join('');
    resetDelArm();
    catDelMask.hidden = false;
  }

  $('#addCatBtn').onclick = async () => {
    const name = $('#newCatName').value.trim();
    if (!name) { alert('请输入分类名称'); return; }
    const r = await fetch('/api/categories', {
      method: 'POST', headers: authHeaders(),
      body: JSON.stringify({ name })
    });
    if (r.status === 401) return sessionExpired();
    const d = await r.json();
    if (d.ok) {
      $('#newCatName').value = '';
      loadCats();
      refreshFrontend();
    } else alert(d.msg || '添加失败');
  };

  $('#cf_cancel').onclick = $('#cf_close').onclick = () => catFormMask.hidden = true;
  catFormMask.addEventListener('click', e => { if (e.target === catFormMask) catFormMask.hidden = true; });
  $('#cf_save').onclick = async () => {
    const to = $('#cf_name').value.trim();
    const err = $('#cf_err');
    if (!to) { err.textContent = '请输入新分类名称'; err.hidden = false; return; }
    const r = await fetch('/api/categories', {
      method: 'PUT', headers: authHeaders(),
      body: JSON.stringify({ from: renameFrom, to })
    });
    if (r.status === 401) return sessionExpired();
    const d = await r.json();
    if (d.ok) {
      catFormMask.hidden = true;
      loadCats(); loadTools(); refreshFrontend();
    } else {
      err.textContent = d.msg || '重命名失败';
      err.hidden = false;
    }
  };

  $('#cd_cancel').onclick = $('#cd_close').onclick = () => catDelMask.hidden = true;
  catDelMask.addEventListener('click', e => { if (e.target === catDelMask) catDelMask.hidden = true; });
  $('#cd_confirm').onclick = async () => {
    const btn = $('#cd_confirm');
    // 二次确认：第一次点击只进入待确认状态，4 秒内再点一次才真正删除
    if (!btn.dataset.armed) {
      btn.dataset.armed = '1';
      btn.textContent = '⚠ 确定要删除吗？再点一次';
      clearTimeout(delArmTimer);
      delArmTimer = setTimeout(resetDelArm, 4000);
      return;
    }
    resetDelArm();
    let qs = 'name=' + encodeURIComponent(delName);
    if (delCnt > 0) {
      const mode = document.querySelector('input[name="cd_mode"]:checked').value;
      qs += '&mode=' + mode;
      if (mode === 'migrate') qs += '&target=' + encodeURIComponent($('#cd_target').value);
    }
    const r = await fetch('/api/categories?' + qs, { method: 'DELETE', headers: authHeaders() });
    if (r.status === 401) return sessionExpired();
    const d = await r.json();
    if (d.ok) {
      catDelMask.hidden = true;
      loadCats(); loadTools(); refreshFrontend();
    } else {
      $('#cd_err').textContent = d.msg || '删除失败';
      $('#cd_err').hidden = false;
    }
  };

  /* ---------- 工具管理 ---------- */
  async function loadTools() {
    const r = await fetch('/api/tools');
    tools = await r.json();
    // 分类下拉选项：现有卡片分类 + 管理员预建的空分类
    let allCats = [...new Set(tools.map(t => t.category))];
    try {
      const cats = await (await fetch('/api/categories')).json();
      allCats = [...new Set([...allCats, ...cats.map(c => c.name)])];
    } catch (e) { /* 忽略 */ }
    $('#catOptions').innerHTML = allCats
      .map(c => `<option value="${esc(c)}">`).join('');
    renderToolTable();
  }

  function renderToolTable() {
    const list = tools.filter(t =>
      !adminKeyword || (t.name + t.category + t.desc).toLowerCase().includes(adminKeyword.toLowerCase()));
    $('#toolTbody').innerHTML = list.map(t => `<tr>
      <td>${t.id}</td>
      <td><b>${esc(t.name)}</b></td>
      <td>${esc(t.category)}</td>
      <td>${esc(t.tag || '-')}</td>
      <td class="desc" title="${esc(t.desc)}">${esc(t.desc || '')}</td>
      <td class="url">${esc(t.url || '-')}</td>
      <td class="actions">
        <button class="mini-btn" data-edit="${t.id}">编辑</button>
        <button class="mini-btn danger" data-del="${t.id}">删除</button>
      </td>
    </tr>`).join('') || '<tr><td colspan="7" style="text-align:center;color:#999">无匹配结果</td></tr>';

    $('#toolTbody').querySelectorAll('[data-edit]').forEach(b => b.onclick = () => openForm(Number(b.dataset.edit)));
    $('#toolTbody').querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
      const id = Number(b.dataset.del);
      const item = tools.find(t => t.id === id);
      if (!confirm(`确定删除「${item.name}」吗？`)) return;
      const r = await fetch('/api/tools?id=' + id, { method: 'DELETE', headers: authHeaders() });
      const d = await r.json();
      if (!d.ok && r.status === 401) { alert('登录已过期，请重新登录'); token=''; localStorage.removeItem('admin_token'); panel.hidden = true; return; }
      loadTools();
      refreshFrontend();
    });
  }

  $('#adminSearch').addEventListener('input', e => { adminKeyword = e.target.value.trim(); renderToolTable(); });
  $('#addToolBtn').onclick = () => openForm(null);

  function openForm(id) {
    editingId = id;
    const item = id ? tools.find(t => t.id === id) : {};
    $('#formTitle').textContent = id ? `编辑工具 #${id}` : '新增工具';
    $('#f_name').value = item.name || '';
    $('#f_category').value = item.category || '';
    $('#f_tag').value = item.tag || '';
    $('#f_desc').value = item.desc || '';
    $('#f_url').value = item.url || '';
    $('#formErr').hidden = true;
    $('#toolForm').hidden = false;
    $('#f_name').focus();
  }
  $('#formCancel').onclick = () => $('#toolForm').hidden = true;

  $('#formSave').onclick = async () => {
    const body = {
      id: editingId,
      name: $('#f_name').value.trim(),
      category: $('#f_category').value.trim() || '未分类',
      tag: $('#f_tag').value,
      desc: $('#f_desc').value.trim(),
      url: $('#f_url').value.trim()
    };
    if (!body.name) { const e = $('#formErr'); e.textContent = '名称不能为空'; e.hidden = false; return; }
    const r = await fetch('/api/tools', {
      method: editingId ? 'PUT' : 'POST',
      headers: authHeaders(),
      body: JSON.stringify(body)
    });
    const d = await r.json();
    if (!d.ok && r.status === 401) { alert('登录已过期，请重新登录'); token=''; localStorage.removeItem('admin_token'); panel.hidden = true; return; }
    $('#toolForm').hidden = true;
    loadTools();
    window.dispatchEvent(new Event('tools-changed')); // 通知前台刷新
  };

  /* ---------- 访问统计 ---------- */
  async function loadStats() {
    const r = await fetch('/api/stats', { headers: authHeaders() });
    if (r.status === 401) { alert('登录已过期，请重新登录'); token=''; localStorage.removeItem('admin_token'); panel.hidden = true; return; }
    const s = await r.json();
    const ips = s.ips || {};
    const today = new Date().toISOString().slice(0, 10);
    const cards = [
      ['总访问量', s.total || 0],
      ['独立 IP 数', Object.keys(ips).length],
      ['今日访问', (s.days || {})[today] || 0]
    ];
    $('#statCards').innerHTML = cards.map(([k, v]) =>
      `<div class="stat-card"><b>${v}</b><span>${k}</span></div>`).join('');

    // 近 14 天柱状图
    const days = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date(Date.now() - i * 864e5).toISOString().slice(0, 10);
      days.push([d.slice(5), (s.days || {})[d] || 0]);
    }
    const max = Math.max(1, ...days.map(x => x[1]));
    $('#chart').innerHTML = days.map(([d, n]) =>
      `<div class="bar" title="${d}: ${n} 次"><i style="height:${(n / max) * 100}%"></i><span>${n}</span><span>${d}</span></div>`).join('');

    // 最近访问
    $('#visitTbody').innerHTML = (s.recent || []).slice(0, 80).map(v => {
      const ua = (v.ua || '').replace(/\([^)]*\)/g, '').trim().slice(0, 40) || '-';
      const t = new Date(v.time).toLocaleString('zh-CN');
      return `<tr><td>${t}</td><td>${esc(v.ip)}</td><td>${esc(ua)}</td></tr>`;
    }).join('');
  }

  /* ---------- 工具变动后刷新前台 ----------
     前台 app.js 监听 tools-changed 事件做局部刷新，这里无需处理 */
})();
