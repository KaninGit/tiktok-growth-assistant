'use strict';

/**
 * TikTok Login Kit for Desktop — Authorization Code + PKCE.
 * TikTok's desktop flow expects code_challenge = HEX(SHA256(code_verifier)) (not base64url).
 * Redirect URI must be registered in the developer portal, e.g. http://127.0.0.1:3455/callback/
 */

const http = require('http');
const crypto = require('crypto');
const { URL } = require('url');
const cfg = require('./config');

const VERIFIER_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';

function randomString(len) {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += VERIFIER_CHARS[bytes[i] % VERIFIER_CHARS.length];
  return out;
}

function makePkce() {
  const verifier = randomString(64);
  const challenge = crypto.createHash('sha256').update(verifier).digest('hex');
  return { verifier, challenge };
}

function redirectUri(port) {
  return `http://127.0.0.1:${port}/callback/`;
}

function buildAuthUrl({ clientKey, port, state, challenge, scopes = cfg.SCOPES }) {
  const u = new URL(cfg.AUTH_URL);
  u.searchParams.set('client_key', clientKey);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', scopes.join(','));
  u.searchParams.set('redirect_uri', redirectUri(port));
  u.searchParams.set('state', state);
  u.searchParams.set('code_challenge', challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  return u.toString();
}

const PAGE = (title, msg) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;background:#111318;color:#eee;display:grid;place-items:center;height:100vh;margin:0}
.c{text-align:center}h1{font-size:20px}</style></head><body><div class="c"><h1>${title}</h1><p>${msg}</p></div></body></html>`;

/**
 * Opens the system browser, waits for the redirect on a loopback server,
 * and resolves with { code, verifier, redirectUri }.
 */
function waitForAuthorization({ clientKey, port, openExternal, timeoutMs = cfg.LOGIN_TIMEOUT_MS }) {
  const { verifier, challenge } = makePkce();
  const state = crypto.randomBytes(16).toString('hex');
  const authUrl = buildAuthUrl({ clientKey, port, state, challenge });

  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (err, val) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      server.close();
      err ? reject(err) : resolve(val);
    };

    const server = http.createServer((req, res) => {
      const u = new URL(req.url, `http://127.0.0.1:${port}`);
      if (!u.pathname.startsWith('/callback')) {
        res.writeHead(404).end();
        return;
      }
      const err = u.searchParams.get('error');
      const code = u.searchParams.get('code');
      const gotState = u.searchParams.get('state');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });

      if (err) {
        res.end(PAGE('Login cancelled', 'You can close this tab and return to the app.'));
        return finish(new Error(`TikTok authorization error: ${err} ${u.searchParams.get('error_description') || ''}`.trim()));
      }
      if (!code || gotState !== state) {
        res.end(PAGE('Login failed', 'Invalid response (state mismatch). Please try again.'));
        return finish(new Error('Invalid OAuth callback (missing code or state mismatch)'));
      }
      res.end(PAGE('Connected ✓', 'Login successful. You can close this tab and return to TikTok Growth Assistant.'));
      finish(null, { code: decodeURIComponent(code), verifier, redirectUri: redirectUri(port) });
    });

    server.on('error', (e) => finish(e.code === 'EADDRINUSE'
      ? new Error(`Port ${port} is already in use. Change the redirect port in Settings (and in the TikTok developer portal).`)
      : e));

    const timer = setTimeout(() => finish(new Error('Login timed out')), timeoutMs);

    server.listen(port, '127.0.0.1', () => openExternal(authUrl));
  });
}

module.exports = { makePkce, buildAuthUrl, redirectUri, waitForAuthorization };
