'use strict';

/* global api, state, t, esc, fmt, pct, fmtDate, call, toast, chart, go, $, $$, tagById, tagChips,
   renderVideoTable, renderTagFilter, prefillPost, bindOpen, nextOccurrence */

// Growth features UI: early velocity, calendar & goals, idea bank, tags, attribution.

const TAG_COLORS = ['#fe2c55', '#25f4ee', '#7c6cff', '#ffb547', '#3ddc97', '#ff7ab6', '#4aa8ff', '#c7d36f'];
const DAY_MS = 86400000;
const pad2 = (n) => String(n).padStart(2, '0');
const dayKey = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const ageLabel = (h) => (h < 48 ? t('ageH', { h: h < 10 ? h.toFixed(1) : Math.round(h) }) : t('ageD', { d: (h / 24).toFixed(1) }));

// ---------------- modal ----------------
function openModal(html, bindFn) {
  $('#modalBox').innerHTML = html;
  $('#modal').classList.remove('hidden');
  $$('#modalBox [data-close]').forEach((b) => b.addEventListener('click', closeModal));
  if (bindFn) bindFn($('#modalBox'));
  const first = $('#modalBox input, #modalBox textarea');
  if (first) first.focus();
}
function closeModal() {
  $('#modal').classList.add('hidden');
  $('#modalBox').innerHTML = '';
}
$('#modal').addEventListener('mousedown', (e) => { if (e.target.id === 'modal') closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#modal').classList.contains('hidden')) closeModal(); });

async function reloadTags() {
  state.tags = await call(api.tags);
}

function tagPicker(selected, name = 'tp') {
  if (!state.tags.length) return `<span class="muted small">${esc(t('noTagsYet'))}</span>`;
  return ['pillar', 'format'].map((kind) => {
    const list = state.tags.filter((x) => x.kind === kind);
    if (!list.length) return '';
    return `<div class="tag-group"><span class="muted small">${esc(t(kind))}</span>${list.map((x) =>
      `<label class="tag pick ${esc(kind)} ${selected.includes(x.id) ? 'on' : ''}" ${x.color ? `style="--tc:${esc(x.color)}"` : ''}>
        <input type="checkbox" name="${name}" value="${x.id}" ${selected.includes(x.id) ? 'checked' : ''} hidden>${esc(x.name)}</label>`).join('')}</div>`;
  }).join('');
}
function bindTagPicker(root, name = 'tp') {
  $$(`input[name=${name}]`, root).forEach((i) => i.addEventListener('change', () => i.closest('label').classList.toggle('on', i.checked)));
}
const pickedTags = (root, name = 'tp') => $$(`input[name=${name}]:checked`, root).map((i) => Number(i.value));

// ---------------- tags ----------------
function openTagManager() {
  const col = (kind) => `<div class="tm-col">
    <h4>${esc(t(kind === 'pillar' ? 'pillars' : 'formats'))}</h4>
    <p class="muted small">${esc(t(kind === 'pillar' ? 'tagExamplesPillar' : 'tagExamplesFormat'))}</p>
    <div class="tm-list">${state.tags.filter((x) => x.kind === kind).map((x) =>
      `<div class="tm-item"><span class="tag ${kind}" style="--tc:${esc(x.color || '#8b93a7')}">${esc(x.name)}</span>
       <button class="btn tiny danger" data-del-tag="${x.id}">×</button></div>`).join('')}</div>
    <div class="row"><input data-new-tag="${kind}" maxlength="40" placeholder="${esc(t('newTagName'))}">
      <button class="btn" data-add-tag="${kind}">${esc(t('add'))}</button></div></div>`;
  openModal(`<h3>${esc(t('manageTags'))}</h3><div class="grid-2 tm">${col('pillar')}${col('format')}</div>
    <div class="row right-row"><button class="btn" data-close>${esc(t('close'))}</button></div>`, (root) => {
    const add = async (kind) => {
      const input = $(`[data-new-tag=${kind}]`, root);
      const name = input.value.trim();
      if (!name) return;
      await call(api.saveTag, { name, kind, color: TAG_COLORS[state.tags.length % TAG_COLORS.length] });
      await reloadTags();
      openTagManager();
    };
    $$('[data-add-tag]', root).forEach((b) => b.addEventListener('click', () => add(b.dataset.addTag).catch(() => {})));
    $$('[data-new-tag]', root).forEach((i) => i.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(i.dataset.newTag).catch(() => {}); }));
    $$('[data-del-tag]', root).forEach((b) => b.addEventListener('click', async () => {
      if (!confirm(t('confirmDelete'))) return;
      await call(api.deleteTag, Number(b.dataset.delTag));
      await reloadTags();
      state.videos.forEach((v) => { v.tag_ids = v.tag_ids.filter((id) => id !== Number(b.dataset.delTag)); });
      openTagManager();
    }));
  });
  // refresh anything showing tags when the dialog closes
  const obs = new MutationObserver(() => {
    if ($('#modal').classList.contains('hidden')) {
      obs.disconnect();
      if (state.view === 'videos') { renderTagFilter(); renderVideoTable(); }
      if (state.view === 'scheduler') window.renderPostTags && window.renderPostTags();
    }
  });
  obs.observe($('#modal'), { attributes: true, attributeFilter: ['class'] });
}

