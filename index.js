import express from "express";
import cors from "cors";
import pino from "pino";
import QRCode from "qrcode";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

import makeWASocket, {
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  DisconnectReason,
  Browsers,
  downloadMediaMessage,
  downloadContentFromMessage,
  getContentType,
  normalizeMessageContent,
  fetchLatestWaWebVersion,
  jidNormalizedUser
} from "@whiskeysockets/baileys";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, "data");
const SESSION_DIR = path.join(DATA_DIR, "sessions");
const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");
const LOGO_URL = "https://files.catbox.moe/xzfprh.jpg";
const MAX_CACHED_MESSAGES = 500;

const MEDIA_TYPE_MAP = {
  imageMessage: "image",
  videoMessage: "video",
  audioMessage: "audio"
};

fs.mkdirSync(SESSION_DIR, { recursive: true });

const logger = pino({ level: process.env.LOG_LEVEL || "silent" });
const app = express();
app.use(cors());
app.use(express.json());

const bots = new Map();
const startingBots = new Map();
const qrStore = new Map();
const reconnectTimers = new Map();
const messageStore = new Map();
const settingsDB = readJson(SETTINGS_FILE, {});

function readJson(file, fallback) {
  try {
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  try {
    const temp = `${file}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(data, null, 2));
    fs.renameSync(temp, file);
  } catch (error) {
    logger.error({ err: error }, "Could not save data");
  }
}

function cleanUsername(value) {
  return String(value || "default").trim().replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 50) || "default";
}

function sessionPath(username) {
  return path.join(SESSION_DIR, `session_${cleanUsername(username)}`);
}

const DEFAULT_SETTINGS = {
  botMode: "PUBLIC",
  viewOnceTarget: "SAME"
};

function getSettings(username) {
  const key = cleanUsername(username);
  settingsDB[key] = { ...DEFAULT_SETTINGS, ...(settingsDB[key] || {}) };
  return settingsDB[key];
}

function saveSettings(username, settings) {
  const key = cleanUsername(username);
  settingsDB[key] = { ...DEFAULT_SETTINGS, ...settings };
  writeJson(SETTINGS_FILE, settingsDB);
}

function isConnected(sock) {
  return Boolean(sock?.__isOpen && sock?.user?.id);
}

function jidNumber(jid) {
  return String(jid || "").split("@")[0].split(":")[0].replace(/\D/g, "");
}

function normalizePhone(phone) {
  return String(phone || "").replace(/\D/g, "").replace(/^00/, "");
}

function isGroupJid(jid) {
  return String(jid || "").endsWith("@g.us");
}

function getOwnerJid(sock) {
  if (!sock?.user?.id) return null;
  try {
    return jidNormalizedUser(sock.user.id);
  } catch {
    return `${jidNumber(sock.user.id)}@s.whatsapp.net`;
  }
}

function isOwner(msg) {
  return msg?.key?.fromMe === true;
}

function isSameUserJid(jidA, jidB) {
  if (!jidA || !jidB) return false;
  try {
    if (jidNormalizedUser(jidA) === jidNormalizedUser(jidB)) return true;
  } catch {}
  const numA = jidNumber(jidA);
  const numB = jidNumber(jidB);
  return Boolean(numA && numB && numA === numB);
}

function canProcessMessage(username, msg) {
  const mode = getSettings(username).botMode;
  if (mode === "PRIVATE") return isOwner(msg);
  if (mode === "INBOX") return !isGroupJid(msg?.key?.remoteJid);
  return true;
}

function getBotMessageCache(username) {
  const key = cleanUsername(username);
  let cache = messageStore.get(key);
  if (!cache) {
    cache = new Map();
    messageStore.set(key, cache);
  }
  return cache;
}

function cacheIncomingMessage(username, msg) {
  const id = msg?.key?.id;
  if (!id || !msg?.message || msg.key.remoteJid === "status@broadcast") return;

  const cache = getBotMessageCache(username);
  if (cache.has(id)) cache.delete(id);
  cache.set(id, msg);

  while (cache.size > MAX_CACHED_MESSAGES) {
    const oldestKey = cache.keys().next().value;
    cache.delete(oldestKey);
  }
}

function getCachedMessage(username, id) {
  if (!id) return null;
  const cache = messageStore.get(cleanUsername(username));
  return cache ? cache.get(id) || null : null;
}

function unwrapMessageContent(rawMessage) {
  if (!rawMessage) return { content: null, type: null, isViewOnce: false };
  let content = rawMessage;
  let isViewOnce = false;

  // Unwrap WhatsApp message wrappers used by different clients.
  for (let i = 0; i < 8; i++) {
    if (content?.ephemeralMessage?.message) {
      content = content.ephemeralMessage.message;
    } else if (content?.deviceSentMessage?.message) {
      content = content.deviceSentMessage.message;
    } else if (content?.documentWithCaptionMessage?.message) {
      content = content.documentWithCaptionMessage.message;
    } else if (content?.viewOnceMessageV2Extension?.message) {
      isViewOnce = true;
      content = content.viewOnceMessageV2Extension.message;
    } else if (content?.viewOnceMessageV2?.message) {
      isViewOnce = true;
      content = content.viewOnceMessageV2.message;
    } else if (content?.viewOnceMessage?.message) {
      isViewOnce = true;
      content = content.viewOnceMessage.message;
    } else if (content?.viewOnceMessageV3?.message) {
      isViewOnce = true;
      content = content.viewOnceMessageV3.message;
    } else {
      break;
    }
  }

  const type = getContentType(content);
  if (type && content[type]?.viewOnce) {
    isViewOnce = true;
  }

  return { content, type, isViewOnce };
}

function getMessageText(msg) {
  if (!msg?.message) return "";
  const { content } = unwrapMessageContent(msg.message);
  const normalized = content || normalizeMessageContent(msg.message) || msg.message;
  return normalized.conversation ||
    normalized.extendedTextMessage?.text ||
    normalized.imageMessage?.caption ||
    normalized.videoMessage?.caption ||
    normalized.documentMessage?.caption || "";
}

function extractSupportedMedia(message) {
  if (!message?.message) return null;
  const { content, type, isViewOnce } = unwrapMessageContent(message.message);
  if (!type || !MEDIA_TYPE_MAP[type] || !content?.[type]) return null;

  const media = content[type];
  const hasDownloadData = Boolean(media.mediaKey && (media.directPath || media.url));
  return { type, media, isViewOnce, hasDownloadData };
}

function getQuotedMessage(msg, sock) {
  if (!msg?.message) return null;
  const { content, type } = unwrapMessageContent(msg.message);
  const resolved = content || normalizeMessageContent(msg.message) || msg.message;
  const resolvedType = type || getContentType(resolved);
  const context = resolvedType ? resolved[resolvedType]?.contextInfo : null;
  if (!context?.stanzaId && !context?.quotedMessage) return null;

  const remoteJid = context.remoteJid || msg.key.remoteJid;
  const participant = context.participant || (isGroupJid(remoteJid) ? undefined : remoteJid);
  const quotedFromMe = Boolean(
    participant && (
      isSameUserJid(participant, sock?.user?.id) ||
      isSameUserJid(participant, sock?.user?.lid)
    )
  );

  return {
    stanzaId: context.stanzaId || null,
    quoted: context.quotedMessage
      ? {
          key: {
            remoteJid,
            fromMe: quotedFromMe,
            id: context.stanzaId,
            ...(participant ? { participant } : {})
          },
          message: context.quotedMessage
        }
      : null
  };
}

async function downloadMediaBuffer(sock, source, type, media) {
  // Primary: use downloadMediaMessage with unwrapped media so reuploadRequest works cleanly.
  try {
    const unwrappedMessage = {
      key: source.key,
      message: { [type]: media }
    };
    const buffer = await downloadMediaMessage(
      unwrappedMessage,
      "buffer",
      {},
      {
        logger,
        reuploadRequest: async (updatedMessage) => sock.updateMediaMessage(updatedMessage)
      }
    );
    if (Buffer.isBuffer(buffer) && buffer.length) return buffer;
  } catch (error) {
    logger.debug({ err: error }, "Primary media download failed, trying stream fallback");
  }

  // Fallback: decrypt media stream directly from mediaKey + directPath/url.
  const mediaKind = MEDIA_TYPE_MAP[type];
  const stream = await downloadContentFromMessage(media, mediaKind);
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function sendViewOnce(sock, username, msg) {
  try {
    const quotedInfo = getQuotedMessage(msg, sock);
    if (!quotedInfo) return;

    const cached = quotedInfo.stanzaId ? getCachedMessage(username, quotedInfo.stanzaId) : null;
    const cachedMedia = cached ? extractSupportedMedia(cached) : null;
    const quotedMedia = quotedInfo.quoted ? extractSupportedMedia(quotedInfo.quoted) : null;

    let source = null;
    let mediaInfo = null;

    if (cachedMedia?.hasDownloadData) {
      source = cached;
      mediaInfo = cachedMedia;
    } else if (quotedMedia?.hasDownloadData) {
      source = quotedInfo.quoted;
      mediaInfo = quotedMedia;
    } else if (cachedMedia) {
      source = cached;
      mediaInfo = cachedMedia;
    } else if (quotedMedia) {
      source = quotedInfo.quoted;
      mediaInfo = quotedMedia;
    }

    if (!source || !mediaInfo) return;

    const target = getSettings(username).viewOnceTarget === "PRIVATE"
      ? getOwnerJid(sock)
      : msg.key.remoteJid;
    if (!target) return;

    // This is an explicit, user-triggered action: reply to a view-once or permitted media message with ".".
    const buffer = await downloadMediaBuffer(sock, source, mediaInfo.type, mediaInfo.media);
    if (!Buffer.isBuffer(buffer) || !buffer.length) return;

    const caption = mediaInfo.media?.caption || "";
    if (mediaInfo.type === "imageMessage") {
      await sock.sendMessage(target, {
        image: buffer,
        mimetype: mediaInfo.media?.mimetype || "image/jpeg",
        caption
      });
    } else if (mediaInfo.type === "videoMessage") {
      await sock.sendMessage(target, {
        video: buffer,
        mimetype: mediaInfo.media?.mimetype || "video/mp4",
        caption,
        gifPlayback: Boolean(mediaInfo.media?.gifPlayback)
      });
    } else if (mediaInfo.type === "audioMessage") {
      const isPtt = Boolean(mediaInfo.media?.ptt);
      await sock.sendMessage(target, {
        audio: buffer,
        mimetype: mediaInfo.media?.mimetype || (isPtt ? "audio/ogg; codecs=opus" : "audio/mp4"),
        ptt: isPtt
      });
    }
  } catch (error) {
    // Keep failures in server logs only. Never send bot error messages to WhatsApp.
    logger.warn({ err: error }, "View-once handling failed");
  }
}

function settingsMenu(username) {
  const settings = getSettings(username);
  return [
    "⚙️ *PRIVET BOT SETTINGS*",
    "",
    `Bot Mode: *${settings.botMode}*`,
    "1.1 - PUBLIC",
    "1.2 - PRIVATE",
    "1.3 - INBOX",
    "",
    `One-time media destination: *${settings.viewOnceTarget === "PRIVATE" ? "PRIVATE INBOX" : "SAME CHAT"}*`,
    "2.1 - SAME CHAT",
    "2.2 - PRIVATE INBOX",
    "",
    "Reply with the setting code to change it."
  ].join("\n");
}

async function processSettingCode(sock, username, msg, code) {
  if (!isOwner(msg)) return false;
  const settings = getSettings(username);

  const changes = {
    "1.1": () => { settings.botMode = "PUBLIC"; },
    "1.2": () => { settings.botMode = "PRIVATE"; },
    "1.3": () => { settings.botMode = "INBOX"; },
    "2.1": () => { settings.viewOnceTarget = "SAME"; },
    "2.2": () => { settings.viewOnceTarget = "PRIVATE"; }
  };

  if (!changes[code]) return false;
  changes[code]();
  saveSettings(username, settings);

  try {
    await sock.sendMessage(msg.key.remoteJid, {
      text: `✅ Setting updated: ${code}`
    }, { quoted: msg });
  } catch (error) {
    logger.warn({ err: error }, "Could not send setting confirmation");
  }
  return true;
}

async function handleMessage(username, sock, msg) {
  try {
    if (!msg?.message || !msg?.key || msg.key.remoteJid === "status@broadcast") return;
    if (!canProcessMessage(username, msg)) return;

    const text = getMessageText(msg).trim();
    if (!text) return;

    const settingCode = text.match(/^(1\.[1-3]|2\.[1-2])$/);
    if (settingCode && await processSettingCode(sock, username, msg, settingCode[1])) return;

    if (text === ".") {
      await sendViewOnce(sock, username, msg);
      return;
    }

    const command = text.split(/\s+/)[0].toLowerCase();

    if (command === ".ping") {
      const startedAt = Date.now();
      const sent = await sock.sendMessage(msg.key.remoteJid, {
        text: "🏓 *PONG!*"
      }, { quoted: msg });
      const elapsed = Date.now() - startedAt;

      // Edit the first response when supported; otherwise send the measured result.
      try {
        await sock.sendMessage(msg.key.remoteJid, {
          text: `🏓 *PONG!*\n⚡ Speed: *${elapsed} ms*`,
          edit: sent.key
        });
      } catch {
        await sock.sendMessage(msg.key.remoteJid, {
          text: `⚡ *${elapsed} ms*`
        }, { quoted: sent });
      }
      return;
    }

    if (command === ".setting") {
      if (!isOwner(msg)) return;
      await sock.sendMessage(msg.key.remoteJid, {
        text: settingsMenu(username)
      }, { quoted: msg });
      return;
    }
  } catch (error) {
    // All command/runtime errors are logged only, never displayed in WhatsApp.
    logger.error({ err: error }, "Message handler failed");
  }
}

async function requestPairingCode(sock, phone) {
  if (!phone || sock.__pairingRequested || isConnected(sock) || sock.__closed) return;
  if (sock.authState?.creds?.registered) return;

  sock.__pairingRequested = true;
  sock.__pendingPairingPhone = null;
  try {
    const raw = await sock.requestPairingCode(phone);
    sock.__pairingCodeResult = String(raw).replace(/[^A-Za-z0-9]/g, "").match(/.{1,4}/g)?.join("-") || raw;
  } catch (error) {
    sock.__pairingError = error.message || "Failed to request pairing code.";
    sock.__pairingRequested = false;
    logger.warn({ err: error }, "Pairing code request failed");
  }
}

function clearReconnectTimer(username) {
  const clean = cleanUsername(username);
  const timer = reconnectTimers.get(clean);
  if (timer) {
    clearTimeout(timer);
    reconnectTimers.delete(clean);
  }
}

function scheduleReconnect(username, delayMs) {
  const clean = cleanUsername(username);
  clearReconnectTimer(clean);
  const timer = setTimeout(() => {
    reconnectTimers.delete(clean);
    startBot(clean).catch((error) => {
      logger.error({ err: error }, "Reconnect failed");
    });
  }, delayMs);
  timer.unref?.();
  reconnectTimers.set(clean, timer);
}

async function clearSessionDir(username) {
  const authPath = sessionPath(username);
  try {
    await fsp.rm(authPath, { recursive: true, force: true });
  } catch (error) {
    logger.warn({ err: error }, "Could not clear session directory");
  }
}

async function startBot(username) {
  const clean = cleanUsername(username);
  const existing = bots.get(clean);
  if (existing && !existing.__closed) return existing;
  if (startingBots.has(clean)) return startingBots.get(clean);

  clearReconnectTimer(clean);

  const startup = (async () => {
    const authPath = sessionPath(clean);
    fs.mkdirSync(authPath, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(authPath);
    let version;
    try {
      const latest = await fetchLatestWaWebVersion();
      if (Array.isArray(latest?.version)) version = latest.version;
    } catch {
      version = undefined;
    }

    const sock = makeWASocket({
      ...(version ? { version } : {}),
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger)
      },
      browser: Browsers.ubuntu("Chrome"),
      logger,
      markOnlineOnConnect: false,
      syncFullHistory: false,
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
      keepAliveIntervalMs: 25000,
      getMessage: async (key) => getCachedMessage(clean, key?.id)?.message || undefined
    });

    sock.__isOpen = false;
    sock.__closed = false;
    sock.__qrReady = false;
    sock.__sessionCleared = false;

    bots.set(clean, sock);
    getSettings(clean);

    sock.ev.on("creds.update", () => {
      Promise.resolve(saveCreds()).catch((error) => {
        logger.error({ err: error }, "Could not save credentials");
      });
    });

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        sock.__qrReady = true;
        try {
          qrStore.set(clean, await QRCode.toDataURL(qr, { margin: 2, width: 500 }));
        } catch (error) {
          logger.warn({ err: error }, "QR rendering failed");
        }

        if (sock.__pendingPairingPhone) {
          await requestPairingCode(sock, sock.__pendingPairingPhone);
        }
      }

      if (connection === "open") {
        sock.__isOpen = true;
        sock.__closed = false;
        qrStore.delete(clean);
        clearReconnectTimer(clean);
        // Ask WhatsApp to keep the account unavailable; never send composing/available.
        await sock.sendPresenceUpdate("unavailable").catch(() => {});
      }

      if (connection === "close") {
        sock.__isOpen = false;
        sock.__closed = true;
        qrStore.delete(clean);
        if (bots.get(clean) === sock) bots.delete(clean);

        const statusCode = lastDisconnect?.error?.output?.statusCode;
        sock.__closeStatusCode = statusCode;

        const invalidSession =
          statusCode === DisconnectReason.loggedOut ||
          statusCode === DisconnectReason.badSession ||
          statusCode === DisconnectReason.multideviceMismatch;

        if (invalidSession) {
          sock.__sessionCleared = true;
          clearReconnectTimer(clean);
          messageStore.delete(clean);
          await clearSessionDir(clean);
          return;
        }

        if (statusCode === DisconnectReason.connectionReplaced) {
          clearReconnectTimer(clean);
          return;
        }

        const isRestartRequired = statusCode === DisconnectReason.restartRequired;
        const isRegistered = Boolean(sock.authState?.creds?.registered);

        if (isRestartRequired) {
          scheduleReconnect(clean, 1000);
        } else if (isRegistered) {
          scheduleReconnect(clean, 5000);
        }
      }
    });

    sock.ev.on("messages.upsert", (event) => {
      for (const message of event.messages || []) {
        cacheIncomingMessage(clean, message);
        if (event.type === "notify") {
          handleMessage(clean, sock, message).catch((error) => {
            logger.error({ err: error }, "Message handler failed");
          });
        }
      }
    });

    return sock;
  })();

  startingBots.set(clean, startup);
  try {
    return await startup;
  } finally {
    startingBots.delete(clean);
  }
}

async function getPairingCode(username, phone) {
  const clean = cleanUsername(username);
  const number = normalizePhone(phone);
  if (number.length < 8 || number.length > 15) {
    throw new Error("Enter a valid WhatsApp number with country code.");
  }

  let sock = await startBot(clean);
  if (isConnected(sock)) return { connected: true };

  let restartedAfterReset = false;

  const preparePairing = async (targetSock) => {
    targetSock.__pairingCodeResult = null;
    targetSock.__pairingError = null;
    targetSock.__pairingRequested = false;
    targetSock.__pendingPairingPhone = number;

    if (targetSock.__qrReady && !targetSock.__pairingRequested) {
      await requestPairingCode(targetSock, number);
    }
  };

  await preparePairing(sock);

  for (let i = 0; i < 60; i++) {
    const active = bots.get(clean) || sock;

    if (active !== sock && !active.__closed) {
      sock = active;
      await preparePairing(sock);
    }

    if (isConnected(sock)) return { connected: true };
    if (sock.__pairingCodeResult) return { connected: false, code: sock.__pairingCodeResult };
    if (sock.__pairingError) throw new Error(sock.__pairingError);

    if (sock.__closed) {
      if (sock.__sessionCleared && !restartedAfterReset) {
        restartedAfterReset = true;
        sock = await startBot(clean);
        await preparePairing(sock);
      } else if (!reconnectTimers.has(clean) && !startingBots.has(clean)) {
        throw new Error("Connection closed before pairing code could be generated. Please try again.");
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error("Pairing code timed out. Please try again.");
}

app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/get-pairing-code", async (req, res) => {
  try {
    const username = cleanUsername(req.query.username);
    const result = await getPairingCode(username, req.query.phone);
    res.json({ ok: true, ...result });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.get("/qr", async (req, res) => {
  try {
    const username = cleanUsername(req.query.username);
    let sock = await startBot(username);

    if (isConnected(sock)) {
      return res.json({ ok: true, connected: true });
    }

    let restartedAfterReset = false;

    for (let i = 0; i < 60; i++) {
      const active = bots.get(username) || sock;
      if (active !== sock && !active.__closed) {
        sock = active;
      }

      if (isConnected(sock)) return res.json({ ok: true, connected: true });
      const qr = qrStore.get(username);
      if (qr) return res.json({ ok: true, qr });

      if (sock.__closed) {
        if (sock.__sessionCleared && !restartedAfterReset) {
          restartedAfterReset = true;
          sock = await startBot(username);
        } else if (!reconnectTimers.has(username) && !startingBots.has(username)) {
          return res.status(503).json({ ok: false, error: "Connection closed before QR was generated. Please try again." });
        }
      }

      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    return res.status(503).json({ ok: false, error: "QR is not ready yet. Please try again." });
  } catch (error) {
    return res.status(503).json({ ok: false, error: error.message });
  }
});

app.get("/health", (_req, res) => res.json({ ok: true }));

app.listen(PORT, "0.0.0.0", () => {
  logger.info(`Privet bot project 01 dashboard listening on ${PORT}`);
});

// Restore only registered sessions after a restart.
(async () => {
  try {
    const entries = await fsp.readdir(SESSION_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith("session_")) continue;
      const credsFile = path.join(SESSION_DIR, entry.name, "creds.json");
      const creds = readJson(credsFile, null);
      if (!creds?.registered && !creds?.me?.id) continue;

      const username = cleanUsername(entry.name.slice("session_".length));
      startBot(username).catch((error) => logger.error({ err: error }, "Session restore failed"));
    }
  } catch (error) {
    logger.error({ err: error }, "Session restore scan failed");
  }
})();
