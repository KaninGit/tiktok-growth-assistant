'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

const call = (ch) => (...args) => ipcRenderer.invoke(ch, ...args);

contextBridge.exposeInMainWorld('api', {
  getSettings: call('settings:get'),
  saveSettings: call('settings:save'),
  login: call('auth:login'),
  logout: call('auth:logout'),
  sync: call('sync:run'),
  dashboard: call('dashboard:get'),
  videos: call('videos:list'),
  videoHistory: call('videos:history'),
  analytics: call('analytics:get'),
  creatorInfo: call('posts:creatorInfo'),
  posts: call('posts:list'),
  createPost: call('posts:create'),
  cancelPost: call('posts:cancel'),
  retryPost: call('posts:retry'),
  deletePost: call('posts:delete'),
  pickVideo: call('dialog:pickVideo'),
  exportCsv: call('export:csv'),
  openUrl: call('shell:open'),
  setVideoTags: call('videos:setTags'),
  tags: call('tags:list'),
  saveTag: call('tags:save'),
  deleteTag: call('tags:delete'),
  velocity: call('velocity:get'),
  ideas: call('ideas:list'),
  saveIdea: call('ideas:save'),
  deleteIdea: call('ideas:delete'),
  calendar: call('calendar:get'),
  suggestHashtags: call('hashtags:suggest'),
  pathForFile: (file) => webUtils.getPathForFile(file),
  on: (channel, fn) => {
    const allowed = ['posts:updated', 'sync:state', 'velocity:alert'];
    if (!allowed.includes(channel)) return () => {};
    const h = (_e, payload) => fn(payload);
    ipcRenderer.on(channel, h);
    return () => ipcRenderer.removeListener(channel, h);
  }
});
