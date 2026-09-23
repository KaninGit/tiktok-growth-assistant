'use strict';

const assert = require('assert');
const G = require('../src/main/growth');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { console.error(`  ✗ ${name}\n    ${e.stack}`); process.exitCode = 1; }
}
const H = 3600 * 1000;
const D = 24 * H;
const now = new Date(2026, 8, 23, 12, 0, 0).getTime(); // Wed

console.log('Growth features');

test('viewsAtAge interpolates and rejects far snapshots', () => {
  const c = now - 10 * H;
  const snaps = [{ taken_at: c + 2 * H, view_count: 200 }, { taken_at: c + 4 * H, view_count: 600 }];
  assert.strictEqual(G.viewsAtAge(snaps, c, 3), 400);
  assert.strictEqual(G.viewsAtAge(snaps, c, 1), 100); // origin → first snapshot
  assert.strictEqual(G.viewsAtAge(snaps, c, 48), null); // nothing near 48h
});

test('baseline falls back to estimate, then uses history', () => {
  const old = Array.from({ length: 10 }, (_, i) => ({ id: `o${i}`, create_time: (now - (20 + i) * D) / 1000, view_count: 10000 }));
  let b = G.buildBaseline(old, new Map(), now);
  assert.strictEqual(b.source, 'estimate');
  assert.strictEqual(Math.round(b.points.find((p) => p.h === 24).views), 4500);
  // give 6 videos real early snapshots at 1h..48h (1000 views per hour)
  const snaps = new Map();
  old.slice(0, 6).forEach((v) => {
    const c = v.create_time * 1000;
    snaps.set(v.id, G.CHECKPOINTS_H.map((h) => ({ taken_at: c + h * H, view_count: h * 1000 })));
  });
  b = G.buildBaseline(old, snaps, now);
  assert.strictEqual(b.source, 'history');
  assert.strictEqual(b.points.find((p) => p.h === 6).views, 6000);
  assert.strictEqual(G.expectedAt(b, 2), 2000);
});

test('velocity flags a fast new video as hot', () => {
  const old = Array.from({ length: 10 }, (_, i) => ({ id: `o${i}`, create_time: (now - (20 + i) * D) / 1000, view_count: 10000 }));
  const fresh = { id: 'n1', title: 'new', create_time: (now - 6 * H) / 1000, view_count: 5000, like_count: 100 };
  const slow = { id: 'n2', title: 'slow', create_time: (now - 24 * H) / 1000, view_count: 1000 };
  const r = G.velocity([...old, fresh, slow], [], now);
  const f = r.videos.find((v) => v.id === 'n1');
  assert.strictEqual(r.videos.length, 2);
  assert.ok(f.ratio > 2, `ratio ${f.ratio}`);
  assert.strictEqual(f.level, 'hot');
  assert.strictEqual(r.videos.find((v) => v.id === 'n2').level, 'low');
});

test('follower attribution splits gains by views gained', () => {
  const t0 = now - 2 * D; const t1 = now - D; const t2 = now;
  const acc = [{ taken_at: t0, follower_count: 100 }, { taken_at: t1, follower_count: 200 }, { taken_at: t2, follower_count: 190 }];
  const videos = [{ id: 'a', create_time: (t0 - D) / 1000 }, { id: 'b', create_time: (t0 - D) / 1000 }, { id: 'c', create_time: (t0 + H) / 1000 }];
  const snaps = [
    { video_id: 'a', taken_at: t0, view_count: 1000 }, { video_id: 'b', taken_at: t0, view_count: 500 },
    { video_id: 'a', taken_at: t1, view_count: 4000 }, { video_id: 'b', taken_at: t1, view_count: 500 },
    { video_id: 'c', taken_at: t1, view_count: 1000 },
    { video_id: 'a', taken_at: t2, view_count: 5000 }
  ];
  const r = G.attributeFollowers(acc, snaps, videos);
  const a = r.rows.find((x) => x.video_id === 'a');
  const c = r.rows.find((x) => x.video_id === 'c');
  assert.strictEqual(Math.round(a.followers), 75); // 3000 of 4000 views gained
  assert.strictEqual(Math.round(c.followers), 25); // new video counted from 0
  assert.ok(!r.rows.find((x) => x.video_id === 'b')); // no views gained
  assert.strictEqual(r.attributed, 100); // the -10 interval is ignored
  assert.strictEqual(Math.round(a.per1k), 25);
});

test('posting goal counts weeks and streak', () => {
  const ws = G.weekStart(now);
  assert.strictEqual(new Date(ws).getDay(), 1); // Monday
  const vids = [];
  // last 3 full weeks: 4 posts each; this week: 1
  for (let w = 1; w <= 3; w++) for (let k = 0; k < 4; k++) vids.push({ create_time: (ws - w * 7 * D + k * D + H) / 1000 });
  vids.push({ create_time: (ws + H) / 1000 });
  const pending = [{ scheduled_at: now + D }, { scheduled_at: now + 30 * D }];
  const g = G.postingGoal(vids, pending, 4, now);
  assert.strictEqual(g.postedThisWeek, 1);
  assert.strictEqual(g.scheduledThisWeek, 1);
  assert.strictEqual(g.remaining, 2);
  assert.strictEqual(g.streak, 3);
  assert.strictEqual(g.history.length, 12);
});

test('tag performance and hashtag suggestions', () => {
  const vids = [
    { id: '1', title: '#a #b', view_count: 1000 }, { id: '2', title: '#a', view_count: 3000 },
    { id: '3', title: '#b', view_count: 100 }, { id: '4', title: '#a #c', view_count: 5000 }
  ];
  const tags = [{ id: 1, name: 'Recipe', kind: 'pillar' }, { id: 2, name: 'Voice-over', kind: 'format' }];
  const vt = [{ video_id: '2', tag_id: 1 }, { video_id: '4', tag_id: 1 }, { video_id: '4', tag_id: 2 }];
  const perf = G.tagPerformance(vids, vt, tags, { rows: [{ video_id: '4', followers: 10, viewsGained: 1000 }] });
  const recipe = perf.pillar.find((p) => p.tag.id === 1);
  assert.strictEqual(recipe.count, 2);
  assert.strictEqual(recipe.medianViews, 4000);
  assert.strictEqual(recipe.per1k, 10);
  assert.ok(perf.pillar.find((p) => p.untagged).count === 2);
  const sug = G.suggestHashtags(vids, vt);
  assert.strictEqual(sug[0].tag, '#a');
  assert.ok(!sug.find((s) => s.tag === '#b')); // underperforms
});

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
