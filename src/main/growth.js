'use strict';

/**
 * Growth features (pure functions, no Electron/DB):
 *  - early velocity of new videos vs. channel baseline
 *  - follower attribution per video
 *  - posting goal / streak
 *  - hashtag suggestions and per-tag (pillar/format) performance
 */

const { median, engagementRate, hashtagStats } = require('./analytics');

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const CHECKPOINTS_H = [1, 3, 6, 12, 24, 48];
// Rough share of a video's 7-day views reached at each age — used only until the
// channel has enough of its own early data (then the real history is used).
const DEFAULT_CURVE = { 1: 0.04, 3: 0.1, 6: 0.18, 12: 0.3, 24: 0.45, 48: 0.62 };
const MIN_HISTORY = 5;
const TRACK_DAYS = 7;

const num = (x) => Number(x) || 0;

/** Group snapshot rows by video id, sorted by time. */
function groupSnapshots(rows) {
  const m = new Map();
  for (const r of rows) {
    if (!m.has(r.video_id)) m.set(r.video_id, []);
    m.get(r.video_id).push(r);
  }
  for (const arr of m.values()) arr.sort((a, b) => a.taken_at - b.taken_at);
  return m;
}

/**
 * Views of a video at a given age, interpolated between snapshots (origin = 0 views at post time).
 * Returns null when no snapshot is close enough to the requested age to be trustworthy.
 */
function viewsAtAge(snaps, createdMs, ageH) {
  if (!snaps || !snaps.length) return null;
  const target = createdMs + ageH * HOUR;
  let before = { taken_at: createdMs, view_count: 0 }; // origin: 0 views at post time
  let after = null;
  for (const s of snaps) {
    if (s.taken_at <= target) before = s;
    else { after = s; break; }
  }
  if (!after) {
    // only snapshots before the target: accept if the last one is close enough
    return target - before.taken_at <= Math.max(0.5, ageH * 0.35) * HOUR ? num(before.view_count) : null;
  }
  // interpolate only across a short enough gap to be trustworthy
  const span = after.taken_at - before.taken_at;
  if (span > Math.max(2, ageH) * HOUR) return null;
  const f = (target - before.taken_at) / (span || 1);
  return num(before.view_count) + f * (num(after.view_count) - num(before.view_count));
}

/** Baseline "expected views" at each checkpoint for this channel. */
function buildBaseline(videos, snapsByVideo, now = Date.now()) {
  const matured = videos.filter((v) => now - num(v.create_time) * 1000 > TRACK_DAYS * DAY);
  const lifetime = median((matured.length >= 3 ? matured : videos).map((v) => num(v.view_count)));
  const points = CHECKPOINTS_H.map((h) => {
    const vals = [];
    for (const v of videos) {
      const created = num(v.create_time) * 1000;
      if (!created || now - created < h * HOUR) continue;
      const x = viewsAtAge(snapsByVideo.get(v.id), created, h);
      if (x !== null) vals.push(x);
    }
    if (vals.length >= MIN_HISTORY) return { h, views: median(vals), n: vals.length, source: 'history' };
    return { h, views: lifetime * DEFAULT_CURVE[h], n: vals.length, source: 'estimate' };
  });
  // 7-day point: a matured video is expected to reach the channel's typical lifetime views
  points.push({ h: TRACK_DAYS * 24, views: lifetime, n: matured.length, source: 'history' });
  // keep the curve monotonic
  for (let i = 1; i < points.length; i++) points[i].views = Math.max(points[i].views, points[i - 1].views);
  const early = points.slice(0, CHECKPOINTS_H.length);
  const source = early.every((p) => p.source === 'history') ? 'history'
    : early.some((p) => p.source === 'history') ? 'mixed' : 'estimate';
  return { points, lifetimeMedian: lifetime, source };
}

function expectedAt(baseline, ageH) {
  const pts = [{ h: 0, views: 0 }, ...baseline.points];
  if (ageH >= pts[pts.length - 1].h) return pts[pts.length - 1].views;
  for (let i = 1; i < pts.length; i++) {
    if (ageH <= pts[i].h) {
      const a = pts[i - 1]; const b = pts[i];
      return a.views + ((ageH - a.h) / (b.h - a.h)) * (b.views - a.views);
    }
  }
  return 0;
}

