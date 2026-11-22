/**
 * Privet bot project 01 — Private WhatsApp View-Once Saver Bot
 *
 * Features:
 * - Baileys v7 (ESM) + latest WhatsApp Web protocol version
 * - Pairing Code & QR Code authentication via Web Dashboard
 * - Auto-restores saved sessions on server restart
 * - Saves ONLY View-Once (One-Time) Image, Video, and Audio to your Private Chat
 *   when YOU reply with "." + any word (e.g., .vv, .ok, .save, .a)
 * - ".ping" command showing bot speed (ms) ONLY
 * - Zero error messages sent to any WhatsApp chat
 * - Never shows 24/7 Online (markOnlineOnConnect: false + unavailable presence)
 */

import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import pino from "pino";
import QRCode from "qrcode";
import makeWASocket, {
  Browsers,
  DisconnectReason,
  downloadContentFromMessage,
  fetchLatestBaileysVersion,
  jidNormalizedUser,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
} from "@whiskeysockets/baileys";

// ============================================================================
// Global Crash Protection (Never crash the Node.js process on socket errors)
// ============================================================================
process.on("uncaughtException", () => {});
process.on("unhandledRejection", () => {});

// ============================================================================
// Paths & Configuration
// ============================================================================
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 3000;
const SESSIONS_DIR = path.join(__dirname, "sessions");
const MAX_VIEW_ONCE_CACHE = 400;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

if (!fs.existsSync(SESSIONS_DIR)) {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

// Completely silent Baileys logger to prevent noisy protocol logs
const silentLogger = pino({ level: "silent" });

// Active sessions registry: Map<safeUsername, SessionRecord>
const sessions = new Map();

// Cached WhatsApp Web version to avoid unnecessary network calls on rapid connects
let cachedWaVersion = null;
let cachedWaVersionAt = 0;

/**
 * Fetch the latest supported WhatsApp Web protocol version (cached for 6 hours).
 */
async function getWaVersion() {
  const SIX_HOURS = 6 * 60 * 60 * 1000;
  if (cachedWaVersion && Date.now() - cachedWaVersionAt < SIX_HOURS) {
    return cachedWaVersion;
  }
  try {
    const { version } = await fetchLatestBaileysVersion();
    cachedWaVersion = version;
    cachedWaVersionAt = Date.now();
    return version;
  } catch {
    // Fallback if WhatsApp version endpoint is temporarily unreachable
    return cachedWaVersion || [2, 3000, 1025190524];
  }
}

/**
 * Sanitize bot username so it is safe to use as a folder name.
 */
function sanitizeUsername(raw) {
  return String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "")
    .slice(0, 40);
}

/**
 * Sanitize phone number to digits only (country code + number).
 */
function sanitizePhone(raw) {
  return String(raw || "").replace(/\D/g, "");
}

/**
 * Format 8-character WhatsApp pairing code cleanly as XXXX-XXXX.
 */
function formatPairingCode(code) {
  const clean = String(code || "").replace(/[^A-Za-z0-9]/g, "");
  return clean.match(/.{1,4}/g)?.join("-") || clean;
}

/**
 * Safely delete a directory recursively.
 */
function removeDirSafe(dirPath) {
  try {
    if (fs.existsSync(dirPath)) {
      fs.rmSync(dirPath, { recursive: true, force: true });
    }
  } catch {}
}

/**
 * Check whether a session directory already contains a registered creds.json.
 */
function hasRegisteredCreds(sessionDir) {
  try {
    const credsPath = path.join(sessionDir, "creds.json");
    if (!fs.existsSync(credsPath)) return false;
    const raw = JSON.parse(fs.readFileSync(credsPath, "utf8"));
    return Boolean(raw?.registered);
  } catch {
    return false;
  }
}

// ============================================================================
// Message Unwrapping & View-Once Extraction Helpers
// ============================================================================

/**
 * Unwrap nested WhatsApp message containers (ephemeral / edited / viewOnce).
 */