function openVideoTagEditor(videoId) {
  const v = state.videos.find((x) => x.id === videoId);
  if (!v) return;
  openModal(`<h3>${esc(t('editTags'))}</h3><p class="muted small ellipsis">${esc(v.title || v.id)}</p>
    <div class="tag-pick">${tagPicker(v.tag_ids)}</div>
    <div class="row right-row"><button class="btn ghost" id="mtManage">${esc(t('manageTags'))}</button><div class="spacer"></div>
      <button class="btn" data-close>${esc(t('cancel'))}</button><button class="btn primary" id="mtSave">${esc(t('save'))}</button></div>`, (root) => {
    bindTagPicker(root);
    $('#mtManage', root).addEventListener('click', openTagManager);
    $('#mtSave', root).addEventListener('click', async () => {
      const ids = pickedTags(root);
      await call(api.setVideoTags, v.id, ids);
      v.tag_ids = ids;
      closeModal();
      renderVideoTable();
    });
  });
}

// ---------------- velocity ----------------
async function renderVelocity() {
  const d = await call(api.velocity);
  state.vel = d;
  updateVelBadge(d);
  $('#velMeta').innerHTML = `<span class="badge ${d.fastSync ? 'published' : ''}">${esc(d.fastSync ? t('fastSyncOn') : t('fastSyncOff'))}</span>
    ${d.lastRecentSync ? `${esc(t('lastSync'))}: ${esc(fmtDate(d.lastRecentSync))}` : ''}`;
  $('#velExplain').textContent = t('velExplain', { src: d.baseline ? t(`base_${d.baseline.source}`) : '—' });
  const empty = !d.videos.length;
  $('#velEmpty').classList.toggle('hidden', !empty);
  $('.grid-vel').classList.toggle('hidden', empty);
  if (empty) return;
  if (!d.videos.find((v) => v.id === state.velSelected)) state.velSelected = d.videos[0].id;
  $('#velList').innerHTML = d.videos.map((v) => {
    const w = Math.min(100, (v.ratio / 3) * 100);
    return `<div class="vel-card ${v.id === state.velSelected ? 'sel' : ''}" data-vid="${esc(v.id)}">
      <img src="${esc(v.cover_image_url)}" alt="">
      <div class="vel-main">
        <div class="t">${esc(v.title || '—')}</div>
        <div class="muted small">${esc(ageLabel(v.ageH))} · ▶ ${fmt(v.view_count)} · ${fmt(v.viewsPerHour)} ${esc(t('perHour'))} · ${pct(v.engagement)}</div>
        <div class="vel-bar"><div class="${esc(v.level)}" style="width:${w}%"></div><i style="left:${100 / 3}%"></i></div>
      </div>
      <div class="vel-ratio ${esc(v.level)}"><b>${v.ratio.toFixed(1)}×</b><span>${esc(t(`level_${v.level}`))}</span></div>
    </div>`;
  }).join('');
  $$('#velList [data-vid]').forEach((el) => el.addEventListener('click', () => { state.velSelected = el.dataset.vid; renderVelocityDetail(); markSel(); }));
  renderVelocityDetail();
}
function markSel() { $$('#velList [data-vid]').forEach((el) => el.classList.toggle('sel', el.dataset.vid === state.velSelected)); }

