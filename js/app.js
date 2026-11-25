/**
 * 心晴手记 · 应用主逻辑 v1.1 (app.js)
 * 负责：页面导航、日记 CRUD、本地存储、情绪分析调用、大模型可选接入、
 *       情绪曲线/日历/分布/词云/周报可视化、情绪工具箱、主题切换、导入导出。
 */
(function () {
  'use strict';

  const STORAGE_KEY = 'mood_diary_entries_v1';
  const SETTINGS_KEY = 'mood_diary_settings_v1';
  const ACTIONS_KEY = 'mood_diary_actions_v1';
  const $ = (id) => document.getElementById(id);

  let entries = loadJSON(STORAGE_KEY, []);
  let settings = loadJSON(SETTINGS_KEY, {});
  let actions = loadJSON(ACTIONS_KEY, []);
  let currentMood = 3;
  let chartRange = 7;
  let lastResult = null;
  let editingId = null;          // 正在编辑的日记 id
  let promptIdx = 0;             // 写作引导问题索引
  let groundingStep = -1;        // 着陆练习当前步骤
  let breathTimer = null;        // 呼吸练习计时器

  const WRITING_PROMPTS = [
    '今天有没有一件让你嘴角上扬的小事？',
    '如果给今天的心情起个名字，它会叫什么？',
    '今天有哪一刻，你觉得自己做得还不错？',
    '有什么话是你一直想说、却没说出口的？',
    '最近身体有没有哪里在提醒你该休息了？',
  ];
  const BREATH_PHASES = [
    { name: '吸气', seconds: 4, scale: 1.28 },
    { name: '屏息', seconds: 7, scale: 1.28 },
    { name: '呼气', seconds: 8, scale: 0.82 },
  ];

  /* ============ 通用工具 ============ */
  function loadJSON(key, fallback) {
    try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
    catch (e) { return fallback; }
  }
  function saveJSON(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; }
    catch (e) { toast('存储空间不足，保存失败'); return false; }
  }
  function pad(n) { return String(n).padStart(2, '0'); }
  function dateKey(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
  function fmtDate(iso) {
    const d = new Date(iso);
    return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  let toastTimer;
  function toast(msg) {
    const el = $('toast'); el.textContent = msg; el.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
  }

  /* ============ 主题 ============ */
  function applyTheme() {
    const dark = settings.theme === 'dark';
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    $('themeToggle').textContent = dark ? '☀️' : '🌙';
    $('themeToggle').setAttribute('aria-label', dark ? '切换到浅色模式' : '切换到深色模式');
  }
  applyTheme();
  $('themeToggle').addEventListener('click', () => {
    settings = { ...settings, theme: settings.theme === 'dark' ? 'light' : 'dark' };
    saveJSON(SETTINGS_KEY, settings); applyTheme();
    toast(settings.theme === 'dark' ? '已切换到夜间模式 🌙' : '已切换到日间模式 ☀️');
  });

  /* ============ 导航 ============ */
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });
  function switchTab(name) {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    document.querySelectorAll('.page').forEach((p) => p.classList.toggle('active', p.id === `page-${name}`));
    if (name === 'insight') renderInsight();
    if (name === 'history') renderHistory();
    if (name === 'toolbox') renderToolbox();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  /* ============ 写日记 ============ */
  $('todayDate').textContent = new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
  $('promptText').textContent = WRITING_PROMPTS[0];
  $('promptBtn').addEventListener('click', () => {
    promptIdx = (promptIdx + 1) % WRITING_PROMPTS.length;
    $('promptText').textContent = WRITING_PROMPTS[promptIdx];
  });

  document.querySelectorAll('.mood-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.mood-btn').forEach((b) => { b.classList.remove('selected'); b.setAttribute('aria-checked', 'false'); });
      btn.classList.add('selected'); btn.setAttribute('aria-checked', 'true');
      currentMood = Number(btn.dataset.score);
    });
  });

  $('intensity').addEventListener('input', (e) => {
    const labels = ['', '很淡', '较轻', '中等', '较强', '强烈'];
    $('intensityLabel').textContent = `${labels[e.target.value]} · ${e.target.value}`;
  });
  $('diaryText').addEventListener('input', (e) => { $('charCount').textContent = `${e.target.value.length} 字`; });

  function resetComposer() {
    $('diaryText').value = ''; $('diaryTags').value = ''; $('anonymous').checked = false;
    $('charCount').textContent = '0 字';
    $('resultCard').classList.add('hidden');
    document.querySelector('.mood-btn[data-score="3"]').click();
    $('intensity').value = 3; $('intensityLabel').textContent = '中等 · 3';
    editingId = null; updateSaveBtn();
  }
  function updateSaveBtn() {
    $('saveBtn').textContent = editingId ? '💾 保存修改' : '🌳 交给树洞分析';
  }
  $('clearBtn').addEventListener('click', () => { resetComposer(); toast('已清空'); });
  $('saveBtn').addEventListener('click', saveDiary);

  async function saveDiary() {
    const text = $('diaryText').value.trim();
    if (text.length < 5) { toast('再多写几个字吧，至少 5 个字 :)'); $('diaryText').focus(); return; }

    const wasEditing = !!editingId;
    const btn = $('saveBtn');
    btn.disabled = true; btn.textContent = editingId ? '💾 保存中…' : '🌳 树洞正在读懂你…';

    let result = window.EmotionEngine.analyze(text, currentMood, Number($('intensity').value));

    // 可选：调用大模型 API
    if (settings.apiBase && settings.apiKey && settings.apiModel) {
      try {
        const res = await fetch(settings.apiBase, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${settings.apiKey}` },
          body: JSON.stringify({
            model: settings.apiModel,
            messages: window.EmotionEngine.buildLLMPrompt(text, currentMood, Number($('intensity').value), result),
            temperature: 0.8,
            max_tokens: 400,
          }),
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();
        const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
        if (content) { result.reply = content.trim(); result.method = 'llm'; }
      } catch (err) {
        console.warn('大模型调用失败，回退到本地引擎', err);
        toast('大模型连接失败，已用本地引擎分析');
      }
    }

    const analysis = {
      emotion: result.emotion, emoji: result.emoji, score: result.score,
      confidence: result.confidence, keywords: result.keywords,
      reply: result.reply, suggestions: result.suggestions, method: result.method,
    };
    const tags = $('diaryTags').value.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
    const anonymous = $('anonymous').checked;
    const intensity = Number($('intensity').value);
    let entry;

    if (editingId) {
      entry = entries.find((e) => e.id === editingId);
      if (entry) {
        Object.assign(entry, { text, mood: currentMood, intensity, tags, anonymous, analysis });
        entry.updatedAt = new Date().toISOString();
      }
      editingId = null;
    } else {
      entry = {
        id: Date.now() + '-' + Math.random().toString(36).slice(2, 7),
        createdAt: new Date().toISOString(),
        text, mood: currentMood, intensity, tags, anonymous, analysis,
      };
      entries.unshift(entry);
    }

    saveJSON(STORAGE_KEY, entries);
    renderResult(entry);
    $('resultCard').classList.remove('hidden');
    $('resultCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
    btn.disabled = false; updateSaveBtn();
    toast(wasEditing ? '已更新这篇日记 🌿' : '已保存到日记本 🌿');
  }

  function renderResult(entry) {
    const a = entry.analysis;
    $('resultEmotion').textContent = `${a.emoji} ${a.emotion}`;
    $('resultConfidence').textContent = `匹配度约 ${Math.round(a.confidence * 100)}%`;
    $('resultScore').textContent = `${a.score} / 5`;
    const diff = a.score - entry.mood;
    $('resultTrend').textContent = diff > 0 ? '文字比自评更晴朗' : diff < 0 ? '文字里藏着些情绪' : '与你的自评一致';
    $('resultKeywords').textContent = a.keywords.length ? a.keywords.join(' · ') : '暂无明显关键词';
    $('resultReply').textContent = a.reply;
    $('resultSuggestions').innerHTML = a.suggestions.map((s) => `
      <div class="suggest-item">
        <strong>${escapeHtml(s.t)}</strong>${escapeHtml(s.d)}
        <button class="link-btn add-action" data-title="${escapeHtml(s.t)}">＋ 加入行动清单</button>
      </div>`).join('');
    $('resultSuggestions').querySelectorAll('.add-action').forEach((b) => {
      b.addEventListener('click', () => addAction(b.dataset.title));
    });
    $('analysisMethod').textContent = a.method === 'llm' ? '大模型生成' : '本地情绪分析引擎';
    lastResult = entry;
  }

  $('copyBtn').addEventListener('click', async () => {
    if (!lastResult) return;
    const text = `【${fmtDate(lastResult.createdAt)} · ${lastResult.analysis.emoji} ${lastResult.analysis.emotion}】\n${lastResult.analysis.reply}\n\n小建议：\n` + lastResult.analysis.suggestions.map((s) => `· ${s.t}：${s.d}`).join('\n');
    try { await navigator.clipboard.writeText(text); toast('回应已复制'); }
    catch (e) { toast('复制失败，请手动选择文本'); }
  });
  $('viewHistoryBtn').addEventListener('click', () => switchTab('history'));

  /* ============ 情绪趋势 ============ */
  document.querySelectorAll('.seg-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.seg-btn').forEach((b) => b.classList.toggle('active', b === btn));
      chartRange = Number(btn.dataset.range);
      drawChart();
    });
  });

  function renderInsight() {
    drawChart(); drawCalendar(); drawStats(); drawDistribution(); drawWordCloud(); renderReport();
  }

  function drawChart() {
    const svg = $('moodChart');
    const W = 720, H = 260, padL = 42, padR = 16, padT = 18, padB = 32;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const days = [];
    for (let i = chartRange - 1; i >= 0; i--) {
      const d = new Date(today); d.setDate(d.getDate() - i);
      const key = dateKey(d);
      const dayEntries = entries.filter((e) => dateKey(new Date(e.createdAt)) === key);
      const avg = dayEntries.length ? dayEntries.reduce((s, e) => s + e.analysis.score, 0) / dayEntries.length : null;
      days.push({ key, label: `${d.getMonth() + 1}/${d.getDate()}`, avg, count: dayEntries.length });
    }

    const x = (i) => padL + (i * (W - padL - padR)) / Math.max(1, days.length - 1);
    const y = (v) => padT + ((5 - v) * (H - padT - padB)) / 4;

    let html = '';
    for (let v = 1; v <= 5; v++) {
      html += `<line x1="${padL}" y1="${y(v)}" x2="${W - padR}" y2="${y(v)}" stroke="var(--line)" stroke-width="1"/>`;
      html += `<text x="${padL - 12}" y="${y(v) + 4}" text-anchor="end" font-size="11" fill="var(--ink-faint)">${v}</text>`;
    }
    const step = chartRange > 10 ? 5 : 1;
    days.forEach((d, i) => {
      if (i % step === 0 || i === days.length - 1) {
        html += `<text x="${x(i)}" y="${H - 8}" text-anchor="middle" font-size="10" fill="var(--ink-faint)">${d.label}</text>`;
      }
    });

    const valid = days.map((d, i) => ({ ...d, i })).filter((d) => d.avg !== null);
    if (valid.length > 1) {
      const pts = valid.map((d) => `${x(d.i)},${y(d.avg)}`).join(' ');
      html += `<polyline points="${pts}" fill="none" stroke="var(--primary)" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>`;
      html += `<polygon points="${x(valid[0].i)},${H - padB} ${pts} ${x(valid[valid.length - 1].i)},${H - padB}" fill="rgba(229,139,115,0.08)"/>`;
    }
    valid.forEach((d) => {
      const meta = window.EmotionEngine.EMOTION_META;
      const dayEntry = entries.find((e) => dateKey(new Date(e.createdAt)) === d.key);
      const color = dayEntry && meta[dayEntry.analysis.emotion] ? meta[dayEntry.analysis.emotion].color : 'var(--primary)';
      html += `<circle cx="${x(d.i)}" cy="${y(d.avg)}" r="5" fill="var(--card)" stroke="${color}" stroke-width="2.5"><title>${d.label}：${d.avg.toFixed(1)} 分（${d.count} 篇）</title></circle>`;
    });
    if (!valid.length) {
      html += `<text x="${W / 2}" y="${H / 2}" text-anchor="middle" font-size="14" fill="var(--ink-faint)">还没有记录，先去写一篇日记吧 🌱</text>`;
    }
    svg.innerHTML = html;
  }

  function drawCalendar() {
    const box = $('calendar');
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const first = new Date(today); first.setDate(1); first.setMonth(first.getMonth() - 1);
    const start = new Date(first); start.setDate(1 - first.getDay());
    let html = ['日', '一', '二', '三', '四', '五', '六'].map((d) => `<div class="cal-cell cal-head">${d}</div>`).join('');

    for (let i = 0; i < 42; i++) {
      const d = new Date(start); d.setDate(start.getDate() + i);
      const key = dateKey(d);
      const dayEntries = entries.filter((e) => dateKey(new Date(e.createdAt)) === key);
      const isCurrentMonth = d.getMonth() === today.getMonth();
      const isToday = key === dateKey(today);
      if (!isCurrentMonth && i >= 35) break;
      let style = '', emoji = '';
      if (dayEntries.length) {
        const avg = dayEntries.reduce((s, e) => s + e.analysis.score, 0) / dayEntries.length;
        const bg = ['#e8eef5', '#e5edf2', '#f2ece3', '#f9e0d3', '#f7cfbb'][Math.max(0, Math.min(4, Math.round(avg) - 1))];
        style = `background:${bg};border-color:#e9d9cc;`;
        emoji = dayEntries[0].analysis.emoji;
      }
      html += `<div class="cal-cell ${dayEntries.length ? 'has-data' : ''}" style="${style}" title="${key}${dayEntries.length ? ' · ' + dayEntries.length + ' 篇' : ''}">
        <span class="cal-day">${d.getDate()}${isToday ? ' •' : ''}</span>
        ${emoji ? `<span class="cal-dot">${emoji}</span>` : ''}
      </div>`;
    }
    box.innerHTML = html;
  }

  function drawStats() {
    const days = new Set(entries.map((e) => dateKey(new Date(e.createdAt)))).size;
    const avg = entries.length ? (entries.reduce((s, e) => s + e.analysis.score, 0) / entries.length).toFixed(1) : '—';
    const counts = {};
    entries.forEach((e) => { counts[e.analysis.emotion] = (counts[e.analysis.emotion] || 0) + 1; });
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    const topText = top ? `${window.EmotionEngine.EMOTION_META[top[0]].emoji}${top[0]}` : '—';

    let streak = 0;
    const d = new Date(); d.setHours(0, 0, 0, 0);
    const keySet = new Set(entries.map((e) => dateKey(new Date(e.createdAt))));
    if (!keySet.has(dateKey(d))) d.setDate(d.getDate() - 1);
    while (keySet.has(dateKey(d))) { streak++; d.setDate(d.getDate() - 1); }

    $('statDays').textContent = days;
    $('statAvg').textContent = avg;
    $('statTop').textContent = topText;
    $('statStreak').textContent = streak;
  }

  function drawDistribution() {
    const meta = window.EmotionEngine.EMOTION_META;
    const counts = {};
    entries.forEach((e) => { counts[e.analysis.emotion] = (counts[e.analysis.emotion] || 0) + 1; });
    const total = entries.length;
    $('donutTotal').textContent = total;
    if (!total) {
      $('emotionDonut').style.background = 'var(--bg-soft)';
      $('donutLegend').innerHTML = '<p class="empty-inline">还没有数据，去写第一篇吧 🌱</p>';
      return;
    }
    let acc = 0; const segs = [];
    Object.entries(meta).forEach(([name, m]) => {
      const c = counts[name] || 0; if (!c) return;
      const from = (acc / total) * 100; acc += c;
      segs.push(`${m.color} ${from}% ${(acc / total) * 100}%`);
    });
    $('emotionDonut').style.background = `conic-gradient(${segs.join(',')})`;
    $('donutLegend').innerHTML = Object.entries(meta).map(([name, m]) => {
      const c = counts[name] || 0;
      return `<div class="legend-item"><span class="legend-dot" style="background:${m.color}"></span><span>${m.emoji} ${name}</span><strong>${c}</strong></div>`;
    }).join('');
  }

  function drawWordCloud() {
    const since = Date.now() - 30 * 86400000;
    const freq = {};
    entries.filter((e) => new Date(e.createdAt).getTime() >= since).forEach((e) => {
      window.EmotionEngine.extractKeywords(e.text, 10).forEach((w) => { freq[w] = (freq[w] || 0) + 1; });
    });
    const words = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 24);
    if (!words.length) {
      $('wordCloud').innerHTML = '<p class="empty-inline">记录满 30 天后，这里会长出你的词云 ☁️</p>';
      return;
    }
    const max = words[0][1], min = words[words.length - 1][1];
    const palette = ['#e58b73', '#d99b8e', '#8fb39c', '#a99bb5', '#8aa6c4', '#e0a35c'];
    $('wordCloud').innerHTML = words.map(([w, c], i) => {
      const size = 14 + Math.round(((c - min) / (max - min || 1)) * 16);
      return `<span class="cloud-word" style="font-size:${size}px;color:${palette[i % palette.length]}">${escapeHtml(w)}</span>`;
    }).join('');
  }

  function buildReportText() {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const recent = [], previous = [];
    entries.forEach((e) => {
      const d = new Date(e.createdAt); d.setHours(0, 0, 0, 0);
      const diff = Math.round((today - d) / 86400000);
      if (diff >= 0 && diff < 7) recent.push(e);
      else if (diff >= 7 && diff < 14) previous.push(e);
    });
    if (!recent.length) return '本周还没有记录。写下第一篇日记，下周就能收到属于你的心情简报 🌱';
    const avg = recent.reduce((s, e) => s + e.analysis.score, 0) / recent.length;
    const prevAvg = previous.length ? previous.reduce((s, e) => s + e.analysis.score, 0) / previous.length : null;
    const change = prevAvg === null ? '这是你开始记录后的第一份周报。'
      : avg - prevAvg >= 0.2 ? `比上周晴朗了 ${(avg - prevAvg).toFixed(1)} 分 🌤️`
      : avg - prevAvg <= -0.2 ? `比上周低了 ${Math.abs(avg - prevAvg).toFixed(1)} 分，记得照顾好自己 🫧`
      : '和上周基本持平，稳稳地过着。';
    const counts = {};
    recent.forEach((e) => { counts[e.analysis.emotion] = (counts[e.analysis.emotion] || 0) + 1; });
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    const freq = {};
    recent.forEach((e) => window.EmotionEngine.extractKeywords(e.text, 6).forEach((w) => { freq[w] = (freq[w] || 0) + 1; }));
    const words = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([w]) => w);
    const best = recent.slice().sort((a, b) => b.analysis.score - a.analysis.score)[0];
    const moodWord = avg >= 4 ? '整体明朗' : avg >= 3 ? '总体平稳' : '有些低落';
    const ending = avg < 3 ? '慢一点也没关系，树洞陪你。' : '保持这份感受生活的本领。';
    return `本周你记录了 ${recent.length} 篇日记，平均心情 ${avg.toFixed(1)} 分，${moodWord}。${change}\n最常出现的情绪是「${top[0]}」（${top[1]} 次）；写得最多的词是 ${words.length ? words.join('、') : '暂无'}。\n${fmtDate(best.createdAt).split(' ')[0]} 是本周最晴朗的一天（${best.analysis.score} 分）。${ending}`;
  }
  let reportText = '';
  function renderReport() {
    reportText = buildReportText();
    $('reportBody').textContent = reportText;
  }
  $('copyReportBtn').addEventListener('click', async () => {
    if (!reportText) renderReport();
    try { await navigator.clipboard.writeText(reportText); toast('简报已复制，可以贴到 notebook 里了'); }
    catch (e) { toast('复制失败，请手动选择文本'); }
  });

  /* ============ 日记本 ============ */
  $('searchInput').addEventListener('input', renderHistory);
  $('emotionFilter').addEventListener('change', renderHistory);

  function renderHistory() {
    const kw = $('searchInput').value.trim().toLowerCase();
    const emotion = $('emotionFilter').value;
    const list = entries.filter((e) =>
      (!emotion || e.analysis.emotion === emotion) &&
      (!kw || e.text.toLowerCase().includes(kw) || e.tags.join(',').toLowerCase().includes(kw) || e.analysis.emotion.includes(kw))
    );
    const box = $('entryList');
    $('historyEmpty').classList.toggle('hidden', entries.length > 0);
    box.innerHTML = list.length ? list.map((e) => {
      const a = e.analysis;
      const tagsHtml = e.tags.length ? `<div class="entry-tags">${e.tags.map((t) => `<span class="tag">#${escapeHtml(t)}</span>`).join('')}</div>` : '';
      return `<article class="entry-card" data-id="${e.id}">
        <div class="entry-top">
          <div class="entry-mood"><span class="emoji">${a.emoji}</span>${escapeHtml(a.emotion)} · ${a.score} 分${e.anonymous ? ' · 匿名' : ''}${e.updatedAt ? ' · 已修改' : ''}</div>
          <div class="entry-date">${fmtDate(e.createdAt)}</div>
        </div>
        ${tagsHtml}
        <div class="entry-text">${escapeHtml(e.text)}</div>
        <div class="entry-reply">🌳 ${escapeHtml(a.reply)}</div>
        <div class="entry-actions">
          <button class="link-btn" data-act="edit">编辑</button>
          <button class="link-btn" data-act="copy">复制</button>
          <button class="link-btn" data-act="delete">删除</button>
        </div>
      </article>`;
    }).join('') : '<p class="empty-inline">没有符合条件的日记，换个关键词或筛选试试。</p>';

    box.querySelectorAll('.entry-card').forEach((card) => {
      const entry = entries.find((e) => e.id === card.dataset.id);
      card.querySelectorAll('.link-btn').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const act = btn.dataset.act;
          if (act === 'delete') {
            if (!confirm('确定删除这篇日记吗？删除后无法恢复。')) return;
            entries = entries.filter((e) => e.id !== entry.id);
            saveJSON(STORAGE_KEY, entries); renderHistory(); toast('已删除');
          } else if (act === 'edit') {
            editingId = entry.id;
            $('diaryText').value = entry.text;
            $('diaryTags').value = entry.tags.join(', ');
            $('anonymous').checked = !!entry.anonymous;
            $('charCount').textContent = `${entry.text.length} 字`;
            currentMood = entry.mood;
            document.querySelectorAll('.mood-btn').forEach((b) => {
              const on = Number(b.dataset.score) === entry.mood;
              b.classList.toggle('selected', on); b.setAttribute('aria-checked', String(on));
            });
            $('intensity').value = entry.intensity;
            const labels = ['', '很淡', '较轻', '中等', '较强', '强烈'];
            $('intensityLabel').textContent = `${labels[entry.intensity]} · ${entry.intensity}`;
            updateSaveBtn(); switchTab('write');
            $('diaryText').scrollIntoView({ behavior: 'smooth', block: 'center' });
            toast('已载入这篇日记，修改后保存即可');
          } else {
            try { await navigator.clipboard.writeText(entry.text); toast('日记已复制'); }
            catch (err) { toast('复制失败'); }
          }
        });
      });
    });
  }
  $('goWriteBtn').addEventListener('click', () => switchTab('write'));

  /* ============ 情绪工具箱 ============ */
  function renderToolbox() { renderActions(); renderGrounding(); }

  function addAction(title) {
    actions.unshift({ id: Date.now() + '-' + Math.random().toString(36).slice(2, 6), date: dateKey(new Date()), text: title, done: false, from: 'diary' });
    saveJSON(ACTIONS_KEY, actions);
    renderActions();
    toast('已加入行动清单 🫧 在工具箱里可以找到它');
  }

  function renderActions() {
    const today = dateKey(new Date());
    const todays = actions.filter((a) => a.date === today);
    const done = todays.filter((a) => a.done).length;
    $('actionProgress').textContent = `今天 ${done} / ${todays.length} 完成`;
    $('progressFill').style.width = todays.length ? `${(done / todays.length) * 100}%` : '0%';
    if (!actions.length) {
      $('actionList').innerHTML = '<p class="empty-inline">还没有行动项。写篇日记，从建议里挑一件小事试试 🌱</p>';
      return;
    }
    $('actionList').innerHTML = actions.slice(0, 30).map((a) => `
      <div class="action-item ${a.done ? 'done' : ''}" data-id="${a.id}">
        <button class="action-check" aria-label="标记完成">${a.done ? '✓' : ''}</button>
        <div class="action-body">
          <div class="action-text">${escapeHtml(a.text)}</div>
          <div class="action-meta">${a.date === today ? '今天' : a.date}${a.from ? ' · 来自日记建议' : ''}</div>
        </div>
        <button class="link-btn action-del" aria-label="删除">✕</button>
      </div>`).join('');
    $('actionList').querySelectorAll('.action-item').forEach((row) => {
      const item = actions.find((a) => a.id === row.dataset.id);
      row.querySelector('.action-check').addEventListener('click', () => {
        item.done = !item.done; saveJSON(ACTIONS_KEY, actions); renderActions();
        if (item.done) toast('做得好，又照顾了自己一点 ✓');
      });
      row.querySelector('.action-del').addEventListener('click', () => {
        actions = actions.filter((a) => a.id !== item.id);
        saveJSON(ACTIONS_KEY, actions); renderActions(); toast('已移除');
      });
    });
  }

  function renderGrounding() {
    const steps = window.EmotionEngine.GROUNDING_STEPS;
    $('groundingSteps').innerHTML = steps.map((s, i) => {
      const state = i < groundingStep ? 'done' : i === groundingStep ? 'current' : '';
      return `<div class="ground-step ${state}">
        <span class="step-num">${s.n}</span>
        <div><strong>${s.n} 样 · ${s.sense}</strong><p>${i <= groundingStep ? escapeHtml(s.tip) : '点击「下一步」揭晓'}</p></div>
      </div>`;
    }).join('');
    $('groundingNextBtn').textContent = groundingStep >= 4 ? '完成练习 ✓' : '下一步 →';
  }
  $('groundingNextBtn').addEventListener('click', () => {
    if (groundingStep >= 4) { groundingStep = -1; toast('练习完成，欢迎回到此刻 🌿'); }
    else groundingStep++;
    renderGrounding();
  });
  $('groundingResetBtn').addEventListener('click', () => { groundingStep = -1; renderGrounding(); });

  $('newQuoteBtn').addEventListener('click', () => { $('calmQuoteText').textContent = window.EmotionEngine.pickCalmQuote(); });
  $('calmQuoteText').textContent = window.EmotionEngine.pickCalmQuote();

  function stopBreath(keepMessage) {
    if (breathTimer) { clearInterval(breathTimer); breathTimer = null; }
    $('breathStartBtn').disabled = false;
    $('breathStopBtn').disabled = true;
    $('breathCircle').style.transform = '';
    if (!keepMessage) { $('breathLabel').textContent = '准备好了吗？'; $('breathRound').textContent = '第 0 / 4 轮'; }
  }
  function runBreathPhase(round, phase, left) {
    const p = BREATH_PHASES[phase];
    $('breathLabel').textContent = `${p.name} ${left}`;
    $('breathCircle').style.transitionDuration = p.name === '屏息' ? '0.3s' : p.seconds + 's';
    $('breathCircle').style.transform = `scale(${p.scale})`;
    $('breathRound').textContent = `第 ${round + 1} / 4 轮 · ${p.name} ${p.seconds} 秒`;
    if (breathTimer) clearInterval(breathTimer);
    breathTimer = setInterval(() => {
      left--;
      if (left > 0) { $('breathLabel').textContent = `${p.name} ${left}`; return; }
      let nextPhase = phase + 1, nextRound = round;
      if (nextPhase >= BREATH_PHASES.length) { nextPhase = 0; nextRound++; }
      if (nextRound >= 4) { stopBreath(true); $('breathLabel').textContent = '完成啦 🌿'; $('breathRound').textContent = '第 4 / 4 轮 · 已完成'; toast('4 轮呼吸完成，慢慢睁开眼睛吧'); return; }
      runBreathPhase(nextRound, nextPhase, BREATH_PHASES[nextPhase].seconds);
    }, 1000);
  }
  $('breathStartBtn').addEventListener('click', () => {
    if (breathTimer) return;
    $('breathStartBtn').disabled = true; $('breathStopBtn').disabled = false;
    runBreathPhase(0, 0, 4);
  });
  $('breathStopBtn').addEventListener('click', () => stopBreath(false));

  /* ============ 导入导出 ============ */
  $('exportBtn').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(entries, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `心晴手记_日记备份_${dateKey(new Date())}.json`;
    a.click(); URL.revokeObjectURL(a.href);
    toast('已导出 JSON 备份');
  });
  $('importBtn').addEventListener('click', () => $('importFile').click());
  $('importFile').addEventListener('change', (e) => {
    const file = e.target.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        if (!Array.isArray(data)) throw new Error('格式错误');
        entries = data.concat(entries);
        saveJSON(STORAGE_KEY, entries); renderHistory(); toast(`成功导入 ${data.length} 篇日记`);
      } catch (err) { toast('导入失败：文件格式不正确'); }
      e.target.value = '';
    };
    reader.readAsText(file);
  });
  $('clearAllBtn').addEventListener('click', () => {
    if (!confirm('确定清空全部日记吗？此操作不可恢复！建议先导出备份。')) return;
    if (!confirm('再次确认：真的要删除全部记录吗？')) return;
    entries = []; saveJSON(STORAGE_KEY, entries);
    actions = []; saveJSON(ACTIONS_KEY, actions);
    editingId = null; updateSaveBtn();
    renderHistory(); renderActions(); toast('已清空全部日记');
  });

  /* ============ 设置 ============ */
  function fillSettings() {
    $('apiBase').value = settings.apiBase || '';
    $('apiKey').value = settings.apiKey || '';
    $('apiModel').value = settings.apiModel || '';
  }
  fillSettings();
  $('saveSettingsBtn').addEventListener('click', () => {
    settings = { ...settings, apiBase: $('apiBase').value.trim(), apiKey: $('apiKey').value.trim(), apiModel: $('apiModel').value.trim() };
    saveJSON(SETTINGS_KEY, settings);
    $('saveTip').textContent = '✓ 已保存';
    setTimeout(() => { $('saveTip').textContent = ''; }, 2000);
    toast('设置已保存');
  });
  $('clearSettingsBtn').addEventListener('click', () => {
    settings = { theme: settings.theme }; saveJSON(SETTINGS_KEY, settings); fillSettings(); applyTheme(); toast('已清除设置');
  });

  /* ============ 初始化 ============ */
  renderHistory();
  renderActions();
  renderGrounding();
})();