function levelFor(ratio) {
  if (ratio >= 2) return 'hot';
  if (ratio >= 1.3) return 'up';
  if (ratio >= 0.7) return 'normal';
  return 'low';
}

/** Velocity for videos younger than TRACK_DAYS. */
function velocity(videos, snapRows, now = Date.now()) {
  const snaps = groupSnapshots(snapRows);
  const baseline = buildBaseline(videos, snaps, now);
  const tracked = videos
    .filter((v) => num(v.create_time) && now - num(v.create_time) * 1000 <= TRACK_DAYS * DAY)
    .map((v) => {
      const created = num(v.create_time) * 1000;
      const ageH = Math.max(0.01, (now - created) / HOUR);
      const expected = expectedAt(baseline, ageH);
      const views = num(v.view_count);
      const ratio = expected > 0 ? views / expected : (views > 0 ? 2 : 1);
      const s = snaps.get(v.id) || [];
      return {
        ...v,
        engagement: engagementRate(v),
        ageH,
        expected,
        ratio,
        level: levelFor(ratio),
        viewsPerHour: views / ageH,
        series: s.map((x) => ({ ageH: (x.taken_at - created) / HOUR, views: num(x.view_count) }))
      };
    })
    .sort((a, b) => num(b.create_time) - num(a.create_time));
  return { baseline, videos: tracked };
}

/**
 * Attribute follower gains to videos. For each interval between two account snapshots with
 * a follower gain, the gain is split across videos in proportion to the views each gained
 * in that interval. This is an estimate: TikTok does not expose per-video follows.
 */
function attributeFollowers(accountSnaps, videoSnapRows, videos) {
  const created = new Map(videos.map((v) => [v.id, num(v.create_time) * 1000]));
  const byTime = new Map();
  for (const r of videoSnapRows) {
    if (!byTime.has(r.taken_at)) byTime.set(r.taken_at, new Map());
    byTime.get(r.taken_at).set(r.video_id, num(r.view_count));
  }
  const acc = [...accountSnaps].sort((a, b) => a.taken_at - b.taken_at);
  const out = new Map();
  let attributed = 0; let unattributed = 0;
  for (let i = 1; i < acc.length; i++) {
    const a = acc[i - 1]; const b = acc[i];
    const df = num(b.follower_count) - num(a.follower_count);
    if (df <= 0) continue;
    const vb = byTime.get(b.taken_at);
    const va = byTime.get(a.taken_at) || new Map();
    if (!vb) { unattributed += df; continue; }
    const deltas = [];
    for (const [id, views] of vb) {
      let prev = va.get(id);
      if (prev === undefined) {
        if ((created.get(id) || 0) > a.taken_at) prev = 0; // posted during the interval
        else continue; // not measured at the start of the interval
      }
      const dv = Math.max(0, views - prev);
      if (dv > 0) deltas.push([id, dv]);
    }
    const total = deltas.reduce((s, [, dv]) => s + dv, 0);
    if (!total) { unattributed += df; continue; }
    for (const [id, dv] of deltas) {
      const o = out.get(id) || { video_id: id, followers: 0, viewsGained: 0 };
      o.followers += (df * dv) / total;
      o.viewsGained += dv;
      out.set(id, o);
    }
    attributed += df;
  }
  const rows = [...out.values()].map((o) => ({ ...o, per1k: o.viewsGained ? (o.followers / o.viewsGained) * 1000 : 0 }));
  rows.sort((x, y) => y.followers - x.followers);
  return { rows, attributed, unattributed };
}

// ---------------- goals ----------------
function weekStart(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  const dow = (d.getDay() + 6) % 7; // Monday = 0
  d.setDate(d.getDate() - dow);
  return d.getTime();
}