function expectedCurve(baseline, maxH) {
  const pts = [{ h: 0, views: 0 }, ...baseline.points];
  const out = pts.filter((p) => p.h <= maxH).map((p) => ({ x: p.h, y: Math.round(p.views) }));
  const next = pts.find((p) => p.h > maxH);
  if (next) { // interpolate the curve up to the chart edge
    const prev = pts.filter((p) => p.h <= maxH).pop();
    out.push({ x: maxH, y: Math.round(prev.views + ((maxH - prev.h) / (next.h - prev.h)) * (next.views - prev.views)) });
  }
  return out;
}

function renderVelocityDetail() {
  const d = state.vel;
  const v = d.videos.find((x) => x.id === state.velSelected);
  if (!v) return;
  $('#velDetailTitle').innerHTML = `${esc(v.title || '—')} <span class="vel-pill ${esc(v.level)}">${esc(t('vsExpected', { r: v.ratio.toFixed(2) }))}</span>`;
  const maxH = Math.max(6, Math.ceil(v.ageH * 1.1));
  const actual = [{ x: 0, y: 0 }, ...v.series.filter((p) => p.ageH >= 0).map((p) => ({ x: +p.ageH.toFixed(2), y: p.views }))];
  if (!actual.length || actual[actual.length - 1].x < v.ageH - 0.05) actual.push({ x: +v.ageH.toFixed(2), y: v.view_count });
  chart('chVelocity', {
    type: 'line',
    data: {
      datasets: [
        { label: t('actual'), data: actual, borderColor: '#fe2c55', backgroundColor: '#fe2c55', pointRadius: 3, tension: 0.2 },
        { label: t('expected'), data: expectedCurve(d.baseline, maxH), borderColor: '#8b93a7', borderDash: [6, 4], pointRadius: 0, tension: 0.3 }
      ]
    },
    options: {
      parsing: true,
      plugins: { legend: { display: true, labels: { boxWidth: 12 } }, tooltip: { intersect: false, mode: 'nearest' } },
      scales: {
        x: { type: 'linear', min: 0, max: maxH, grid: { display: false }, ticks: { callback: (x) => ageLabel(x) } },
        y: { beginAtZero: true, ticks: { callback: (x) => fmt(x) } }
      }
    }
  });
  const tips = t(`advice_${v.level}`);
  $('#velAdvice').innerHTML = `<ul>${(Array.isArray(tips) ? tips : []).map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
    <div class="row"><button class="btn tiny" id="velOpen">TikTok ↗</button>
    <button class="btn tiny" id="velTag">${esc(t('col_tags'))}</button></div>`;
  $('#velOpen').addEventListener('click', () => v.share_url && call(api.openUrl, v.share_url).catch(() => {}));
  $('#velTag').addEventListener('click', async () => {
    if (!state.videos.length) state.videos = await call(api.videos);
    openVideoTagEditor(v.id);
  });
}

function updateVelBadge(d) {
  const n = d ? d.videos.filter((v) => v.level === 'hot' && v.ageH <= 48).length : 0;
  const b = $('#velBadge');
  b.textContent = n;
  b.classList.toggle('hidden', !n);
}
api.on('velocity:alert', async () => {
  const r = await api.velocity();
  if (r.ok) updateVelBadge(r.data);
  if (state.view === 'velocity') renderVelocity();
});

// ---------------- calendar & goals ----------------
function bestHourFor(day) {
  const a = state.analytics;
  if (!a) return 19;
  let best = null;
  a.best.heat[day].forEach((c, h) => { if (c.n && (!best || c.score > best.score)) best = { h, score: c.score }; });
  if (best) return best.h;
  const byHour = a.rollup.byHour;
  const top = byHour.map((x, h) => ({ h, m: x.median, n: x.n })).filter((x) => x.n).sort((x, y) => y.m - x.m)[0];
  return top ? top.h : 19;
}