function unwrapMessageContainer(message) {
  let current = message;
  for (let i = 0; i < 6 && current; i++) {
    if (current.ephemeralMessage?.message) {
      current = current.ephemeralMessage.message;
      continue;
    }
    if (current.documentWithCaptionMessage?.message) {
      current = current.documentWithCaptionMessage.message;
      continue;
    }
    if (current.editedMessage?.message) {
      current = current.editedMessage.message;
      continue;
    }
    break;
  }
  return current || null;
}

/**
 * Extract plain text content from a WhatsApp message object.
 */
function extractMessageText(rawMessage) {
  const msg = unwrapMessageContainer(rawMessage);
  if (!msg) return "";
  return (
    msg.conversation ||
    msg.extendedTextMessage?.text ||
    msg.imageMessage?.caption ||
    msg.videoMessage?.caption ||
    ""
  ).trim();
}

/**
 * Extract contextInfo (quoted reply metadata) from a WhatsApp message object.
 */
function extractContextInfo(rawMessage) {
  const msg = unwrapMessageContainer(rawMessage);
  if (!msg) return null;
  return (
    msg.extendedTextMessage?.contextInfo ||
    msg.imageMessage?.contextInfo ||
    msg.videoMessage?.contextInfo ||
    msg.audioMessage?.contextInfo ||
    msg.documentMessage?.contextInfo ||
    null
  );
}

/**
 * Detect and extract ONLY View-Once (One-Time) Image, Video, or Audio payloads.
 * Supports all WhatsApp protobuf representations:
 * - viewOnceMessageV2
 * - viewOnceMessageV2Extension (commonly used for View-Once voice notes/audio)
 * - viewOnceMessage (legacy)
 * - direct imageMessage/videoMessage/audioMessage with `viewOnce: true`
 */
function extractViewOnceMedia(rawMessage) {
  if (!rawMessage || typeof rawMessage !== "object") return null;

  const unwrapped = unwrapMessageContainer(rawMessage);
  if (!unwrapped) return null;

  // Case 1: Explicit View-Once wrapper containers
  const wrappedInner =
    unwrapped.viewOnceMessageV2?.message ||
    unwrapped.viewOnceMessageV2Extension?.message ||
    unwrapped.viewOnceMessage?.message ||
    null;

  if (wrappedInner) {
    if (wrappedInner.imageMessage) {
      return { type: "image", media: wrappedInner.imageMessage };
    }
    if (wrappedInner.videoMessage) {
      return { type: "video", media: wrappedInner.videoMessage };
    }
    if (wrappedInner.audioMessage) {
      return { type: "audio", media: wrappedInner.audioMessage };
    }
    return null;
  }

  // Case 2: Direct media object flagged with viewOnce: true
  if (unwrapped.imageMessage?.viewOnce) {
    return { type: "image", media: unwrapped.imageMessage };
  }
  if (unwrapped.videoMessage?.viewOnce) {
    return { type: "video", media: unwrapped.videoMessage };
  }
  if (unwrapped.audioMessage?.viewOnce) {
    return { type: "audio", media: unwrapped.audioMessage };
  }

  return null;
}

/**
 * Verify that a media payload contains the cryptographic key & path required to download.
 */
function isDownloadableMedia(mediaObj) {
  return Boolean(mediaObj && mediaObj.mediaKey && (mediaObj.directPath || mediaObj.url));
}

/**
 * Download a Baileys media object into a Buffer using downloadContentFromMessage.
 */
