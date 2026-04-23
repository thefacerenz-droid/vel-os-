const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

loadEnv(path.join(__dirname, ".env"));

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = __dirname;
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
const sessions = new Map();
let spotifyToken = null;

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".webm": "video/webm"
};

function loadEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index === -1) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, "");
    if (!process.env[key]) process.env[key] = value;
  }
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

function sendRedirect(res, location) {
  res.writeHead(302, { Location: location });
  res.end();
}

function parseCookies(req) {
  return Object.fromEntries(
    (req.headers.cookie || "")
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf("=");
        return [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
      })
  );
}

function signSessionId(id) {
  return crypto.createHmac("sha256", SESSION_SECRET).update(id).digest("base64url");
}

function encodeSessionCookie(id) {
  return `${id}.${signSessionId(id)}`;
}

function decodeSessionCookie(value) {
  const [id, signature] = String(value || "").split(".");
  if (!id || !signature) return "";
  const expected = signSessionId(id);
  const signatureBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (signatureBuffer.length !== expectedBuffer.length) return "";
  return crypto.timingSafeEqual(signatureBuffer, expectedBuffer) ? id : "";
}

function getSession(req, res) {
  const cookies = parseCookies(req);
  let id = decodeSessionCookie(cookies.velos_session);
  if (!id || !sessions.has(id)) {
    id = crypto.randomBytes(24).toString("hex");
    sessions.set(id, {});
    res.setHeader(
      "Set-Cookie",
      `velos_session=${encodeURIComponent(encodeSessionCookie(id))}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000${process.env.NODE_ENV === "production" ? "; Secure" : ""}`
    );
  }
  return sessions.get(id);
}

function cleanQuery(value, fallback = "") {
  return String(value || fallback).trim().slice(0, 160);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function handleYoutubeSearch(req, res, url) {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) {
    return sendJson(res, 503, {
      error: "missing_config",
      message: "Set YOUTUBE_API_KEY in .env to enable YouTube search."
    });
  }

  const q = cleanQuery(url.searchParams.get("q"), "music");
  const pageToken = cleanQuery(url.searchParams.get("pageToken"));
  const params = new URLSearchParams({
    part: "snippet",
    type: "video",
    maxResults: "12",
    safeSearch: "moderate",
    q,
    key
  });
  if (pageToken) params.set("pageToken", pageToken);

  const response = await fetch(`https://www.googleapis.com/youtube/v3/search?${params}`);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    return sendJson(res, response.status, {
      error: data.error?.errors?.[0]?.reason || "youtube_error",
      message: data.error?.message || "YouTube search failed."
    });
  }

  sendJson(res, 200, {
    items: (data.items || []).map((item) => ({
      id: item.id?.videoId,
      title: item.snippet?.title,
      channel: item.snippet?.channelTitle,
      thumbnail:
        item.snippet?.thumbnails?.high?.url ||
        item.snippet?.thumbnails?.medium?.url ||
        item.snippet?.thumbnails?.default?.url ||
        "",
      publishedAt: item.snippet?.publishedAt
    })).filter((item) => item.id),
    nextPageToken: data.nextPageToken || ""
  });
}

async function getSpotifyToken() {
  if (spotifyToken && spotifyToken.expiresAt > Date.now() + 30000) {
    return spotifyToken.accessToken;
  }

  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    const error = new Error("Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET in .env.");
    error.code = "missing_config";
    throw error;
  }

  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const response = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({ grant_type: "client_credentials" })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error_description || "Spotify token request failed.");
    error.code = data.error || "spotify_auth_error";
    throw error;
  }

  spotifyToken = {
    accessToken: data.access_token,
    expiresAt: Date.now() + Number(data.expires_in || 3600) * 1000
  };
  return spotifyToken.accessToken;
}