async function renderCalendar() {
  if (!state.cal) { const n = new Date(); state.cal = { y: n.getFullYear(), m: n.getMonth() }; }
  if (!state.analytics && state.settings.loggedIn) { const r = await api.analytics(); if (r.ok) state.analytics = r.data; }
  const { y, m } = state.cal;
  const d = await call(api.calendar, y, m);
  const loc = state.lang === 'th' ? 'th-TH' : 'en-GB';
  $('#calLabel').textContent = new Date(y, m, 1).toLocaleDateString(loc, { month: 'long', year: 'numeric' });

  // goal box
  const g = d.goal;
  const done = g.postedThisWeek + g.scheduledThisWeek;
  $('#goalBox').innerHTML = `
    <div class="goal-num"><b>${g.postedThisWeek}</b><span>/ ${g.goal}</span></div>
    <div class="goal-bar"><div class="p" style="width:${Math.min(100, (g.postedThisWeek / g.goal) * 100)}%"></div>
      <div class="s" style="width:${Math.min(100, (done / g.goal) * 100)}%"></div></div>
    <div>${esc(t('goalProgress', { p: g.postedThisWeek, g: g.goal }))} ${g.scheduledThisWeek ? `<span class="muted">${esc(t('goalScheduled', { n: g.scheduledThisWeek }))}</span>` : ''}</div>
    <div class="${g.postedThisWeek >= g.goal ? 'pos' : g.remaining ? 'muted' : 'warn'}">${esc(g.postedThisWeek >= g.goal ? t('goalDone') : g.remaining ? t('goalRemaining', { n: g.remaining }) : t('goalOnTrack'))}</div>
    <div class="streak">${g.streak ? `🔥 ${esc(t('streak', { n: g.streak }))}` : `<span class="muted small">${esc(t('streakZero'))}</span>`}</div>
    <div class="muted small">${esc(t('weekly'))}</div>`;
  chart('chGoal', {
    type: 'bar',
    data: {
      labels: g.history.map((w) => new Date(w.week).toLocaleDateString(loc, { day: 'numeric', month: 'short' })),
      datasets: [
        { data: g.history.map((w) => w.posted), backgroundColor: g.history.map((w) => (w.posted >= g.goal ? '#3ddc97' : '#fe2c55')), borderRadius: 3 },
        { type: 'line', data: g.history.map(() => g.goal), borderColor: '#8b93a7', borderDash: [4, 4], pointRadius: 0 }
      ]
    },
    options: { scales: { x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 6 } }, y: { beginAtZero: true, ticks: { precision: 0 } } } }
  });

  // month grid (weeks start Monday)
  const first = new Date(y, m, 1);
  const start = new Date(first);
  start.setDate(1 - ((first.getDay() + 6) % 7));
  const items = new Map();
  const push = (k, it) => { if (!items.has(k)) items.set(k, []); items.get(k).push(it); };
  d.videos.forEach((v) => push(dayKey(new Date(v.create_time * 1000)), { kind: 'posted', at: v.create_time * 1000, v }));
  d.posts.forEach((p) => {
    if (['published', 'inbox'].includes(p.status)) return; // shown as posted video once synced
    push(dayKey(new Date(p.scheduled_at)), { kind: p.status === 'failed' ? 'failed' : 'scheduled', at: p.scheduled_at, p });
  });
  d.ideas.forEach((i) => push(i.target_date, { kind: 'idea', at: 0, i }));
  const today = dayKey(new Date());
  const dn = t('daysShort');
  let html = [1, 2, 3, 4, 5, 6, 0].map((i) => `<div class="cal-h">${esc(dn[i])}</div>`).join('');
  for (let i = 0; i < 42; i++) {
    const day = new Date(start); day.setDate(start.getDate() + i);
    const k = dayKey(day);
    const list = (items.get(k) || []).sort((a, b) => a.at - b.at);
    const future = k >= today;
    const cls = ['cal-cell', day.getMonth() !== m ? 'other' : '', k === today ? 'today' : '', future ? 'future' : ''].join(' ');
    const shown = list.slice(0, 3).map((it) => {
      const time = it.at ? new Date(it.at).toLocaleTimeString(state.lang === 'th' ? 'th-TH' : 'en-GB', { hour: '2-digit', minute: '2-digit' }) : '';
      if (it.kind === 'posted') return `<div class="cal-it posted" data-url="${esc(it.v.share_url)}" title="${esc(it.v.title)}">${esc(time)} ${esc(it.v.title || '—')} <span>▶${fmt(it.v.view_count)}</span></div>`;
      if (it.kind === 'idea') return `<div class="cal-it idea" data-idea="${it.i.id}" title="${esc(it.i.title)}">💡 ${esc(it.i.title)}</div>`;
      return `<div class="cal-it ${it.kind}" data-goto-sched="1" title="${esc(it.p.title || '')}">${esc(time)} ${esc(it.p.title || it.p.file_path.split(/[\\/]/).pop())}</div>`;
    }).join('');
    const more = list.length > 3 ? `<div class="muted small">${esc(t('more', { n: list.length - 3 }))}</div>` : '';
    html += `<div class="${cls}" data-day="${k}"><div class="cal-d">${day.getDate()}</div>${shown}${more}</div>`;
  }
  $('#calGrid').innerHTML = html;
  bindOpen($('#calGrid'));
  $$('#calGrid [data-url], #calGrid [data-idea], #calGrid [data-goto-sched]').forEach((el) => el.addEventListener('click', (e) => e.stopPropagation()));
  $$('#calGrid [data-idea]').forEach((el) => el.addEventListener('click', async () => {
    const ideas = await call(api.ideas);
    const idea = ideas.find((x) => x.id === Number(el.dataset.idea));
    if (idea) openIdeaEditor(idea);
  }));
  $$('#calGrid [data-goto-sched]').forEach((el) => el.addEventListener('click', () => go('scheduler')));
  $$('#calGrid .cal-cell.future').forEach((el) => el.addEventListener('click', () => {
    const [yy, mm, dd] = el.dataset.day.split('-').map(Number);
    const at = new Date(yy, mm - 1, dd, bestHourFor(new Date(yy, mm - 1, dd).getDay()), 0, 0);
    if (at.getTime() < Date.now() + 10 * 60 * 1000) at.setTime(Date.now() + 15 * 60 * 1000);
    prefillPost({ at });
  }));
}
function shiftMonth(n) {
  const d = new Date(state.cal.y, state.cal.m + n, 1);
  state.cal = { y: d.getFullYear(), m: d.getMonth() };
  renderCalendar();
}
$('#calPrev').addEventListener('click', () => shiftMonth(-1));
$('#calNext').addEventListener('click', () => shiftMonth(1));
$('#calToday').addEventListener('click', () => { state.cal = null; renderCalendar(); });