async function downloadMediaToBuffer(mediaObj, mediaType) {
  const stream = await downloadContentFromMessage(mediaObj, mediaType);
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * Store a View-Once message metadata entry in the per-session bounded cache.
 * This ensures extraction still succeeds even if WhatsApp strips the quoted payload.
 */
function cacheViewOnce(session, msgId, extracted) {
  if (!msgId || !extracted || !isDownloadableMedia(extracted.media)) return;

  const now = Date.now();
  session.viewOnceCache.set(msgId, {
    type: extracted.type,
    media: extracted.media,
    savedAt: now,
  });

  // Evict expired or oldest entries to keep memory minimal
  if (session.viewOnceCache.size > MAX_VIEW_ONCE_CACHE) {
    for (const [key, entry] of session.viewOnceCache) {
      if (now - entry.savedAt > CACHE_TTL_MS || session.viewOnceCache.size > MAX_VIEW_ONCE_CACHE) {
        session.viewOnceCache.delete(key);
      }
      if (session.viewOnceCache.size <= MAX_VIEW_ONCE_CACHE) break;
    }
  }
}

// ============================================================================
// Core Bot Command & Message Handler (100% Silent on Errors)
// ============================================================================

/**
 * Handle incoming & outgoing WhatsApp messages for a session.
 * Strictly owner-only (fromMe), silent on all errors, never sends online presence.
 */
async function handleIncomingMessage(session, sock, msg) {
  try {
    if (!msg?.message || !msg?.key) return;
    if (msg.key.remoteJid === "status@broadcast") return;

    // 1. Quietly cache any View-Once image/video/audio arriving in any chat
    //    so replying later always succeeds even if already viewed.
    const incomingViewOnce = extractViewOnceMedia(msg.message);
    if (incomingViewOnce) {
      cacheViewOnce(session, msg.key.id, incomingViewOnce);
    }

    // 2. Private Bot Guard: ONLY respond to commands sent by the linked account owner
    if (!msg.key.fromMe) return;

    const text = extractMessageText(msg.message);
    if (!text || !text.startsWith(".")) return;

    const chatJid = msg.key.remoteJid;
    if (!chatJid) return;

    // 3. Check if replying to a View-Once (One-Time) Image, Video, or Audio
    //    Command rule: "." followed by ANY word (e.g. .a, .ok, .vv, .save, .හරි)
    const contextInfo = extractContextInfo(msg.message);
    const isDotWordCommand = /^\.\S+/.test(text);

    if (isDotWordCommand && contextInfo) {
      let viewOnce = extractViewOnceMedia(contextInfo.quotedMessage);

      // Fallback to in-memory cache if quoted payload lacks mediaKey or was stripped
      if ((!viewOnce || !isDownloadableMedia(viewOnce.media)) && contextInfo.stanzaId) {
        const cached = session.viewOnceCache.get(contextInfo.stanzaId);
        if (cached && isDownloadableMedia(cached.media)) {
          viewOnce = { type: cached.type, media: cached.media };
        }
      }

      if (viewOnce && isDownloadableMedia(viewOnce.media)) {
        // Resolve the owner's own private chat ("Message Yourself")
        const rawOwnerId = sock.user?.id;
        if (!rawOwnerId) return;
        const ownerPrivateJid = jidNormalizedUser(rawOwnerId);

        const buffer = await downloadMediaToBuffer(viewOnce.media, viewOnce.type);
        if (!buffer || buffer.length === 0) return;

        const originalCaption = viewOnce.media.caption || undefined;

        if (viewOnce.type === "image") {
          await sock.sendMessage(ownerPrivateJid, {
            image: buffer,
            caption: originalCaption,
          });
        } else if (viewOnce.type === "video") {
          await sock.sendMessage(ownerPrivateJid, {
            video: buffer,
            caption: originalCaption,
            gifPlayback: Boolean(viewOnce.media.gifPlayback),
          });
        } else if (viewOnce.type === "audio") {
          await sock.sendMessage(ownerPrivateJid, {
            audio: buffer,
            mimetype: viewOnce.media.mimetype || "audio/ogg; codecs=opus",
            ptt: Boolean(viewOnce.media.ptt),
          });
        }

        // Keep presence unavailable so the bot never stays online
        await sock.sendPresenceUpdate("unavailable").catch(() => {});
        return;
      }
    }

    // 4. ".ping" Command — Bot speed ONLY (nothing else)
    if (/^\.ping$/i.test(text)) {
      const start = performance.now();
      const sent = await sock.sendMessage(
        chatJid,
        { text: "⚡ ..." },
        { quoted: msg }
      );
      const speedMs = Math.max(1, Math.round(performance.now() - start));

      if (sent?.key) {
        await sock.sendMessage(chatJid, {
          text: `⚡ ${speedMs} ms`,
          edit: sent.key,
        });
      }

      await sock.sendPresenceUpdate("unavailable").catch(() => {});
      return;
    }
  } catch {
    // Strictly silent: NEVER send any error message to WhatsApp
  }
}

// ============================================================================
// WhatsApp Session Manager (QR Code + Pairing Code + Auto Reconnect)
// ============================================================================

/**
 * Safely dispose an active Baileys socket without triggering reconnect loops.
 */
function closeSocketSilently(session) {
  if (!session) return;
  if (session.reconnectTimer) {
    clearTimeout(session.reconnectTimer);
    session.reconnectTimer = null;
  }
  if (session.sock) {
    try {
      session.sock.ev.removeAllListeners();
      session.sock.ws?.close();
    } catch {}
    session.sock = null;
  }
}

/**
 * Create or restart a WhatsApp socket for a given bot username.
 *
 * @param {string} username - Sanitized bot username
 * @param {object} options
 * @param {"auto"|"qr"|"pairing"} [options.mode="auto"]
 * @param {string} [options.phone=""]
 * @param {boolean} [options.resetUnregistered=false]
 */
async function startSession(username, options = {}) {
  const { mode = "auto", phone = "", resetUnregistered = false } = options;
  const sessionDir = path.join(SESSIONS_DIR, username);

  let session = sessions.get(username);
  if (!session) {
    session = {
      username,
      sessionDir,
      sock: null,
      status: "connecting", // "connecting" | "connected" | "disconnected"
      connected: false,
      latestQr: null,
      latestQrAt: 0,
      pairingRequested: false,
      reconnectTimer: null,
      viewOnceCache: new Map(),
      qrWaiters: [],
      pairWaiters: [],
    };
    sessions.set(username, session);
  }

  // Close any previous socket before opening a new one
  closeSocketSilently(session);

  // If starting a fresh QR or Pairing attempt with stale unregistered creds, clean them first
  if (resetUnregistered && !hasRegisteredCreds(sessionDir)) {
    removeDirSafe(sessionDir);
  }

  if (!fs.existsSync(sessionDir)) {
    fs.mkdirSync(sessionDir, { recursive: true });
  }

  session.status = "connecting";
  session.connected = false;
  session.latestQr = null;
  session.latestQrAt = 0;
  session.pairingRequested = false;

  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
  const version = await getWaVersion();

  const sock = makeWASocket({
    version,
    logger: silentLogger,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, silentLogger),
    },
    // Ubuntu Chrome fingerprint ensures maximum compatibility with WhatsApp Pairing Codes
    browser: Browsers.ubuntu("Chrome"),
    // CRITICAL: Never appear 24/7 online on WhatsApp & preserve mobile notifications
    markOnlineOnConnect: false,
    syncFullHistory: false,
    generateHighQualityLinkPreview: false,
    connectTimeoutMs: 60_000,
    defaultQueryTimeoutMs: 60_000,
    keepAliveIntervalMs: 25_000,
  });

  session.sock = sock;

  // Persist auth credentials whenever updated
  sock.ev.on("creds.update", saveCreds);

  // Handle connection lifecycle (QR, Pairing Code, Open, Close/Reconnect)
  sock.ev.on("connection.update", async (update) => {
    // Ignore stale events from replaced sockets
    if (session.sock !== sock) return;

    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      session.latestQr = qr;
      session.latestQrAt = Date.now();

      // Resolve any pending QR HTTP requests
      if (session.qrWaiters.length > 0) {
        const waiters = session.qrWaiters.splice(0);
        for (const w of waiters) {
          w.resolve({ qr });
        }
      }

      // Official Baileys v7 rule: trigger requestPairingCode once socket emits initial QR
      if (
        mode === "pairing" &&
        phone &&
        !sock.authState.creds.registered &&
        !session.pairingRequested
      ) {
        session.pairingRequested = true;
        setTimeout(async () => {
          try {
            if (session.sock !== sock) return;
            const rawCode = await sock.requestPairingCode(phone);
            const formatted = formatPairingCode(rawCode);
            const waiters = session.pairWaiters.splice(0);
            for (const w of waiters) {
              w.resolve({ code: formatted });
            }
          } catch (err) {
            const waiters = session.pairWaiters.splice(0);
            for (const w of waiters) {
              w.reject(
                new Error(
                  err?.message || "Failed to generate pairing code. Check number and try again."
                )
              );
            }
          }
        }, 1200);
      }
    }

    if (connection === "open") {
      session.status = "connected";
      session.connected = true;
      session.latestQr = null;

      // Immediately set presence to unavailable so the account does not show Online 24/7
      await sock.sendPresenceUpdate("unavailable").catch(() => {});

      // Resolve any waiting dashboard calls as already connected
      const qrWaiters = session.qrWaiters.splice(0);
      for (const w of qrWaiters) w.resolve({ connected: true });

      const pairWaiters = session.pairWaiters.splice(0);
      for (const w of pairWaiters) w.resolve({ connected: true });

      console.log(`[BOT] Connected: ${username}`);
    }

    if (connection === "close") {
      session.connected = false;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const isLoggedOut =
        statusCode === DisconnectReason.loggedOut || statusCode === 401 || statusCode === 403;
      const isRestartRequired = statusCode === DisconnectReason.restartRequired || statusCode === 515;
      const registered = Boolean(sock.authState.creds.registered) || hasRegisteredCreds(sessionDir);

      if (isLoggedOut) {
        session.status = "disconnected";
        closeSocketSilently(session);
        removeDirSafe(sessionDir);

        const err = new Error("Session logged out. Please link again.");
        for (const w of session.qrWaiters.splice(0)) w.reject(err);
        for (const w of session.pairWaiters.splice(0)) w.reject(err);

        console.log(`[BOT] Logged out & cleaned: ${username}`);
        return;
      }

      if (isRestartRequired) {
        // WhatsApp always sends 515 immediately after QR scan or Pairing Code confirmation
        session.status = "connecting";
        session.reconnectTimer = setTimeout(() => {
          startSession(username, { mode: "auto" }).catch(() => {});
        }, 1000);
        return;
      }

      if (registered) {
        // Reconnect registered sessions cleanly after transient network drops
        session.status = "connecting";
        session.reconnectTimer = setTimeout(() => {
          startSession(username, { mode: "auto" }).catch(() => {});
        }, 4000);
      } else {
        // Do not loop forever for abandoned unregistered QR/pairing sessions
        session.status = "disconnected";
        const err = new Error("Connection closed before linking completed. Please try again.");
        for (const w of session.qrWaiters.splice(0)) w.reject(err);
        for (const w of session.pairWaiters.splice(0)) w.reject(err);
      }
    }
  });

  // Handle incoming/outgoing messages
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    for (const msg of messages) {
      await handleIncomingMessage(session, sock, msg);
    }
  });

  return session;
}