async function handleSpotifySearch(req, res, url) {
  try {
    const q = cleanQuery(url.searchParams.get("q"), "lofi");
    const type = cleanQuery(url.searchParams.get("type"), "track,artist,album,playlist")
      .split(",")
      .map((item) => item.trim())
      .filter((item) => ["track", "artist", "album", "playlist"].includes(item))
      .join(",") || "track";
    const token = await getSpotifyToken();
    const params = new URLSearchParams({ q, type, limit: "12", market: "US" });
    const response = await fetch(`https://api.spotify.com/v1/search?${params}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      return sendJson(res, response.status, {
        error: data.error?.status || "spotify_error",
        message: data.error?.message || "Spotify search failed."
      });
    }
    sendJson(res, 200, normalizeSpotifySearch(data));
  } catch (error) {
    sendJson(res, error.code === "missing_config" ? 503 : 500, {
      error: error.code || "spotify_error",
      message: error.message
    });
  }
}

function imageOf(item) {
  return item.images?.[0]?.url || item.album?.images?.[0]?.url || "";
}

function normalizeSpotifySearch(data) {
  const mapItems = (collection, type) =>
    (collection?.items || []).filter(Boolean).map((item) => ({
      id: item.id,
      type,
      title: item.name,
      subtitle:
        type === "track"
          ? item.artists?.map((artist) => artist.name).join(", ")
          : type === "artist"
            ? `${item.followers?.total?.toLocaleString?.() || 0} followers`
            : item.artists?.map((artist) => artist.name).join(", ") || item.owner?.display_name || "Spotify",
      image: imageOf(item),
      uri: item.uri,
      externalUrl: item.external_urls?.spotify || "",
      playable: type !== "artist"
    }));

  return {
    tracks: mapItems(data.tracks, "track"),
    artists: mapItems(data.artists, "artist"),
    albums: mapItems(data.albums, "album"),
    playlists: mapItems(data.playlists, "playlist")
  };
}

function tiktokConfigured() {
  return Boolean(process.env.TIKTOK_CLIENT_KEY && process.env.TIKTOK_CLIENT_SECRET && process.env.TIKTOK_REDIRECT_URI);
}

async function handleTikTokAuthStart(req, res) {
  if (!tiktokConfigured()) {
    return sendJson(res, 503, {
      error: "missing_config",
      message: "Set TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET, and TIKTOK_REDIRECT_URI in .env."
    });
  }
  const session = getSession(req, res);
  session.tiktokState = crypto.randomBytes(24).toString("hex");
  const params = new URLSearchParams({
    client_key: process.env.TIKTOK_CLIENT_KEY,
    scope: "user.info.basic,video.list",
    response_type: "code",
    redirect_uri: process.env.TIKTOK_REDIRECT_URI,
    state: session.tiktokState
  });
  sendRedirect(res, `https://www.tiktok.com/v2/auth/authorize/?${params}`);
}

async function handleTikTokCallback(req, res, url) {
  const session = getSession(req, res);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state || state !== session.tiktokState) {
    res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
    res.end("<h1>TikTok auth failed</h1><p>Missing or invalid OAuth state.</p>");
    return;
  }

  const body = new URLSearchParams({
    client_key: process.env.TIKTOK_CLIENT_KEY,
    client_secret: process.env.TIKTOK_CLIENT_SECRET,
    code,
    grant_type: "authorization_code",
    redirect_uri: process.env.TIKTOK_REDIRECT_URI
  });
  const response = await fetch("https://open.tiktokapis.com/v2/oauth/token/", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.error) {
    res.writeHead(502, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<h1>TikTok auth failed</h1><p>${data.error_description || data.message || "Token exchange failed."}</p>`);
    return;
  }

  session.tiktok = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + Number(data.expires_in || 86400) * 1000,
    openId: data.open_id
  };
  sendRedirect(res, "/?media=tiktok");
}

async function refreshTikTokToken(session) {
  if (!session.tiktok) return null;
  if (session.tiktok.expiresAt > Date.now() + 60000) return session.tiktok.accessToken;
  if (!session.tiktok.refreshToken) return null;

  const response = await fetch("https://open.tiktokapis.com/v2/oauth/token/", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_key: process.env.TIKTOK_CLIENT_KEY,
      client_secret: process.env.TIKTOK_CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token: session.tiktok.refreshToken
    })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.error) return null;
  session.tiktok.accessToken = data.access_token;
  session.tiktok.refreshToken = data.refresh_token || session.tiktok.refreshToken;
  session.tiktok.expiresAt = Date.now() + Number(data.expires_in || 86400) * 1000;
  return session.tiktok.accessToken;
}

async function requireTikTokToken(req, res) {
  const session = getSession(req, res);
  const token = await refreshTikTokToken(session);
  if (!token) {
    sendJson(res, 401, {
      error: "auth_required",
      message: "Connect TikTok to show profile and recent videos."
    });
    return null;
  }
  return token;
}

async function handleTikTokProfile(req, res) {
  if (!tiktokConfigured()) {
    return sendJson(res, 503, { error: "missing_config", message: "TikTok credentials are not configured." });
  }
  const token = await requireTikTokToken(req, res);
  if (!token) return;
  const fields = "open_id,avatar_url,display_name,bio_description,profile_deep_link,is_verified,username";
  const response = await fetch(`https://open.tiktokapis.com/v2/user/info/?fields=${encodeURIComponent(fields)}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const data = await response.json().catch(() => ({}));
  const apiError = data.error && data.error.code !== "ok";
  if (!response.ok || apiError) {
    return sendJson(res, response.status || 502, {
      error: data.error?.code || "tiktok_error",
      message: data.error?.message || "TikTok profile request failed."
    });
  }
  sendJson(res, 200, data.data?.user || {});
}

async function handleTikTokVideos(req, res, url) {
  if (!tiktokConfigured()) {
    return sendJson(res, 503, { error: "missing_config", message: "TikTok credentials are not configured." });
  }
  const token = await requireTikTokToken(req, res);
  if (!token) return;
  const fields = "id,title,video_description,duration,cover_image_url,embed_link,share_url,create_time";
  const cursor = Number(url.searchParams.get("cursor") || 0);
  const response = await fetch(`https://open.tiktokapis.com/v2/video/list/?fields=${encodeURIComponent(fields)}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ max_count: 20, cursor })
  });
  const data = await response.json().catch(() => ({}));
  const apiError = data.error && data.error.code !== "ok";
  if (!response.ok || apiError) {
    return sendJson(res, response.status || 502, {
      error: data.error?.code || "tiktok_error",
      message: data.error?.message || "TikTok video request failed."
    });
  }
  sendJson(res, 200, data.data || { videos: [] });
}

function serveStatic(req, res, url) {
  const requestedPath = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
  const filePath = path.resolve(PUBLIC_DIR, `.${requestedPath}`);
  if (!filePath.startsWith(PUBLIC_DIR) || filePath.includes(`${path.sep}.env`)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.stat(filePath, (error, stat) => {
    if (error || !stat.isFile()) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
      "Cache-Control": ext === ".html" ? "no-store" : "public, max-age=3600"
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || `localhost:${PORT}`}`);
  try {
    if (req.method === "GET" && url.pathname === "/api/youtube/search") return await handleYoutubeSearch(req, res, url);
    if (req.method === "GET" && url.pathname === "/api/spotify/search") return await handleSpotifySearch(req, res, url);
    if (req.method === "GET" && url.pathname === "/api/tiktok/auth/start") return await handleTikTokAuthStart(req, res);
    if (req.method === "GET" && url.pathname === "/api/tiktok/auth/callback") return await handleTikTokCallback(req, res, url);
    if (req.method === "GET" && url.pathname === "/api/tiktok/profile") return await handleTikTokProfile(req, res);
    if (req.method === "GET" && url.pathname === "/api/tiktok/videos") return await handleTikTokVideos(req, res, url);
    if (url.pathname.startsWith("/api/")) return sendJson(res, 404, { error: "not_found", message: "API route not found." });
    return serveStatic(req, res, url);
  } catch (error) {
    sendJson(res, 500, { error: "server_error", message: error.message || "Unexpected server error." });
  }
}

http.createServer(handleRequest).listen(PORT, () => {
  console.log(`vel.os running at http://localhost:${PORT}`);
});