// ---------------- ideas ----------------
const IDEA_COLUMNS = ['idea', 'drafting', 'scheduled', 'done'];

function renderIdeaFilters() {
  const s = $('#ideaStatusFilter');
  const cur = s.value || 'active';
  s.innerHTML = `<option value="active">${esc(t('allStatus'))}</option><option value="archived">${esc(t('istatus_archived'))}</option>`;
  s.value = cur;
  const tf = $('#ideaTagFilter');
  const curT = tf.value;
  tf.innerHTML = `<option value="">${esc(t('allTags'))}</option>` + state.tags.map((x) => `<option value="${x.id}">${esc(x.name)}</option>`).join('');
  tf.value = curT;
}

async function renderIdeas() {
  renderIdeaFilters();
  const all = state.ideas = await call(api.ideas);
  const q = $('#ideaSearch').value.trim().toLowerCase();
  const tf = Number($('#ideaTagFilter').value);
  const archived = $('#ideaStatusFilter').value === 'archived';
  const list = all.filter((i) => (!q || `${i.title} ${i.notes} ${i.caption}`.toLowerCase().includes(q)) && (!tf || i.tag_ids.includes(tf)));
  const cols = archived ? ['archived'] : IDEA_COLUMNS;
  if (!all.length) { $('#ideaBoard').innerHTML = `<div class="empty"><p>${esc(t('noIdeas'))}</p></div>`; return; }
  $('#ideaBoard').className = `idea-board cols-${cols.length}`;
  $('#ideaBoard').innerHTML = cols.map((st) => {
    const items = list.filter((i) => i.status === st);
    return `<div class="idea-col"><div class="idea-col-h">${esc(t(`istatus_${st}`))} <span class="muted">${items.length}</span></div>
      ${items.map((i) => `<div class="idea-card prio-${i.priority}" data-idea="${i.id}">
        <div class="t">${esc(i.title)}</div>
        ${i.notes ? `<div class="muted small clamp">${esc(i.notes)}</div>` : ''}
        <div class="tag-row">${tagChips(i.tag_ids)}</div>
        <div class="row small">
          ${i.target_date ? `<span class="muted">📅 ${esc(new Date(i.target_date + 'T00:00').toLocaleDateString(state.lang === 'th' ? 'th-TH' : 'en-GB', { day: 'numeric', month: 'short' }))}</span>` : ''}
          <span class="prio">${esc(t(`prio_${i.priority}`))}</span>
          <div class="spacer"></div>
          ${['idea', 'drafting'].includes(i.status) ? `<button class="btn tiny" data-topost="${i.id}">${esc(t('toPost'))}</button>` : ''}
        </div></div>`).join('')}</div>`;
  }).join('');
  $$('#ideaBoard [data-idea]').forEach((el) => el.addEventListener('click', () => openIdeaEditor(all.find((x) => x.id === Number(el.dataset.idea)))));
  $$('#ideaBoard [data-topost]').forEach((b) => b.addEventListener('click', (e) => {
    e.stopPropagation();
    ideaToPost(all.find((x) => x.id === Number(b.dataset.topost)));
  }));
}