/**
 * Helper to await an async waiter array with a timeout.
 */
function waitWithTimeout(waiterList, timeoutMs, timeoutMessage) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const idx = waiterList.indexOf(entry);
      if (idx !== -1) waiterList.splice(idx, 1);
      reject(new Error(timeoutMessage));
    }, timeoutMs);

    const entry = {
      resolve: (val) => {
        clearTimeout(timer);
        resolve(val);
      },
      reject: (err) => {
        clearTimeout(timer);
        reject(err);
      },
    };

    waiterList.push(entry);
  });
}

/**
 * Restore all previously linked sessions found in ./sessions on server boot.
 */
async function restoreSavedSessions() {
  try {
    const entries = fs.readdirSync(SESSIONS_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const username = sanitizeUsername(entry.name);
      if (!username) continue;
      const sessionDir = path.join(SESSIONS_DIR, username);
      if (hasRegisteredCreds(sessionDir)) {
        console.log(`[BOT] Restoring saved session: ${username}`);
        startSession(username, { mode: "auto" }).catch(() => {});
      }
    }
  } catch {}
}

// ============================================================================
// Express Web Server & Dashboard API Routes
// ============================================================================
const app = express();
app.use(express.json());

// Serve the Dashboard HTML file directly from the project root
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

/**
 * GET /get-pairing-code?username=...&phone=...
 * Generates an 8-digit WhatsApp Pairing Code for the given username and phone number.
 */
