'use strict';

const fs = require('fs');
const cfg = require('./config');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Posts queued videos when they are due. Runs only while the app is open
 * (the app keeps running in the system tray when the window is closed).
 */
class Scheduler {
  constructor({ db, client, onChange = () => {}, notify = () => {}, onPublished = () => {} }) {
    this.db = db;
    this.client = client;
    this.onChange = onChange;
    this.notify = notify;
    this.onPublished = onPublished;
    this.timer = null;
    this.busy = false;
  }

  start() {
    // Uploads interrupted by an app exit cannot be resumed (upload_url expires) — mark them failed.
    this.db.run(`UPDATE scheduled_posts SET status='failed', error='Interrupted (app closed during upload). Retry to post again.',
                 updated_at=? WHERE status IN ('uploading')`, [Date.now()]);
    this.timer = setInterval(() => this.tick(), cfg.SCHEDULER_TICK_MS);
    setTimeout(() => this.tick(), 3000);
  }

  stop() {
    this.stopped = true;
    clearInterval(this.timer);
  }

  update(id, fields) {
    const keys = Object.keys(fields);
    this.db.run(`UPDATE scheduled_posts SET ${keys.map((k) => `${k}=?`).join(', ')}, updated_at=? WHERE id=?`,
      [...keys.map((k) => fields[k]), Date.now(), id]);
    this.onChange();
  }

  async tick() {
    if (this.busy || this.stopped) return;
    let due;
    try {
      due = this.db.get(`SELECT * FROM scheduled_posts WHERE status='pending' AND scheduled_at <= ?
                         ORDER BY scheduled_at LIMIT 1`, [Date.now()]);
    } catch (e) {
      console.error('scheduler tick failed', e);
      return;
    }
    if (!due) return;
    this.busy = true;
    try {
      await this.process(due);
    } finally {
      this.busy = false;
    }
    if (!this.stopped) setTimeout(() => this.tick(), 1000); // drain the queue
  }

  async process(post) {
    try {
      if (!fs.existsSync(post.file_path)) throw new Error(`File not found: ${post.file_path}`);
      this.update(post.id, { status: 'uploading', progress: 0, error: null });

      let publishId;
      if (post.mode === 'inbox') {
        publishId = await this.client.inboxUploadFile(post.file_path, (p) => this.update(post.id, { progress: p }));
      } else {
        // Re-check creator settings right before posting (required by TikTok's Direct Post guidelines).
        const info = await this.client.creatorInfo();
        const options = info.privacy_level_options || [];
        if (!options.includes(post.privacy_level)) {
          throw new Error(`Privacy "${post.privacy_level}" is no longer available for this account (allowed: ${options.join(', ')})`);
        }
        if (post.duration_sec && info.max_video_post_duration_sec && post.duration_sec > info.max_video_post_duration_sec) {
          throw new Error(`Video is ${Math.round(post.duration_sec)}s; account limit is ${info.max_video_post_duration_sec}s`);
        }
        const postInfo = {
          title: post.title || '',
          privacy_level: post.privacy_level,
          disable_comment: !!post.disable_comment || !!info.comment_disabled,
          disable_duet: !!post.disable_duet || !!info.duet_disabled,
          disable_stitch: !!post.disable_stitch || !!info.stitch_disabled,
          brand_content_toggle: !!post.brand_content_toggle,
          brand_organic_toggle: !!post.brand_organic_toggle
        };
        publishId = await this.client.directPostFile(post.file_path, postInfo, (p) => this.update(post.id, { progress: p }));
      }

      this.update(post.id, { status: 'processing', publish_id: publishId, progress: 1 });
      const final = await this.pollStatus(publishId);
      if (final.status === 'FAILED') throw new Error(`TikTok processing failed: ${final.fail_reason || 'unknown'}`);
      if (final.status === 'TIMEOUT') {
        this.update(post.id, { error: 'Uploaded; TikTok is still processing. Check the TikTok app.' });
        return;
      }
      const status = final.status === 'SEND_TO_USER_INBOX' ? 'inbox' : 'published';
      // TikTok returns the public post id(s) (field name is spelled this way in the API).
      const postIds = (final.publicaly_available_post_id || final.publicly_available_post_id || []).map(String);
      this.update(post.id, { status, post_ids: postIds.length ? JSON.stringify(postIds) : null });
      try { this.onPublished({ ...post, status, postIds }); } catch (e) { console.error('onPublished failed', e); }
      this.notify(status === 'inbox' ? 'Sent to TikTok inbox' : 'Video posted', post.title || post.file_path);
    } catch (e) {
      this.update(post.id, { status: 'failed', error: `${e.message}${e.logId ? ` (log_id ${e.logId})` : ''}` });
      this.notify('Post failed', e.message);
    }
  }

  async pollStatus(publishId) {
    const deadline = Date.now() + cfg.STATUS_POLL_MAX_MS;
    let last = {};
    while (Date.now() < deadline) {
      await sleep(cfg.STATUS_POLL_MS);
      try {
        last = await this.client.fetchPublishStatus(publishId);
      } catch (e) {
        if (e.status === 429) continue;
        throw e;
      }
      if (['PUBLISH_COMPLETE', 'SEND_TO_USER_INBOX', 'FAILED'].includes(last.status)) return last;
    }
    return { ...last, status: 'TIMEOUT' };
  }
}

module.exports = { Scheduler };