function ideaToPost(i) {
  let at;
  if (i.target_date) {
    const [yy, mm, dd] = i.target_date.split('-').map(Number);
    at = new Date(yy, mm - 1, dd, bestHourFor(new Date(yy, mm - 1, dd).getDay()), 0, 0);
    if (at.getTime() < Date.now() + 10 * 60 * 1000) at = undefined;
  }
  prefillPost({ caption: i.caption || '', tagIds: i.tag_ids, ideaId: i.id, ideaTitle: i.title, at });
}

function openIdeaEditor(idea = null) {
  const i = idea || { title: '', notes: '', caption: '', tag_ids: [], priority: 2, status: 'idea', target_date: '' };
  const statuses = [...IDEA_COLUMNS, 'archived'];
  openModal(`<h3>${esc(idea ? t('edit') : t('newIdea'))}</h3>
    <div class="field"><label>${esc(t('ideaTitle'))}</label><input id="ieTitle" maxlength="200" value="${esc(i.title)}"></div>
    <div class="field"><label>${esc(t('notes'))}</label><textarea id="ieNotes" rows="4">${esc(i.notes || '')}</textarea></div>
    <div class="field"><label>${esc(t('ideaCaption'))}</label><textarea id="ieCaption" rows="3" maxlength="2200">${esc(i.caption || '')}</textarea>
      <div class="small muted">${esc(t('suggestedTags'))}</div><div id="ieSuggest" class="chips clickable"></div></div>
    <div class="field"><label>${esc(t('col_tags'))}</label><div class="tag-pick">${tagPicker(i.tag_ids, 'ie')}</div></div>
    <div class="row wrap">
      <div class="field grow"><label>${esc(t('priority'))}</label><select id="iePrio">${[1, 2, 3].map((p) => `<option value="${p}" ${i.priority === p ? 'selected' : ''}>${esc(t(`prio_${p}`))}</option>`).join('')}</select></div>
      <div class="field grow"><label>${esc(t('targetDate'))}</label><input id="ieDate" type="date" value="${esc(i.target_date || '')}"></div>
      <div class="field grow"><label>${esc(t('status'))}</label><select id="ieStatus">${statuses.map((s) => `<option value="${s}" ${i.status === s ? 'selected' : ''}>${esc(t(`istatus_${s}`))}</option>`).join('')}</select></div>
    </div>
    <div class="row right-row">
      ${idea ? `<button class="btn danger" id="ieDel">${esc(t('del'))}</button>` : ''}
      <div class="spacer"></div>
      <button class="btn" data-close>${esc(t('cancel'))}</button>
      <button class="btn" id="iePost">${esc(t('toPost'))}</button>
      <button class="btn primary" id="ieSave">${esc(t('save'))}</button>
    </div>`, (root) => {
    bindTagPicker(root, 'ie');
    const collect = () => ({
      id: idea && idea.id, title: $('#ieTitle', root).value, notes: $('#ieNotes', root).value, caption: $('#ieCaption', root).value,
      tagIds: pickedTags(root, 'ie'), priority: Number($('#iePrio', root).value), target_date: $('#ieDate', root).value, status: $('#ieStatus', root).value
    });
    const save = async () => {
      const data = collect();
      const id = await call(api.saveIdea, data);
      return { ...data, id, tag_ids: data.tagIds };
    };
    $('#ieSave', root).addEventListener('click', async () => { await save(); closeModal(); refreshIdeasOrCalendar(); });
    $('#iePost', root).addEventListener('click', async () => { const saved = await save(); closeModal(); ideaToPost(saved); });
    if (idea) $('#ieDel', root).addEventListener('click', async () => {
      if (!confirm(t('confirmDelete'))) return;
      await call(api.deleteIdea, idea.id); closeModal(); refreshIdeasOrCalendar();
    });
    // hashtag suggestions for the caption
    const loadSug = async () => {
      const pillar = pickedTags(root, 'ie').map(tagById).find((x) => x && x.kind === 'pillar');
      const r = await api.suggestHashtags(pillar ? pillar.id : null);
      const cap = $('#ieCaption', root).value.toLowerCase();
      $('#ieSuggest', root).innerHTML = (r.ok ? r.data : []).map((h) =>
        `<button type="button" class="chip ${cap.includes(h.tag) ? 'used' : ''}" data-h="${esc(h.tag)}">${esc(h.tag)} <span class="muted">${h.lift.toFixed(1)}×</span></button>`).join('');
      $$('#ieSuggest [data-h]', root).forEach((b) => b.addEventListener('click', () => {
        const c = $('#ieCaption', root);
        if (!c.value.toLowerCase().includes(b.dataset.h)) c.value = `${c.value.replace(/\s*$/, '')} ${b.dataset.h}`.trimStart();
        b.classList.add('used');
      }));
    };
    if (state.settings.loggedIn) loadSug();
    $$('input[name=ie]', root).forEach((x) => x.addEventListener('change', loadSug));
  });
}
function refreshIdeasOrCalendar() {
  if (state.view === 'ideas') renderIdeas();
  if (state.view === 'calendar') renderCalendar();
}
$('#newIdea').addEventListener('click', () => openIdeaEditor());
['#ideaStatusFilter', '#ideaTagFilter'].forEach((s) => $(s).addEventListener('change', renderIdeas));
$('#ideaSearch').addEventListener('input', renderIdeas);

