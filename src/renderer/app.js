'use strict';

/* global Chart, I18N, api */
/* `api` is the global exposed by preload.js via contextBridge */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

const state = {
  lang: 'th',
  settings: null,
  view: 'dashboard',
  videos: [],
  sort: { key: 'create_time', dir: -1 },
  analytics: null,
  charts: {},
  file: null,
  creator: null,
  tags: [],
  videoTagFilter: '',
  postTagIds: [],
  ideaId: null
};

// ---------------- utils ----------------
const t = (k, vars) => {
  let s = (I18N[state.lang] && I18N[state.lang][k]) ?? I18N.en[k] ?? k;
  if (vars) for (const [a, b] of Object.entries(vars)) s = s.replace(`{${a}}`, b);
  return s;
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => {
  n = Number(n) || 0;
  const loc = state.lang === 'th' ? 'th-TH' : 'en-US';
  return Math.abs(n) >= 10000 ? new Intl.NumberFormat(loc, { notation: 'compact', maximumFractionDigits: 1 }).format(n)
    : new Intl.NumberFormat(loc, { maximumFractionDigits: 0 }).format(n);
};
const pct = (x) => `${((Number(x) || 0) * 100).toFixed(2)}%`;
const signed = (n) => (n > 0 ? `+${fmt(n)}` : fmt(n));
const locale = () => (state.lang === 'th' ? 'th-TH' : 'en-GB');
const fmtDate = (ms, withTime = true) => new Date(ms).toLocaleString(locale(), withTime
  ? { dateStyle: 'medium', timeStyle: 'short' } : { dateStyle: 'medium' });
const fmtDur = (s) => { s = Math.round(Number(s) || 0); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const fileUrl = (p) => 'file:///' + p.replace(/\\/g, '/').split('/')
  .map((seg, i) => (i === 0 && /^[A-Za-z]:$/.test(seg) ? seg : encodeURIComponent(seg))).join('/');

function toast(msg, isErr = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `toast show${isErr ? ' err' : ''}`;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.className = 'toast'; }, 3500);
}

async function call(fn, ...args) {
  const r = await fn(...args);
  if (!r.ok) {
    toast(`${t('error')}: ${r.error}${r.logId ? ` (log_id ${r.logId})` : ''}`, true);
    throw new Error(r.error);
  }
  return r.data;
}

// ---------------- i18n ----------------
function applyI18n() {
  document.documentElement.lang = state.lang;
  $$('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
  $$('[data-i18n-ph]').forEach((el) => { el.placeholder = t(el.dataset.i18nPh); });
  $$('#langSwitch button').forEach((b) => b.classList.toggle('active', b.dataset.lang === state.lang));
  renderLastSync();
}

async function setLang(lang) {
  state.lang = lang;
  await call(api.saveSettings, { lang });
  applyI18n();
  refreshView();
}

// ---------------- charts ----------------
Chart.defaults.color = '#8b93a7';
Chart.defaults.borderColor = '#2a2f3a';
Chart.defaults.font.family = getComputedStyle(document.documentElement).fontFamily;

function chart(id, config) {
  if (state.charts[id]) state.charts[id].destroy();
  state.charts[id] = new Chart(document.getElementById(id), {
    ...config,
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { intersect: false, mode: 'index' } },
      scales: { x: { grid: { display: false } }, y: { beginAtZero: config.type === 'bar' } },
      ...(config.options || {})
    }
  });
}

