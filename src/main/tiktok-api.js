'use strict';

const fs = require('fs');
const path = require('path');
const cfg = require('./config');

class TikTokApiError extends Error {
  constructor(message, { code, logId, status } = {}) {
    super(message);
    this.name = 'TikTokApiError';
    this.code = code;
    this.logId = logId;
    this.status = status;
  }
}

const MB = 1024 * 1024;
const MIN_CHUNK = 5 * MB;
const MAX_SINGLE = 64 * MB;
const CHUNK = 10 * MB;

/**
 * TikTok chunk rules: files < 5MB (and here ≤ 64MB) go as one chunk.
 * Otherwise chunks are 5–64MB, total_chunk_count = floor(size / chunk_size),
 * and the last chunk absorbs the remainder (may be up to 128MB).
 */
function planChunks(size) {
  if (size <= MAX_SINGLE) return { chunkSize: size, count: 1 };
  const count = Math.floor(size / CHUNK);
  return { chunkSize: CHUNK, count };
}

function chunkRanges(size) {
  const { chunkSize, count } = planChunks(size);
  const ranges = [];
  for (let i = 0; i < count; i++) {
    const start = i * chunkSize;
    const end = i === count - 1 ? size - 1 : start + chunkSize - 1;
    ranges.push({ start, end });
  }
  return ranges;
}

function mimeFor(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.mov') return 'video/quicktime';
  if (ext === '.webm') return 'video/webm';
  return 'video/mp4';
}

class TikTokClient {
  /**
   * @param {object} o
   * @param {() => {clientKey:string, clientSecret:string}} o.getCredentials
   * @param {() => object|null} o.loadTokens
   * @param {(t:object|null) => void} o.saveTokens
   */
  constructor({ getCredentials, loadTokens, saveTokens, fetchImpl = globalThis.fetch }) {
    this.getCredentials = getCredentials;
    this.loadTokens = loadTokens;
    this.saveTokens = saveTokens;
    this.fetch = fetchImpl;
    this._refreshing = null;
  }