// ---------------- insights: attribution & tags ----------------
function perfTable(rows) {
  if (!rows || !rows.length) return `<p class="muted small">${esc(t('noTagsYet'))}</p>`;
  return `<table class="data compact"><thead><tr><th>${esc(t('col_tags'))}</th><th class="num">${esc(t('videos'))}</th>
    <th class="num">${esc(t('medianViews'))}</th><th class="num">${esc(t('lift'))}</th><th class="num">ER</th>
    <th class="num">${esc(t('followersGained'))}</th><th class="num">${esc(t('per1k'))}</th></tr></thead><tbody>
    ${rows.map((r) => `<tr><td>${r.untagged ? `<span class="muted">${esc(t('untagged'))}</span>` : `<span class="tag ${esc(r.tag.kind)}" style="--tc:${esc(r.tag.color || '#8b93a7')}">${esc(r.tag.name)}</span>`}</td>
      <td class="num">${r.count}</td><td class="num">${fmt(r.medianViews)}</td>
      <td class="num ${r.lift >= 1 ? 'pos' : 'neg'}">${r.count ? r.lift.toFixed(2) + '×' : '—'}</td>
      <td class="num">${pct(r.avgEngagement)}</td><td class="num">${fmt(r.followers)}</td><td class="num">${r.per1k ? r.per1k.toFixed(2) : '—'}</td></tr>`).join('')}
    </tbody></table>`;
}

window.renderGrowthInsights = (a) => {
  const att = a.attribution;
  const rows = att ? att.rows : [];
  $('#attrNote').textContent = rows.length ? t('attrNote', { a: fmt(att.attributed), u: fmt(att.unattributed) }) : t('attrEmpty');
  $('#attrTable').classList.toggle('hidden', !rows.length);
  $('#attrTable tbody').innerHTML = rows.map((r) => `<tr data-url="${esc(r.share_url || '')}">
    <td><img src="${esc(r.cover_image_url || '')}" alt=""></td><td class="title">${esc(r.title || r.video_id)}</td>
    <td class="num">${fmt(r.viewsGained)}</td><td class="num"><b>${fmt(r.followers)}</b></td><td class="num">${r.per1k.toFixed(2)}</td></tr>`).join('');
  bindOpen($('#attrTable tbody'));
  const tp = a.tagPerf;
  $('#pillarPerf').innerHTML = perfTable(tp && tp.pillar.filter((r) => r.count || !r.untagged));
  $('#formatPerf').innerHTML = perfTable(tp && tp.format.filter((r) => r.count || !r.untagged));
};

window.GROWTH_VIEWS = { velocity: renderVelocity, calendar: renderCalendar, ideas: renderIdeas };
window.renderPostTags = typeof renderPostTags === 'function' ? renderPostTags : null;

// initial badge
api.velocity().then((r) => { if (r.ok) updateVelBadge(r.data); }).catch(() => {});
