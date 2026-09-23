'use strict';

/** Pure analytics helpers — no Electron/DB dependencies, easy to unit test. */

const num = (x) => Number(x) || 0;

function engagementRate(v) {
  const views = num(v.view_count);
  if (!views) return 0;
  return (num(v.like_count) + num(v.comment_count) + num(v.share_count)) / views;
}

function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function topVideos(videos, n = 10, metric = 'view_count') {
  const score = metric === 'engagement' ? engagementRate : (v) => num(v[metric]);
  return [...videos]
    .map((v) => ({ ...v, engagement: engagementRate(v) }))
    .sort((a, b) => score(b) - score(a))
    .slice(0, n);
}

/**
 * Best time to post: bucket videos by local weekday × hour of create_time.
 * Score = median views of the slot, normalised by the account median, so 1.0 = "typical".
 * Slots with few samples are shrunk toward 1.0 (simple Bayesian-style smoothing).
 */
function bestTimes(videos, { priorWeight = 2, minSamples = 1 } = {}) {
  const slots = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => []));
  for (const v of videos) {
    if (!v.create_time) continue;
    const d = new Date(num(v.create_time) * 1000);
    slots[d.getDay()][d.getHours()].push(num(v.view_count));
  }
  const overall = median(videos.map((v) => num(v.view_count))) || 1;
  const heat = slots.map((row) => row.map((views) => {
    if (!views.length) return { n: 0, score: null };
    const raw = median(views) / overall;
    const n = views.length;
    const score = (raw * n + 1 * priorWeight) / (n + priorWeight);
    return { n, score };
  }));
  const ranked = [];
  heat.forEach((row, day) => row.forEach((c, hour) => {
    if (c.n >= minSamples) ranked.push({ day, hour, n: c.n, score: c.score });
  }));
  ranked.sort((a, b) => b.score - a.score || b.n - a.n);
  return { heat, top: ranked.slice(0, 5), sampleSize: videos.length };
}

/** Weekday-only and hour-only rollups (more robust with small datasets). */
function dayHourRollup(videos) {
  const byDay = Array.from({ length: 7 }, () => []);
  const byHour = Array.from({ length: 24 }, () => []);
  for (const v of videos) {
    if (!v.create_time) continue;
    const d = new Date(num(v.create_time) * 1000);
    byDay[d.getDay()].push(num(v.view_count));
    byHour[d.getHours()].push(num(v.view_count));
  }
  return {
    byDay: byDay.map((a) => ({ n: a.length, median: median(a) })),
    byHour: byHour.map((a) => ({ n: a.length, median: median(a) }))
  };
}

function extractHashtags(text) {
  if (!text) return [];
  const m = String(text).match(/#[\p{L}\p{N}_]+/gu) || [];
  return [...new Set(m.map((t) => t.toLowerCase()))];
}

function hashtagStats(videos, minCount = 2) {
  const map = new Map();
  for (const v of videos) {
    for (const tag of extractHashtags(`${v.title || ''} ${v.description || ''}`)) {
      if (!map.has(tag)) map.set(tag, []);
      map.get(tag).push(v);
    }
  }
  const overall = median(videos.map((v) => num(v.view_count))) || 1;
  return [...map.entries()]
    .filter(([, vs]) => vs.length >= minCount)
    .map(([tag, vs]) => ({
      tag,
      count: vs.length,
      medianViews: median(vs.map((v) => num(v.view_count))),
      lift: median(vs.map((v) => num(v.view_count))) / overall,
      avgEngagement: vs.reduce((s, v) => s + engagementRate(v), 0) / vs.length
    }))
    .sort((a, b) => b.lift - a.lift);
}

const DURATION_BUCKETS = [
  { key: '0-15', min: 0, max: 15 },
  { key: '15-30', min: 15, max: 30 },
  { key: '30-60', min: 30, max: 60 },
  { key: '60-180', min: 60, max: 180 },
  { key: '180+', min: 180, max: Infinity }
];

function durationStats(videos) {
  return DURATION_BUCKETS.map((b) => {
    const vs = videos.filter((v) => num(v.duration) >= b.min && num(v.duration) < b.max);
    return {
      bucket: b.key,
      count: vs.length,
      medianViews: median(vs.map((v) => num(v.view_count))),
      avgEngagement: vs.length ? vs.reduce((s, v) => s + engagementRate(v), 0) / vs.length : 0
    };
  });
}

/** Collapse snapshots to one per local day (last of the day) and compute deltas. */
function dailyGrowth(snapshots) {
  const byDay = new Map();
  for (const s of [...snapshots].sort((a, b) => a.taken_at - b.taken_at)) {
    const d = new Date(s.taken_at);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    byDay.set(key, s);
  }
  const days = [...byDay.entries()];
  return days.map(([date, s], i) => ({
    date,
    followers: num(s.follower_count),
    likes: num(s.likes_count),
    videos: num(s.video_count),
    delta: i === 0 ? 0 : num(s.follower_count) - num(days[i - 1][1].follower_count)
  }));
}

function summary(videos, growth) {
  const views = videos.reduce((s, v) => s + num(v.view_count), 0);
  const inter = videos.reduce((s, v) => s + num(v.like_count) + num(v.comment_count) + num(v.share_count), 0);
  const last7 = growth.slice(-8);
  const last30 = growth.slice(-31);
  const diff = (arr) => (arr.length > 1 ? arr[arr.length - 1].followers - arr[0].followers : 0);
  return {
    totalViews: views,
    avgViews: videos.length ? views / videos.length : 0,
    medianViews: median(videos.map((v) => num(v.view_count))),
    engagementRate: views ? inter / views : 0,
    followers7d: diff(last7),
    followers30d: diff(last30)
  };
}

function toCsv(rows, columns) {
  const esc = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = columns.map((c) => esc(c.label)).join(',');
  const body = rows.map((r) => columns.map((c) => esc(typeof c.value === 'function' ? c.value(r) : r[c.key])).join(','));
  // BOM so Excel opens Thai text correctly
  return '﻿' + [head, ...body].join('\r\n');
}

module.exports = {
  engagementRate, median, topVideos, bestTimes, dayHourRollup,
  extractHashtags, hashtagStats, durationStats, dailyGrowth, summary, toCsv
};