  // ---------------- OAuth ----------------
  async _tokenRequest(params) {
    const { clientKey, clientSecret } = this.getCredentials();
    if (!clientKey || !clientSecret) throw new Error('Client key / secret not configured');
    const body = new URLSearchParams({ client_key: clientKey, client_secret: clientSecret, ...params });
    const res = await this.fetch(`${cfg.API_BASE}/v2/oauth/token/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cache-Control': 'no-cache' },
      body
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.error) {
      throw new TikTokApiError(json.error_description || json.error || `Token request failed (${res.status})`,
        { code: json.error, logId: json.log_id, status: res.status });
    }
    const now = Date.now();
    const tokens = {
      access_token: json.access_token,
      refresh_token: json.refresh_token,
      open_id: json.open_id,
      scope: json.scope,
      expires_at: now + json.expires_in * 1000,
      refresh_expires_at: now + json.refresh_expires_in * 1000
    };
    this.saveTokens(tokens);
    return tokens;
  }

  exchangeCode({ code, verifier, redirectUri }) {
    return this._tokenRequest({
      code, grant_type: 'authorization_code', redirect_uri: redirectUri, code_verifier: verifier
    });
  }

  async _refresh() {
    const t = this.loadTokens();
    if (!t || !t.refresh_token) throw new Error('Not logged in');
    if (t.refresh_expires_at && Date.now() > t.refresh_expires_at) {
      this.saveTokens(null);
      throw new Error('Session expired, please log in again');
    }
    // The returned refresh_token may differ — _tokenRequest always stores the new one.
    return this._tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh_token });
  }

  async accessToken() {
    const t = this.loadTokens();
    if (!t) throw new Error('Not logged in');
    if (Date.now() < t.expires_at - 60_000) return t.access_token;
    if (!this._refreshing) this._refreshing = this._refresh().finally(() => { this._refreshing = null; });
    return (await this._refreshing).access_token;
  }

  async revoke() {
    const t = this.loadTokens();
    if (t) {
      const { clientKey, clientSecret } = this.getCredentials();
      try {
        await this.fetch(`${cfg.API_BASE}/v2/oauth/revoke/`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ client_key: clientKey, client_secret: clientSecret, token: t.access_token })
        });
      } catch { /* best effort */ }
    }
    this.saveTokens(null);
  }

  // ---------------- Generic call ----------------
  async call(method, apiPath, { query, body, retry = true } = {}) {
    const token = await this.accessToken();
    const url = new URL(cfg.API_BASE + apiPath);
    if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    const res = await this.fetch(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=UTF-8' },
      body: body ? JSON.stringify(body) : undefined
    });
    const json = await res.json().catch(() => ({}));
    const err = json.error || {};
    if (res.status === 401 && retry) {
      // token may have been revoked/rotated — force a refresh once
      const t = this.loadTokens();
      if (t) this.saveTokens({ ...t, expires_at: 0 });
      return this.call(method, apiPath, { query, body, retry: false });
    }
    if (!res.ok || (err.code && err.code !== 'ok')) {
      throw new TikTokApiError(err.message || `TikTok API error (${res.status})`,
        { code: err.code, logId: err.log_id, status: res.status });
    }
    return json.data;
  }

  // ---------------- Display API ----------------
  async getUserInfo() {
    const data = await this.call('GET', '/v2/user/info/', { query: { fields: cfg.USER_FIELDS.join(',') } });
    return data.user;
  }

  async listAllVideos(limit = cfg.MAX_VIDEOS_SYNC) {
    const out = [];
    let cursor;
    while (out.length < limit) {
      const body = { max_count: 20 };
      if (cursor) body.cursor = cursor;
      const data = await this.call('POST', '/v2/video/list/', {
        query: { fields: cfg.VIDEO_FIELDS.join(',') }, body
      });
      out.push(...(data.videos || []));
      if (!data.has_more || !data.cursor) break;
      cursor = data.cursor;
    }
    return out.slice(0, limit);
  }

  // ---------------- Content Posting API ----------------
  async creatorInfo() {
    return this.call('POST', '/v2/post/publish/creator_info/query/', { body: {} });
  }

  async _uploadFile(uploadUrl, filePath, size, onProgress) {
    const fh = await fs.promises.open(filePath, 'r');
    try {
      const ranges = chunkRanges(size);
      let sent = 0;
      for (const { start, end } of ranges) {
        const len = end - start + 1;
        const buf = Buffer.alloc(len);
        await fh.read(buf, 0, len, start);
        const res = await this.fetch(uploadUrl, {
          method: 'PUT',
          headers: {
            'Content-Type': mimeFor(filePath),
            'Content-Length': String(len),
            'Content-Range': `bytes ${start}-${end}/${size}`
          },
          body: buf
        });
        if (![200, 201, 206].includes(res.status)) {
          const txt = await res.text().catch(() => '');
          throw new TikTokApiError(`Upload failed at bytes ${start}-${end}: HTTP ${res.status} ${txt}`.trim(), { status: res.status });
        }
        sent += len;
        onProgress && onProgress(sent / size);
      }
    } finally {
      await fh.close();
    }
  }

  _sourceInfo(size) {
    const { chunkSize, count } = planChunks(size);
    return { source: 'FILE_UPLOAD', video_size: size, chunk_size: chunkSize, total_chunk_count: count };
  }

  /** Direct Post (scope video.publish). Unaudited apps can only post with privacy SELF_ONLY. */
  async directPostFile(filePath, postInfo, onProgress) {
    const size = (await fs.promises.stat(filePath)).size;
    const data = await this.call('POST', '/v2/post/publish/video/init/', {
      body: { post_info: postInfo, source_info: this._sourceInfo(size) }
    });
    await this._uploadFile(data.upload_url, filePath, size, onProgress);
    return data.publish_id;
  }

  /** Upload to the creator's TikTok inbox as a draft (scope video.upload). */
  async inboxUploadFile(filePath, onProgress) {
    const size = (await fs.promises.stat(filePath)).size;
    const data = await this.call('POST', '/v2/post/publish/inbox/video/init/', {
      body: { source_info: this._sourceInfo(size) }
    });
    await this._uploadFile(data.upload_url, filePath, size, onProgress);
    return data.publish_id;
  }

  fetchPublishStatus(publishId) {
    return this.call('POST', '/v2/post/publish/status/fetch/', { body: { publish_id: publishId } });
  }
}

module.exports = { TikTokClient, TikTokApiError, planChunks, chunkRanges };