app.get("/get-pairing-code", async (req, res) => {
  try {
    const username = sanitizeUsername(req.query.username);
    const phone = sanitizePhone(req.query.phone);

    if (!username) {
      return res.status(400).json({ error: "Please enter a valid bot username." });
    }
    if (!phone || phone.length < 7 || phone.length > 15) {
      return res
        .status(400)
        .json({ error: "Enter a valid WhatsApp number with country code (e.g. 947XXXXXXXX)." });
    }

    const existing = sessions.get(username);
    if (existing?.connected) {
      return res.json({ connected: true });
    }

    const session = await startSession(username, {
      mode: "pairing",
      phone,
      resetUnregistered: true,
    });

    if (session.connected) {
      return res.json({ connected: true });
    }

    const result = await waitWithTimeout(
      session.pairWaiters,
      25_000,
      "Pairing code request timed out. Please try again."
    );

    return res.json(result);
  } catch (error) {
    return res.status(500).json({
      error: error?.message || "Unable to generate pairing code right now.",
    });
  }
});

/**
 * GET /qr?username=...
 * Generates a PNG Data URL QR Code for WhatsApp Linked Devices scanning.
 */
app.get("/qr", async (req, res) => {
  try {
    const username = sanitizeUsername(req.query.username);
    if (!username) {
      return res.status(400).json({ error: "Please enter a valid bot username." });
    }

    const existing = sessions.get(username);
    if (existing?.connected) {
      return res.json({ connected: true });
    }

    // Reuse a fresh QR if generated within the last 40 seconds
    if (existing?.latestQr && Date.now() - existing.latestQrAt < 40_000) {
      const qrDataUrl = await QRCode.toDataURL(existing.latestQr, {
        width: 320,
        margin: 2,
      });
      return res.json({ qr: qrDataUrl });
    }

    const session = await startSession(username, {
      mode: "qr",
      resetUnregistered: true,
    });

    if (session.connected) {
      return res.json({ connected: true });
    }

    const result = await waitWithTimeout(
      session.qrWaiters,
      25_000,
      "QR code timed out. Please try again."
    );

    if (result.connected) {
      return res.json({ connected: true });
    }

    const qrDataUrl = await QRCode.toDataURL(result.qr, {
      width: 320,
      margin: 2,
    });

    return res.json({ qr: qrDataUrl });
  } catch (error) {
    return res.status(500).json({
      error: error?.message || "Unable to generate QR code right now.",
    });
  }
});

