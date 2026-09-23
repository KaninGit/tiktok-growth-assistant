'use strict';

// Runs with plain Node (no Electron needed): `npm test`
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { Database } = require('../src/main/db');
const A = require('../src/main/analytics');
const { makePkce, buildAuthUrl } = require('../src/main/oauth');
const { TikTokClient, planChunks, chunkRanges } = require('../src/main/tiktok-api');
const { syncAll } = require('../src/main/sync');
const { Scheduler } = require('../src/main/scheduler');
const cfg = require('../src/main/config');

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { console.error(`  ✗ ${name}\n    ${e.stack}`); process.exitCode = 1; }
}

const MB = 1024 * 1024;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tga-'));

function mockFetch(routes) {
  const calls = [];
  const f = async (url, opts = {}) => {
    const u = String(url);
    calls.push({ url: u, opts });
    for (const [pattern, handler] of routes) {
      if (u.includes(pattern)) {
        const { status = 200, json } = await handler(u, opts);
        return { ok: status < 300, status, json: async () => json, text: async () => JSON.stringify(json || {}) };
      }
    }
    throw new Error(`unmocked ${u}`);
  };
  f.calls = calls;
  return f;
}

(async () => {
  console.log('TikTok Growth Assistant — smoke tests');

  await test('PKCE challenge is hex SHA256 of verifier', () => {
    const { verifier, challenge } = makePkce();
    assert.ok(verifier.length >= 43 && verifier.length <= 128);
    assert.strictEqual(challenge, crypto.createHash('sha256').update(verifier).digest('hex'));
    const url = new URL(buildAuthUrl({ clientKey: 'ck', port: 3455, state: 's', challenge }));
    assert.strictEqual(url.searchParams.get('redirect_uri'), 'http://127.0.0.1:3455/callback/');
    assert.strictEqual(url.searchParams.get('code_challenge_method'), 'S256');
    assert.ok(url.searchParams.get('scope').includes('video.publish'));
  });

  await test('chunk planning follows TikTok rules', () => {
    assert.deepStrictEqual(planChunks(3 * MB), { chunkSize: 3 * MB, count: 1 });
    assert.deepStrictEqual(planChunks(64 * MB), { chunkSize: 64 * MB, count: 1 });
    const size = 105 * MB + 123;
    const p = planChunks(size);
    assert.strictEqual(p.count, 10);
    const r = chunkRanges(size);
    assert.strictEqual(r[0].start, 0);
    assert.strictEqual(r[r.length - 1].end, size - 1);
    const lastLen = r[r.length - 1].end - r[r.length - 1].start + 1;
    assert.ok(lastLen >= 5 * MB && lastLen <= 128 * MB);
    for (let i = 1; i < r.length; i++) assert.strictEqual(r[i].start, r[i - 1].end + 1);
  });

  await test('analytics: engagement, best times, hashtags, growth, csv', () => {
    const base = new Date(2026, 8, 7, 19, 0, 0).getTime() / 1000; // Monday 19:00 local
    const vids = [];
    for (let i = 0; i < 30; i++) {
      const hour = i % 3 === 0 ? 19 : 9;
      const ct = base + (i * 86400) + (hour - 19) * 3600;
      vids.push({ id: String(i), title: i % 2 ? '#food #bangkok' : '#food', create_time: ct, duration: 20 + i,
        view_count: hour === 19 ? 10000 : 1000, like_count: 100, comment_count: 10, share_count: 5 });
    }
    assert.ok(Math.abs(A.engagementRate(vids[0]) - 115 / 10000) < 1e-9);
    const b = A.bestTimes(vids);
    assert.strictEqual(b.top[0].hour, 19);
    assert.strictEqual(b.heat.length, 7);
    const tags = A.hashtagStats(vids);
    assert.ok(tags.find((x) => x.tag === '#food').count === 30);
    assert.deepStrictEqual(A.extractHashtags('ลองกิน #อาหารไทย #Food'), ['#อาหารไทย', '#food']);
    const snaps = [0, 1, 2].map((d) => ({ taken_at: new Date(2026, 8, 1 + d, 12).getTime(), follower_count: 100 + d * 10 }));
    const g = A.dailyGrowth(snaps);
    assert.deepStrictEqual(g.map((x) => x.delta), [0, 10, 10]);
    const csv = A.toCsv([{ a: 'x,"y"', b: 'ไทย' }], [{ label: 'a', key: 'a' }, { label: 'b', key: 'b' }]);
    assert.ok(csv.startsWith('﻿'));
    assert.ok(csv.includes('"x,""y"""'));
  });

  const dbFile = path.join(tmp, 'test.sqlite');
  const db = await new Database(dbFile).open();
  let tokens = null;

  await test('database persists settings to disk', async () => {
    db.setSetting('client_key', 'abc');
    db.flush();
    const db2 = await new Database(dbFile).open();
    assert.strictEqual(db2.getSetting('client_key'), 'abc');
    db2.close();
  });

  const now = Date.now();
  const routes = [
    ['/v2/oauth/token/', async (u, o) => {
      const p = new URLSearchParams(o.body.toString());
      assert.strictEqual(p.get('client_key'), 'ck');
      if (p.get('grant_type') === 'authorization_code') assert.ok(p.get('code_verifier'));
      return { json: { access_token: `act.${p.get('grant_type')}`, refresh_token: 'rft.2', open_id: 'u1', scope: 'x', expires_in: 86400, refresh_expires_in: 31536000 } };
    }],
    ['/v2/user/info/', async () => ({ json: { data: { user: { open_id: 'u1', display_name: 'Test', follower_count: 1234, following_count: 5, likes_count: 999, video_count: 25 } }, error: { code: 'ok' } } })],
    ['/v2/video/list/', async (u, o) => {
      const body = JSON.parse(o.body);
      const page = body.cursor ? 2 : 1;
      const videos = Array.from({ length: page === 1 ? 20 : 5 }, (_, i) => ({
        id: `v${page}-${i}`, title: '#test', create_time: Math.floor(now / 1000) - i * 3600, duration: 30,
        view_count: 1000 + i, like_count: 50, comment_count: 5, share_count: 1
      }));
      return { json: { data: { videos, cursor: 123, has_more: page === 1 }, error: { code: 'ok' } } };
    }],
    ['/v2/post/publish/creator_info/query/', async () => ({ json: { data: { creator_nickname: 'Test', privacy_level_options: ['SELF_ONLY', 'PUBLIC_TO_EVERYONE'], max_video_post_duration_sec: 600, comment_disabled: false, duet_disabled: true, stitch_disabled: false }, error: { code: 'ok' } } })],
    ['/v2/post/publish/video/init/', async (u, o) => {
      const b = JSON.parse(o.body);
      assert.strictEqual(b.source_info.source, 'FILE_UPLOAD');
      assert.strictEqual(b.post_info.disable_duet, true, 'creator duet_disabled must be enforced');
      return { json: { data: { publish_id: 'p1', upload_url: 'https://upload.test/put' }, error: { code: 'ok' } } };
    }],
    ['upload.test/put', async (u, o) => {
      assert.ok(/^bytes \d+-\d+\/\d+$/.test(o.headers['Content-Range']));
      return { status: 201, json: {} };
    }],
    ['/v2/post/publish/status/fetch/', async () => ({ json: { data: { status: 'PUBLISH_COMPLETE', publicaly_available_post_id: [7300123] }, error: { code: 'ok' } } })]
  ];
  const fetchImpl = mockFetch(routes);
  const client = new TikTokClient({
    getCredentials: () => ({ clientKey: 'ck', clientSecret: 'cs' }),
    loadTokens: () => tokens,
    saveTokens: (t) => { tokens = t; },
    fetchImpl
  });

  await test('token exchange + auto refresh', async () => {
    await client.exchangeCode({ code: 'c', verifier: 'v', redirectUri: 'http://127.0.0.1:3455/callback/' });
    assert.strictEqual(tokens.access_token, 'act.authorization_code');
    tokens.expires_at = Date.now() - 1; // force expiry
    const at = await client.accessToken();
    assert.strictEqual(at, 'act.refresh_token');
  });

  await test('syncAll stores account snapshot and paginated videos', async () => {
    const r = await syncAll(client, db);
    assert.strictEqual(r.videoCount, 25);
    assert.strictEqual(db.get('SELECT COUNT(*) AS n FROM videos').n, 25);
    assert.strictEqual(db.get('SELECT follower_count FROM account_snapshots').follower_count, 1234);
  });

  await test('scheduler uploads due direct post and marks it published', async () => {
    cfg.STATUS_POLL_MS = 10;
    const vid = path.join(tmp, 'clip.mp4');
    fs.writeFileSync(vid, Buffer.alloc(2 * MB, 1));
    db.run(`INSERT INTO scheduled_posts(file_path, title, mode, privacy_level, scheduled_at, status, created_at, updated_at)
            VALUES(?,?,?,?,?, 'pending', ?, ?)`, [vid, 'hello #test', 'direct', 'SELF_ONLY', Date.now() - 1000, Date.now(), Date.now()]);
    let published = null;
    const sch = new Scheduler({ db, client, onPublished: (p) => { published = p; } });
    await sch.tick();
    sch.stop();
    assert.deepStrictEqual(published && published.postIds, ['7300123']);
    const p = db.get('SELECT * FROM scheduled_posts ORDER BY id DESC LIMIT 1');
    assert.strictEqual(p.status, 'published', p.error);
    assert.strictEqual(p.publish_id, 'p1');
  });

  await test('scheduler rejects privacy not offered by creator', async () => {
    const vid = path.join(tmp, 'clip.mp4');
    db.run(`INSERT INTO scheduled_posts(file_path, title, mode, privacy_level, scheduled_at, status, created_at, updated_at)
            VALUES(?,?,?,?,?, 'pending', ?, ?)`, [vid, 'x', 'direct', 'FOLLOWER_OF_CREATOR', Date.now() - 1000, Date.now(), Date.now()]);
    const sch2 = new Scheduler({ db, client });
    await sch2.tick();
    sch2.stop();
    const p = db.get('SELECT * FROM scheduled_posts ORDER BY id DESC LIMIT 1');
    assert.strictEqual(p.status, 'failed');
    assert.ok(/no longer available/.test(p.error));
  });

  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
})();
