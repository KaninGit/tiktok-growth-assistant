'use strict';

// Official TikTok for Developers endpoints (API v2).
module.exports = {
  AUTH_URL: 'https://www.tiktok.com/v2/auth/authorize/',
  API_BASE: 'https://open.tiktokapis.com',

  // Scopes must also be enabled for your app in the TikTok developer portal.
  SCOPES: [
    'user.info.basic',
    'user.info.profile',
    'user.info.stats',
    'video.list',
    'video.publish', // Direct Post
    'video.upload'   // Upload to TikTok inbox as draft
  ],

  USER_FIELDS: [
    'open_id', 'union_id', 'avatar_url', 'display_name', 'username',
    'bio_description', 'profile_deep_link', 'is_verified',
    'follower_count', 'following_count', 'likes_count', 'video_count'
  ],

  VIDEO_FIELDS: [
    'id', 'title', 'video_description', 'create_time', 'duration',
    'cover_image_url', 'share_url', 'embed_link',
    'view_count', 'like_count', 'comment_count', 'share_count'
  ],

  DEFAULT_PORT: 3455,           // redirect: http://127.0.0.1:<port>/callback/
  LOGIN_TIMEOUT_MS: 5 * 60 * 1000,
  MAX_VIDEOS_SYNC: 500,
  AUTO_SYNC_INTERVAL_MS: 6 * 60 * 60 * 1000,
  RECENT_SYNC_INTERVAL_MS: 20 * 60 * 1000,   // fast sync while a video is < 48h old
  RECENT_WINDOW_MS: 48 * 60 * 60 * 1000,
  ATTRIBUTION_WINDOW_MS: 90 * 24 * 60 * 60 * 1000,
  DEFAULT_POSTS_PER_WEEK: 4,
  SCHEDULER_TICK_MS: 30 * 1000,
  STATUS_POLL_MS: 5000,
  STATUS_POLL_MAX_MS: 15 * 60 * 1000
};