/**
 * GET /status?username=...
 * Returns real-time connection state for the Dashboard status badge.
 */
app.get("/status", (req, res) => {
  const username = sanitizeUsername(req.query.username);
  if (!username) {
    return res.json({ connected: false, status: "disconnected" });
  }

  const session = sessions.get(username);
  if (!session) {
    return res.json({ connected: false, status: "disconnected" });
  }

  return res.json({
    connected: Boolean(session.connected),
    status: session.status,
  });
});

/**
 * POST /logout?username=...
 * Cleanly logs out and removes the saved session for the given username.
 */
app.post("/logout", async (req, res) => {
  try {
    const username = sanitizeUsername(req.query.username || req.body?.username);
    if (!username) {
      return res.status(400).json({ error: "Username is required." });
    }

    const session = sessions.get(username);
    if (session) {
      try {
        if (session.sock && session.connected) {
          await session.sock.logout();
        }
      } catch {}
      closeSocketSilently(session);
      sessions.delete(username);
    }

    removeDirSafe(path.join(SESSIONS_DIR, username));
    return res.json({ ok: true });
  } catch {
    return res.json({ ok: true });
  }
});

// Start HTTP Server & Restore Existing WhatsApp Sessions
app.listen(PORT, () => {
  console.log(`[SERVER] Privet bot project 01 running at http://localhost:${PORT}`);
  restoreSavedSessions();
});