function postingGoal(videos, pendingPosts, goal, now = Date.now(), weeks = 12) {
  goal = Math.max(1, num(goal) || 4);
  const thisWeek = weekStart(now);
  const counts = new Map();
  for (const v of videos) {
    const w = weekStart(num(v.create_time) * 1000);
    counts.set(w, (counts.get(w) || 0) + 1);
  }
  const history = [];
  for (let i = weeks - 1; i >= 0; i--) {
    const d = new Date(thisWeek);
    d.setDate(d.getDate() - i * 7);
    const w = d.getTime();
    history.push({ week: w, posted: counts.get(w) || 0 });
  }
  const nextWeek = new Date(thisWeek); nextWeek.setDate(nextWeek.getDate() + 7);
  const scheduled = pendingPosts.filter((p) => p.scheduled_at >= now && p.scheduled_at < nextWeek.getTime()).length;
  const postedThisWeek = counts.get(thisWeek) || 0;
  // streak: consecutive completed weeks meeting the goal (+ this week if already met)
  let streak = postedThisWeek >= goal ? 1 : 0;
  for (let i = history.length - 2; i >= 0; i--) {
    if (history[i].posted >= goal) streak++;
    else break;
  }
  const hasAnyHistory = videos.length > 0;
  return {
    goal, postedThisWeek, scheduledThisWeek: scheduled,
    remaining: Math.max(0, goal - postedThisWeek - scheduled),
    streak: hasAnyHistory ? streak : 0,
    history,
    weekStart: thisWeek
  };
}

// ---------------- tags ----------------
function tagsByVideo(videoTagRows) {
  const m = new Map();
  for (const r of videoTagRows) {
    if (!m.has(r.video_id)) m.set(r.video_id, []);
    m.get(r.video_id).push(r.tag_id);
  }
  return m;
}

function tagPerformance(videos, videoTagRows, tags, attribution) {
  const vt = tagsByVideo(videoTagRows);
  const fol = new Map((attribution ? attribution.rows : []).map((r) => [r.video_id, r]));
  const overall = median(videos.map((v) => num(v.view_count))) || 1;
  const summarize = (vs) => {
    const f = vs.reduce((s, v) => s + (fol.get(v.id)?.followers || 0), 0);
    const gained = vs.reduce((s, v) => s + (fol.get(v.id)?.viewsGained || 0), 0);
    const med = median(vs.map((v) => num(v.view_count)));
    return {
      count: vs.length,
      medianViews: med,
      lift: med / overall,
      avgEngagement: vs.length ? vs.reduce((s, v) => s + engagementRate(v), 0) / vs.length : 0,
      followers: f,
      per1k: gained ? (f / gained) * 1000 : 0
    };
  };
  const res = { pillar: [], format: [] };
  for (const t of tags) {
    const vs = videos.filter((v) => (vt.get(v.id) || []).includes(t.id));
    (res[t.kind] || res.pillar).push({ tag: t, ...summarize(vs) });
  }
  for (const kind of ['pillar', 'format']) {
    const ids = new Set(tags.filter((t) => t.kind === kind).map((t) => t.id));
    const untagged = videos.filter((v) => !(vt.get(v.id) || []).some((id) => ids.has(id)));
    if (untagged.length && ids.size) res[kind].push({ tag: { id: 0, name: null, kind }, untagged: true, ...summarize(untagged) });
    res[kind].sort((a, b) => ((a.untagged ? 1 : 0) - (b.untagged ? 1 : 0)) || b.medianViews - a.medianViews);
  }
  return res;
}

/** Hashtags that performed well on this channel (optionally within one pillar). */
function suggestHashtags(videos, videoTagRows, { tagId = null, limit = 12 } = {}) {
  let subset = videos;
  if (tagId) {
    const vt = tagsByVideo(videoTagRows);
    const inTag = videos.filter((v) => (vt.get(v.id) || []).includes(Number(tagId)));
    if (inTag.length >= 3) subset = inTag;
  }
  const minCount = subset.length >= 20 ? 2 : 1;
  return hashtagStats(subset, minCount)
    .filter((h) => h.lift >= 0.9)
    .map((h) => ({ ...h, score: h.lift * Math.log2(1 + h.count) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

module.exports = {
  CHECKPOINTS_H, DEFAULT_CURVE, TRACK_DAYS,
  groupSnapshots, viewsAtAge, buildBaseline, expectedAt, levelFor, velocity,
  attributeFollowers, weekStart, postingGoal, tagsByVideo, tagPerformance, suggestHashtags
};