// ---------------- navigation ----------------
function go(view) {
  state.view = view;
  $$('#nav button').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${view}`));
  refreshView();
}

function refreshView() {
  const map = { dashboard: renderDashboard, videos: loadVideos, insights: renderInsights, scheduler: renderScheduler, settings: renderSettings, ...(window.GROWTH_VIEWS || {}) };
  (map[state.view] || (() => {}))().catch((e) => console.error(e));
}

// ---------------- header ----------------
function renderAccountChip() {
  const a = state.settings && state.settings.account;
  $('#accountChip').innerHTML = a && state.settings.loggedIn
    ? `<img src="${esc(a.avatar_url)}" alt=""><div><div>${esc(a.display_name)}</div><div class="muted small">@${esc(a.username || '')}</div></div>`
    : `<span class="muted">${esc(t('notLoggedIn'))}</span>`;
}
function renderLastSync() {
  const ls = state.settings && state.settings.lastSync;
  $('#lastSync').textContent = `${t('lastSync')}: ${ls ? fmtDate(ls) : t('never')}`;
}

async function loadSettings() {
  state.settings = await call(api.getSettings);
  state.lang = state.settings.lang;
  state.tags = await call(api.tags);
  $('#version').textContent = `v${state.settings.version}`;
  renderAccountChip();
  applyI18n();
}

// ---------------- dashboard ----------------
async function renderDashboard() {
  const loggedIn = state.settings && state.settings.loggedIn;
  $('#dashEmpty').classList.toggle('hidden', loggedIn);
  $('#dashBody').classList.toggle('hidden', !loggedIn);
  if (!loggedIn) return;

  const d = await call(api.dashboard);
  const a = d.account || {};
  const s = d.summary;
  const kpi = (label, value, delta) => `<div class="kpi"><div class="label">${esc(label)}</div>
    <div class="value">${value}</div>${delta !== undefined ? `<div class="delta ${delta > 0 ? 'pos' : delta < 0 ? 'neg' : 'muted'}">${signed(delta)}</div>` : ''}</div>`;
  $('#kpis').innerHTML = [
    kpi(t('followers'), fmt(a.follower_count)),
    kpi(t('followers7d'), signed(s.followers7d)),
    kpi(t('followers30d'), signed(s.followers30d)),
    kpi(t('likes'), fmt(a.likes_count)),
    kpi(t('videos'), fmt(a.video_count)),
    kpi(t('medianViews'), fmt(s.medianViews)),
    kpi(t('engagementRate'), pct(s.engagementRate)),
    d.goal ? `<div class="kpi clickable" data-goto="calendar"><div class="label">${esc(t('goalTitle'))}</div>
      <div class="value">${d.goal.postedThisWeek}<span class="muted small"> / ${d.goal.goal}</span></div>
      <div class="delta ${d.goal.streak ? 'pos' : 'muted'}">${esc(d.goal.streak ? t('streak', { n: d.goal.streak }) : t('goalRemaining', { n: d.goal.remaining }))}</div></div>` : ''
  ].join('');
  $$('#kpis [data-goto]').forEach((el) => el.addEventListener('click', () => go(el.dataset.goto)));
  const strip = $('#trendStrip');
  strip.classList.toggle('hidden', !d.trending.length);
  strip.innerHTML = d.trending.length ? `<b>🔥 ${esc(t('trendingNow'))}</b>` + d.trending.map((v) =>
    `<button class="trend-chip ${esc(v.level)}" data-vel="${esc(v.id)}"><span class="t">${esc(v.title || '—')}</span>
     <span class="r">${v.ratio.toFixed(1)}×</span></button>`).join('') : '';
  $$('#trendStrip [data-vel]').forEach((b) => b.addEventListener('click', () => { state.velSelected = b.dataset.vel; go('velocity'); }));

  const g = d.growth;
  $('#snapHint').classList.toggle('hidden', g.length >= 2);
  chart('chFollowers', {
    type: 'line',
    data: { labels: g.map((x) => x.date), datasets: [{ data: g.map((x) => x.followers), borderColor: '#25f4ee', backgroundColor: 'rgba(37,244,238,.08)', fill: true, tension: .3, pointRadius: g.length > 40 ? 0 : 3 }] }
  });
  chart('chDelta', {
    type: 'bar',
    data: { labels: g.slice(1).map((x) => x.date), datasets: [{ data: g.slice(1).map((x) => x.delta), backgroundColor: g.slice(1).map((x) => (x.delta >= 0 ? '#3ddc97' : '#fe2c55')), borderRadius: 3 }] }
  });

  $('#topList').innerHTML = d.top.map(videoCard).join('') || `<p class="muted">${esc(t('noVideos'))}</p>`;
  bindOpen($('#topList'));
}

function videoCard(v) {
  return `<div class="vcard" data-url="${esc(v.share_url)}">
    <img src="${esc(v.cover_image_url)}" alt="" loading="lazy">
    <div class="meta"><div class="t">${esc(v.title || '—')}</div>
    <div class="s">▶ ${fmt(v.view_count)} · ♥ ${fmt(v.like_count)} · ${pct(v.engagement)}</div></div></div>`;
}
function bindOpen(root) {
  $$('[data-url]', root).forEach((el) => el.addEventListener('click', () => {
    if (el.dataset.url) call(api.openUrl, el.dataset.url).catch(() => {});
  }));
}

// ---------------- videos ----------------
async function loadVideos() {
  state.videos = await call(api.videos);
  renderTagFilter();
  renderVideoTable();
}

function tagById(id) { return state.tags.find((x) => x.id === id); }
function tagChips(ids = []) {
  return ids.map(tagById).filter(Boolean)
    .map((x) => `<span class="tag ${esc(x.kind)}" ${x.color ? `style="--tc:${esc(x.color)}"` : ''}>${esc(x.name)}</span>`).join('');
}
function renderTagFilter() {
  const sel = $('#videoTagFilter');
  const opt = (kind) => state.tags.filter((x) => x.kind === kind).map((x) => `<option value="${x.id}">${esc(x.name)}</option>`).join('');
  sel.innerHTML = `<option value="">${esc(t('allTags'))}</option><option value="-1">${esc(t('untagged'))}</option>
    <optgroup label="${esc(t('pillars'))}">${opt('pillar')}</optgroup><optgroup label="${esc(t('formats'))}">${opt('format')}</optgroup>`;
  sel.value = state.videoTagFilter;
}
function renderVideoTable() {
  const q = $('#videoSearch').value.trim().toLowerCase();
  const { key, dir } = state.sort;
  const tf = Number(state.videoTagFilter);
  const rows = state.videos
    .filter((v) => !q || `${v.title} ${v.description}`.toLowerCase().includes(q))
    .filter((v) => !tf || (tf === -1 ? !v.tag_ids.length : v.tag_ids.includes(tf)))
    .sort((a, b) => {
      const x = a[key]; const y = b[key];
      return (typeof x === 'string' ? x.localeCompare(y) : (x || 0) - (y || 0)) * dir;
    });
  $$('#videoTable th[data-sort]').forEach((th) => {
    th.classList.toggle('sorted', th.dataset.sort === key);
    th.classList.toggle('asc', th.dataset.sort === key && dir === 1);
  });
  $('#videoTable tbody').innerHTML = rows.map((v) => `<tr data-url="${esc(v.share_url)}">
    <td><img src="${esc(v.cover_image_url)}" alt="" loading="lazy"></td>
    <td class="title" title="${esc(v.title)}">${esc(v.title || '—')}</td>
    <td>${v.create_time ? fmtDate(v.create_time * 1000) : ''}</td>
    <td class="num">${fmtDur(v.duration)}</td>
    <td class="num">${fmt(v.view_count)}</td><td class="num">${fmt(v.like_count)}</td>
    <td class="num">${fmt(v.comment_count)}</td><td class="num">${fmt(v.share_count)}</td>
    <td class="num">${pct(v.engagement)}</td>
    <td class="tags-cell"><div class="tag-row">${tagChips(v.tag_ids)}<button class="btn tiny ghost" data-tag-video="${esc(v.id)}">＋</button></div></td></tr>`).join('');
  $$('#videoTable [data-tag-video]').forEach((b) => b.addEventListener('click', (e) => {
    e.stopPropagation();
    openVideoTagEditor(b.dataset.tagVideo);
  }));
  $('#videoEmpty').classList.toggle('hidden', state.videos.length > 0);
  bindOpen($('#videoTable tbody'));
}

// ---------------- insights ----------------
function nextOccurrence(day, hour, after = Date.now() + 10 * 60 * 1000) {
  const d = new Date(after);
  d.setMinutes(0, 0, 0);
  for (let i = 0; i < 24 * 8; i++) {
    if (d.getTime() > after && d.getDay() === day && d.getHours() === hour) return d;
    d.setHours(d.getHours() + 1);
  }
  return null;
}

function suggestion() {
  const top = state.analytics && state.analytics.best.top.slice(0, 3);
  if (!top || !top.length) return null;
  return top.map((s) => nextOccurrence(s.day, s.hour)).filter(Boolean).sort((a, b) => a - b)[0] || null;
}

async function renderInsights() {
  const a = state.analytics = await call(api.analytics);
  const warn = $('#sampleWarn');
  warn.textContent = t('sampleWarn', { n: a.sampleSize });
  warn.classList.toggle('hidden', a.sampleSize >= 20);

  const maxScore = Math.max(1, ...a.best.top.map((x) => x.score));
  $('#bestList').innerHTML = a.best.top.map((s) => `<li><b>${esc(t('days')[s.day])} ${String(s.hour).padStart(2, '0')}:00–${String((s.hour + 1) % 24).padStart(2, '0')}:00</b>
      <span class="muted small"> · ${esc(t('score'))} ${s.score.toFixed(2)}× · ${s.n} ${esc(t('samples'))}</span>
      <div class="bar" style="width:${Math.round((s.score / maxScore) * 100)}%"></div></li>`).join('')
    || `<p class="muted">${esc(t('noVideos'))}</p>`;

  // heatmap
  let html = '<div></div>' + Array.from({ length: 24 }, (_, h) => `<div class="h">${h}</div>`).join('');
  a.best.heat.forEach((row, day) => {
    html += `<div class="d">${esc(t('daysShort')[day])}</div>`;
    row.forEach((c, hour) => {
      if (!c.n) { html += '<div class="c" title=""></div>'; return; }
      const k = Math.max(0, Math.min(1, (c.score - 0.5) / 1.5));
      const color = c.score >= 1 ? `rgba(254,44,85,${0.25 + k * 0.75})` : `rgba(37,244,238,${0.15 + (1 - c.score) * 0.4})`;
      html += `<div class="c" style="background:${color}" title="${esc(t('days')[day])} ${hour}:00 · ${c.score.toFixed(2)}× · n=${c.n}"></div>`;
    });
  });
  $('#heatmap').innerHTML = html;

  chart('chByDay', { type: 'bar', data: { labels: t('daysShort'), datasets: [{ data: a.rollup.byDay.map((x) => x.median), backgroundColor: '#fe2c55', borderRadius: 4 }] } });
  chart('chByHour', { type: 'bar', data: { labels: a.rollup.byHour.map((_, i) => `${i}`), datasets: [{ data: a.rollup.byHour.map((x) => x.median), backgroundColor: '#25f4ee', borderRadius: 3 }] } });
  chart('chDuration', {
    type: 'bar',
    data: { labels: a.duration.map((x) => `${x.bucket}${t('sec')} (${x.count})`), datasets: [{ data: a.duration.map((x) => x.medianViews), backgroundColor: '#7c6cff', borderRadius: 4 }] }
  });

  $('#tagTable tbody').innerHTML = a.hashtags.map((h) => `<tr><td>${esc(h.tag)}</td><td class="num">${h.count}</td>
    <td class="num">${fmt(h.medianViews)}</td><td class="num ${h.lift >= 1 ? 'pos' : 'neg'}">${h.lift.toFixed(2)}×</td></tr>`).join('');

  $('#erList').innerHTML = a.topEngagement.map((v) => `<div class="rank-item" data-url="${esc(v.share_url)}">
    <img src="${esc(v.cover_image_url)}" alt=""><div class="t">${esc(v.title || '—')}</div>
    <b>${pct(v.engagement)}</b><span class="muted small">${fmt(v.view_count)}</span></div>`).join('');
  bindOpen($('#erList'));
  if (window.renderGrowthInsights) window.renderGrowthInsights(a);
}

// ---------------- scheduler ----------------
const toLocalInput = (d) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

async function renderScheduler() {
  if (!state.analytics && state.settings.loggedIn) {
    try { state.analytics = (await api.analytics()).data; } catch { /* ignore */ }
  }
  const sug = suggestion();
  $('#suggestHint').textContent = sug ? `${t('suggested')}: ${fmtDate(sug.getTime())}` : '';
  $('#btnSuggest').disabled = !sug;
  if (!$('#schedAt').value) $('#schedAt').value = toLocalInput(sug || new Date(Date.now() + 15 * 60 * 1000));
  updateModeUi();
  renderPostTags();
  renderIdeaBanner();
  loadHashtagSuggestions();
  await renderQueue();
  if (state.settings.loggedIn && currentMode() === 'direct') loadCreator();
}

const currentMode = () => $('input[name=mode]:checked').value;

async function loadCreator() {
  const r = await api.creatorInfo();
  if (!r.ok) {
    state.creator = null;
    $('#creatorBox').innerHTML = `<span class="neg small">${esc(t('loadCreatorFail'))}: ${esc(r.error)}</span>`;
    return;
  }
  const c = state.creator = r.data;
  $('#creatorBox').innerHTML = `<img src="${esc(c.creator_avatar_url)}" alt=""><div><div class="muted small">${esc(t('postingAs'))}</div>
    <b>${esc(c.creator_nickname)}</b> <span class="muted">@${esc(c.creator_username)}</span></div>`;
  const sel = $('#privacy');
  const prev = sel.value;
  // No default selection — TikTok requires the user to choose explicitly.
  sel.innerHTML = `<option value="">${esc(t('choose'))}</option>` +
    (c.privacy_level_options || []).map((p) => `<option value="${esc(p)}">${esc(t(`privacy_${p}`))}</option>`).join('');
  if ((c.privacy_level_options || []).includes(prev)) sel.value = prev;
  const lock = (id, disabled) => {
    const el = $(id); el.disabled = disabled; if (disabled) el.checked = false;
    el.closest('label').classList.toggle('disabled', disabled);
  };
  lock('#allowComment', !!c.comment_disabled);
  lock('#allowDuet', !!c.duet_disabled);
  lock('#allowStitch', !!c.stitch_disabled);
  updateBrandUi();
}

function updateModeUi() {
  $('#directOpts').classList.toggle('hidden', currentMode() !== 'direct');
  updateBrandUi();
}

function updateBrandUi() {
  const on = $('#disclose').checked;
  $('#discloseOpts').classList.toggle('hidden', !on);
  if (!on) { $('#brandOrganic').checked = false; $('#brandContent').checked = false; }
  const branded = $('#brandContent').checked;
  // Branded content cannot be private
  const selfOnly = $('#privacy option[value=SELF_ONLY]');
  if (selfOnly) {
    selfOnly.disabled = branded;
    if (branded && $('#privacy').value === 'SELF_ONLY') { $('#privacy').value = ''; toast(t('brandedNoPrivate')); }
  }
  $('#consentLine').textContent = currentMode() === 'direct' ? (branded ? t('consentBrand') : t('consent')) : '';
}

function setFile(f) {
  state.file = f;
  $('#fileName').textContent = f ? `${f.name} · ${(f.size / 1048576).toFixed(1)} MB` : t('noFile');
  const v = $('#preview');
  if (!f) { v.classList.add('hidden'); v.removeAttribute('src'); return; }
  v.classList.remove('hidden');
  v.src = fileUrl(f.path);
  v.onloadedmetadata = () => {
    state.file.duration = v.duration;
    const max = state.creator && state.creator.max_video_post_duration_sec;
    $('#fileName').textContent += ` · ${fmtDur(v.duration)}`;
    if (max && v.duration > max) toast(`${fmtDur(v.duration)} > max ${fmtDur(max)}`, true);
  };
}

async function addPost() {
  if (!state.file) return toast(t('noFile'), true);
  const mode = currentMode();
  const at = new Date($('#schedAt').value).getTime();
  const payload = {
    filePath: state.file.path,
    durationSec: state.file.duration || null,
    title: $('#caption').value,
    mode,
    scheduledAt: Number.isFinite(at) ? Math.max(at, Date.now()) : Date.now(),
    tagIds: state.postTagIds,
    ideaId: state.ideaId
  };
  if (mode === 'direct') {
    if (!$('#privacy').value) return toast(t('whoCanView'), true);
    Object.assign(payload, {
      privacyLevel: $('#privacy').value,
      disableComment: !$('#allowComment').checked,
      disableDuet: !$('#allowDuet').checked,
      disableStitch: !$('#allowStitch').checked,
      brandOrganic: $('#disclose').checked && $('#brandOrganic').checked,
      brandContent: $('#disclose').checked && $('#brandContent').checked
    });
  }
  await call(api.createPost, payload);
  toast(t('added'));
  setFile(null);
  $('#caption').value = '';
  $('#capCount').textContent = '0';
  state.postTagIds = [];
  state.ideaId = null;
  renderPostTags();
  renderIdeaBanner();
  renderQueue();
}

async function renderQueue() {
  const posts = await call(api.posts);
  $('#queue').innerHTML = posts.map((p) => {
    const acts = [];
    if (p.status === 'pending') acts.push(`<button class="btn tiny" data-act="cancel" data-id="${p.id}">${esc(t('cancel'))}</button>`);
    if (['failed', 'cancelled'].includes(p.status)) acts.push(`<button class="btn tiny" data-act="retry" data-id="${p.id}">${esc(t('retry'))}</button>`);
    if (!['uploading', 'processing'].includes(p.status)) acts.push(`<button class="btn tiny danger" data-act="del" data-id="${p.id}">${esc(t('del'))}</button>`);
    const name = p.file_path.split(/[\\/]/).pop();
    return `<div class="qitem">
      <div><div class="t">${esc(p.title || name)}</div>
        <div class="m"><span class="badge ${esc(p.status)}">${esc(t(`status_${p.status}`))}</span>
        ${esc(fmtDate(p.scheduled_at))} · ${esc(p.mode === 'inbox' ? 'Inbox' : t(`privacy_${p.privacy_level}`))} · ${esc(name)}</div></div>
      <div class="actions">${acts.join('')}</div>
      ${p.status === 'uploading' ? `<div class="progress"><div style="width:${Math.round((p.progress || 0) * 100)}%"></div></div>` : ''}
      ${p.error ? `<div class="err">${esc(p.error)}</div>` : ''}
    </div>`;
  }).join('') || `<p class="muted">${esc(t('noQueue'))}</p>`;
}


function renderPostTags() {
  const box = $('#postTags');
  if (!state.tags.length) { box.innerHTML = `<span class="muted small">${esc(t('noTagsYet'))}</span>`; return; }
  box.innerHTML = ['pillar', 'format'].map((kind) => {
    const list = state.tags.filter((x) => x.kind === kind);
    if (!list.length) return '';
    return `<div class="tag-group"><span class="muted small">${esc(t(kind))}</span>${list.map((x) =>
      `<button type="button" class="tag pick ${esc(kind)} ${state.postTagIds.includes(x.id) ? 'on' : ''}" data-tid="${x.id}" ${x.color ? `style="--tc:${esc(x.color)}"` : ''}>${esc(x.name)}</button>`).join('')}</div>`;
  }).join('');
  $$('#postTags [data-tid]').forEach((b) => b.addEventListener('click', () => {
    const id = Number(b.dataset.tid);
    state.postTagIds = state.postTagIds.includes(id) ? state.postTagIds.filter((x) => x !== id) : [...state.postTagIds, id];
    renderPostTags();
    loadHashtagSuggestions();
  }));
}

async function loadHashtagSuggestions() {
  const box = $('#tagSuggest');
  if (!state.settings.loggedIn) { box.innerHTML = ''; return; }
  const pillar = state.postTagIds.map(tagById).find((x) => x && x.kind === 'pillar');
  const r = await api.suggestHashtags(pillar ? pillar.id : null);
  const list = r.ok ? r.data : [];
  const cap = $('#caption').value.toLowerCase();
  box.innerHTML = list.map((h) => `<button type="button" class="chip ${cap.includes(h.tag) ? 'used' : ''}" data-hashtag="${esc(h.tag)}"
      title="${esc(`${h.count}× · ${h.lift.toFixed(2)}×`)}">${esc(h.tag)} <span class="muted">${h.lift.toFixed(1)}×</span></button>`).join('');
  $$('#tagSuggest [data-hashtag]').forEach((b) => b.addEventListener('click', () => {
    const c = $('#caption');
    if (c.value.toLowerCase().includes(b.dataset.hashtag)) return;
    c.value = `${c.value.replace(/\s*$/, '')} ${b.dataset.hashtag}`.trimStart();
    $('#capCount').textContent = c.value.length;
    b.classList.add('used');
  }));
}

function renderIdeaBanner() {
  const el = $('#ideaBanner');
  if (!state.ideaId) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  el.innerHTML = `<span>💡 ${esc(t('fromIdea', { t: state.ideaTitle || '' }))}</span><button class="btn tiny ghost" id="unlinkIdea">${esc(t('unlink'))}</button>`;
  $('#unlinkIdea').addEventListener('click', () => { state.ideaId = null; renderIdeaBanner(); });
}

/** Called from the calendar / ideas pages to prefill the post form. */
function prefillPost({ caption, tagIds, ideaId, ideaTitle, at } = {}) {
  if (caption !== undefined) { $('#caption').value = caption; $('#capCount').textContent = caption.length; }
  if (tagIds) state.postTagIds = [...tagIds];
  state.ideaId = ideaId || null;
  state.ideaTitle = ideaTitle || '';
  if (at) $('#schedAt').value = toLocalInput(at);
  go('scheduler');
}

// ---------------- settings ----------------
async function renderSettings() {
  const s = state.settings = await call(api.getSettings);
  $('#setKey').value = s.clientKey;
  $('#setSecret').value = '';
  $('#setSecret').placeholder = s.hasSecret ? t('secretSaved') : '';
  $('#setPort').value = s.port;
  $('#redirUri').textContent = s.redirectUri;
  $('#scopeList').innerHTML = s.scopes.map((x) => `<span>${esc(x)}</span>`).join('');
  $('#setAutoSync').checked = s.autoSync;
  $('#setTray').checked = s.closeToTray;
  $('#setGoal').value = s.postsPerWeek;
  const a = s.account;
  $('#accountBox').innerHTML = s.loggedIn && a
    ? `<img src="${esc(a.avatar_url)}" alt=""><div><b>${esc(a.display_name)}</b> <span class="muted">@${esc(a.username || '')}</span>
       <div class="muted small">${esc(t('connected'))} · ${fmt(a.follower_count)} ${esc(t('followers'))}</div></div>`
    : `<span class="muted">${esc(t('notLoggedIn'))}</span>`;
  $('#btnLogin').classList.toggle('hidden', s.loggedIn);
  $('#btnLogout').classList.toggle('hidden', !s.loggedIn);
  renderAccountChip();
}

// ---------------- events ----------------
function bind() {
  $$('#nav button').forEach((b) => b.addEventListener('click', () => go(b.dataset.view)));
  $$('[data-goto]').forEach((b) => b.addEventListener('click', () => go(b.dataset.goto)));
  $$('#langSwitch button').forEach((b) => b.addEventListener('click', () => setLang(b.dataset.lang)));

  $('#syncBtn').addEventListener('click', async () => {
    try { await call(api.sync); toast(t('syncOk')); } catch { /* toast shown */ }
  });

  $('#videoSearch').addEventListener('input', renderVideoTable);
  $$('#videoTable th[data-sort]').forEach((th) => th.addEventListener('click', () => {
    const k = th.dataset.sort;
    state.sort = { key: k, dir: state.sort.key === k ? -state.sort.dir : -1 };
    renderVideoTable();
  }));
  const exp = async (kind) => { const p = await call(api.exportCsv, kind); if (p) toast(`${t('exported')}: ${p}`); };
  $('#expVideos').addEventListener('click', () => exp('videos'));
  $('#expFollowers').addEventListener('click', () => exp('followers'));

  // scheduler
  $('#pickVideo').addEventListener('click', async () => { const f = await call(api.pickVideo); if (f) setFile(f); });
  const dz = $('#dropZone');
  dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('over'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('over'));
  dz.addEventListener('drop', (e) => {
    e.preventDefault(); dz.classList.remove('over');
    const f = e.dataTransfer.files[0];
    if (!f || !/\.(mp4|mov|webm)$/i.test(f.name)) return;
    setFile({ path: api.pathForFile(f), name: f.name, size: f.size });
  });
  $('#caption').addEventListener('input', (e) => { $('#capCount').textContent = e.target.value.length; });
  $$('input[name=mode]').forEach((r) => r.addEventListener('change', () => {
    updateModeUi();
    if (currentMode() === 'direct' && !state.creator && state.settings.loggedIn) loadCreator();
  }));
  $('#disclose').addEventListener('change', updateBrandUi);
  $('#brandContent').addEventListener('change', updateBrandUi);
  $('#brandOrganic').addEventListener('change', updateBrandUi);
  $('#btnNow').addEventListener('click', () => { $('#schedAt').value = toLocalInput(new Date()); });
  $('#btnSuggest').addEventListener('click', () => { const s = suggestion(); if (s) $('#schedAt').value = toLocalInput(s); });
  $('#addPost').addEventListener('click', () => addPost().catch(() => {}));
  $('#queue').addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-act]');
    if (!b) return;
    const id = Number(b.dataset.id);
    const fn = { cancel: api.cancelPost, retry: api.retryPost, del: api.deletePost }[b.dataset.act];
    await call(fn, id);
    renderQueue();
  });

  // settings
  $('#saveSettings').addEventListener('click', async () => {
    await call(api.saveSettings, {
      clientKey: $('#setKey').value, clientSecret: $('#setSecret').value, port: $('#setPort').value
    });
    toast(t('saved'));
    renderSettings();
  });
  $('#setAutoSync').addEventListener('change', (e) => call(api.saveSettings, { autoSync: e.target.checked }));
  $('#setTray').addEventListener('change', (e) => call(api.saveSettings, { closeToTray: e.target.checked }));
  $('#saveGoal').addEventListener('click', async () => { await call(api.saveSettings, { postsPerWeek: Number($('#setGoal').value) }); toast(t('saved')); });
  $('#videoTagFilter').addEventListener('change', (e) => { state.videoTagFilter = e.target.value; renderVideoTable(); });
  $('#manageTags').addEventListener('click', () => openTagManager());
  $('#caption').addEventListener('input', () => {
    const cap = $('#caption').value.toLowerCase();
    $$('#tagSuggest [data-hashtag]').forEach((b) => b.classList.toggle('used', cap.includes(b.dataset.hashtag)));
  });
  $('#copyRedir').addEventListener('click', () => { navigator.clipboard.writeText($('#redirUri').textContent); toast(t('copied')); });
  $('#btnLogin').addEventListener('click', async () => {
    $('#loginWait').classList.remove('hidden');
    $('#btnLogin').disabled = true;
    try {
      await call(api.login);
      toast(t('connected'));
      state.analytics = null;
      await loadSettings();
      renderSettings();
    } catch { /* toast shown */ } finally {
      $('#loginWait').classList.add('hidden');
      $('#btnLogin').disabled = false;
    }
  });
  $('#btnLogout').addEventListener('click', async () => {
    if (!confirm(t('confirmLogout'))) return;
    await call(api.logout);
    state.creator = null; state.analytics = null;
    await loadSettings();
    renderSettings();
  });

  // push events from main
  api.on('posts:updated', () => { if (state.view === 'scheduler') renderQueue(); });
  api.on('sync:state', async (s) => {
    $('#syncBtn').disabled = s.running;
    $('#syncBtn').textContent = s.running ? t('syncing') : t('syncNow');
    if (!s.running && s.ok) {
      state.analytics = null;
      await loadSettings();
      refreshView();
    }
  });
}

(async function init() {
  bind();
  await loadSettings();
  go('dashboard');
})();

// Hide broken/missing images (e.g. expired TikTok CDN cover URLs) without inline handlers (CSP).
document.addEventListener('error', (e) => {
  if (e.target && e.target.tagName === 'IMG') e.target.style.visibility = 'hidden';
}, true);
