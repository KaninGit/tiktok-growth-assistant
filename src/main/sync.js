'use strict';

/**
 * Pull account + video stats from TikTok and store snapshots locally.
 * kind 'full' pages through all videos; 'recent' only fetches the newest page
 * (used for frequent early-velocity tracking of new videos).
 */
async function syncAll(client, db, { kind = 'full', limit } = {}) {
  const now = Date.now();
  const user = await client.getUserInfo();
  const openId = user.open_id;

  db.setSetting('account', JSON.stringify(user));
  db.run(`INSERT INTO account_snapshots(open_id, taken_at, follower_count, following_count, likes_count, video_count)
          VALUES(?,?,?,?,?,?)`,
  [openId, now, user.follower_count ?? null, user.following_count ?? null, user.likes_count ?? null, user.video_count ?? null]);

  const videos = await client.listAllVideos(limit || (kind === 'recent' ? 20 : undefined));
  db.transaction(() => {
    for (const v of videos) {
      db.db.run(`INSERT INTO videos(id, open_id, title, description, create_time, duration, cover_image_url, share_url,
                  view_count, like_count, comment_count, share_count, updated_at)
                 VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
                 ON CONFLICT(id) DO UPDATE SET
                   title=excluded.title, description=excluded.description, duration=excluded.duration,
                   cover_image_url=excluded.cover_image_url, share_url=excluded.share_url,
                   view_count=excluded.view_count, like_count=excluded.like_count,
                   comment_count=excluded.comment_count, share_count=excluded.share_count,
                   updated_at=excluded.updated_at`,
      [v.id, openId, v.title || '', v.video_description || '', v.create_time || 0, v.duration || 0,
        v.cover_image_url || '', v.share_url || '',
        v.view_count || 0, v.like_count || 0, v.comment_count || 0, v.share_count || 0, now]);
      db.db.run(`INSERT INTO video_snapshots(video_id, taken_at, view_count, like_count, comment_count, share_count)
                 VALUES(?,?,?,?,?,?)`,
      [v.id, now, v.view_count || 0, v.like_count || 0, v.comment_count || 0, v.share_count || 0]);
    }
  });
  db.run('INSERT OR REPLACE INTO sync_runs(taken_at, kind) VALUES(?, ?)', [now, kind]);
  db.setSetting(kind === 'full' ? 'last_sync' : 'last_recent_sync', now);
  if (kind === 'recent') db.setSetting('last_sync', now);
  return { user, videoCount: videos.length, at: now, kind };
}

module.exports = { syncAll };
