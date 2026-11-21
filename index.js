"use strict";

const express = require("express");
const cors = require("cors");
const pino = require("pino");
const QRCode = require("qrcode");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  Browsers,
  downloadMediaMessage,
  getContentType,
  normalizeMessageContent,
  fetchLatestWaWebVersion
} = require("@whiskeysockets/baileys");

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, "data");
const SESSION_DIR = path.join(DATA_DIR, "sessions");
const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");
const LOGO_URL = "https://files.catbox.moe/xzfprh.jpg";

fs.mkdirSync(SESSION_DIR, { recursive: true });

const logger = pino({ level: process.env.LOG_LEVEL || "silent" });
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

const bots = new Map();
const startingBots = new Map();
const qrStore = new Map();
const viewOnceCache = new Map();
const MAX_VIEWONCE_CACHE = 300;
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
  return Boolean(sock?.user?.id);
}

function jidNumber(jid) {
  return String(jid || "").split("@")[0].split(":")[0].replace(/\D/g, "");
}

function normalizeJid(jid) {
  if (!jid) return null;
  const [userPart, serverPart] = String(jid).split("@");
  if (!userPart || !serverPart) return null;
  const cleanUser = userPart.split(":")[0];
  return `${cleanUser}@${serverPart}`;
}

function normalizePhone(phone) {
  return String(phone || "").replace(/\D/g, "").replace(/^00/, "");
}

function isGroupJid(jid) {
  return String(jid || "").endsWith("@g.us");
}

function getOwnerJid(sock) {
  if (!sock?.user?.id) return null;
  return normalizeJid(sock.user.id);
}

function isOwner(msg, sock) {
  if (msg?.key?.fromMe === true) return true;
  if (!sock?.user) return false;
  const ownerNums = new Set([
    jidNumber(sock.user.id),
    jidNumber(sock.user.lid)
  ].filter(Boolean));
  const sender = isGroupJid(msg?.key?.remoteJid)
    ? msg?.key?.participant
    : msg?.key?.remoteJid;
  const senderNum = jidNumber(sender);
  return Boolean(senderNum && ownerNums.has(senderNum));
}

function canProcessMessage(username, msg, sock) {
  const mode = getSettings(username).botMode;
  if (mode === "PRIVATE") return isOwner(msg, sock);
  if (mode === "INBOX") return !isGroupJid(msg?.key?.remoteJid);
  return true;
}

function getMessageText(msg) {
  if (!msg?.message) return "";
  const content = normalizeMessageContent(msg.message) || msg.message;
  return content.conversation ||
    content.extendedTextMessage?.text ||
    content.imageMessage?.caption ||
    content.videoMessage?.caption ||
    content.documentMessage?.caption || "";
}

function unwrapViewOnce(message, allowUnmarkedMedia = false) {
  if (!message?.message) return null;
  let content = message.message;
  let hasViewOnceWrapper = false;

  // Unwrap WhatsApp message wrappers used by different clients.
  for (let i = 0; i < 6; i++) {
    if (content?.documentWithCaptionMessage?.message) {
      content = content.documentWithCaptionMessage.message;
    } else if (content?.ephemeralMessage?.message) {
      content = content.ephemeralMessage.message;
    } else if (content?.viewOnceMessageV2Extension?.message) {
      hasViewOnceWrapper = true;
      content = content.viewOnceMessageV2Extension.message;
    } else if (content?.viewOnceMessageV2?.message) {
      hasViewOnceWrapper = true;
      content = content.viewOnceMessageV2.message;
    } else if (content?.viewOnceMessage?.message) {
      hasViewOnceWrapper = true;
      content = content.viewOnceMessage.message;
    } else if (content?.viewOnceMessageV3?.message) {
      hasViewOnceWrapper = true;
      content = content.viewOnceMessageV3.message;
    } else {
      break;
    }
  }

  const type = getContentType(content);
  if (!type || !content[type]) return null;

  const isSupportedMedia = ["imageMessage", "videoMessage", "audioMessage"].includes(type);
  const isViewOnce = hasViewOnceWrapper || Boolean(content[type]?.viewOnce);

  if (!isViewOnce && !(allowUnmarkedMedia && isSupportedMedia)) return null;
  return { type, content: content[type] };
}

function cacheViewOnceMessage(msg) {
  try {
    if (!msg?.key?.id || !msg?.message) return;
    const detected = unwrapViewOnce(msg, false);
    if (!detected) return;

    if (viewOnceCache.size >= MAX_VIEWONCE_CACHE) {
      const oldestKey = viewOnceCache.keys().next().value;
      if (oldestKey) viewOnceCache.delete(oldestKey);
    }
    viewOnceCache.set(msg.key.id, {
      key: { ...msg.key },
      message: msg.message
    });
  } catch {
    // Ignore cache errors
  }
}

function getQuotedMessage(msg, sock) {
  if (!msg?.message) return null;
  const content = normalizeMessageContent(msg.message) || msg.message;
  const type = getContentType(content);
  const context = type ? content[type]?.contextInfo : null;
  if (!context?.quotedMessage || !context?.stanzaId) return null;

  const remoteJid = context.remoteJid || msg.key.remoteJid;
  const isGroup = isGroupJid(remoteJid);
  const ownerNums = new Set([
    jidNumber(sock?.user?.id),
    jidNumber(sock?.user?.lid)
  ].filter(Boolean));

  const isQuotedFromMe = isGroup
    ? Boolean(context.participant && ownerNums.has(jidNumber(context.participant)))
    : msg.key.fromMe === false;

  const key = {
    remoteJid,
    fromMe: isQuotedFromMe,
    id: context.stanzaId
  };

  if (isGroup && context.participant) {
    key.participant = context.participant;
  }

  return {
    key,
    message: context.quotedMessage
  };
}

async function downloadBufferFromCandidate(sock, candidateMsg) {
  return downloadMediaMessage(
    candidateMsg,
    "buffer",
    {},
    {
      logger,
      reuploadRequest: async (updatedMessage) => sock.updateMediaMessage(updatedMessage)
    }
  );
}

async function sendViewOnce(sock, username, msg) {
  try {
    const quoted = getQuotedMessage(msg, sock);
    if (!quoted) return;

    const cachedOriginal = viewOnceCache.get(quoted.key.id);
    const sourceMsg = cachedOriginal || quoted;
    const viewOnce = unwrapViewOnce(sourceMsg, true);
    if (!viewOnce) return;

    const target = getSettings(username).viewOnceTarget === "PRIVATE"
      ? getOwnerJid(sock)
      : msg.key.remoteJid;
    if (!target) return;

    const unwrappedMsg = {
      key: sourceMsg.key,
      message: {
        [viewOnce.type]: viewOnce.content
      }
    };

    let buffer = null;
    try {
      buffer = await downloadBufferFromCandidate(sock, unwrappedMsg);
    } catch {
      if (cachedOriginal) {
        const fallbackViewOnce = unwrapViewOnce(quoted, true);
        if (fallbackViewOnce) {
          buffer = await downloadBufferFromCandidate(sock, {
            key: quoted.key,
            message: { [fallbackViewOnce.type]: fallbackViewOnce.content }
          });
        }
      }
    }

    if (!Buffer.isBuffer(buffer) || !buffer.length) return;

    const caption = viewOnce.content?.caption || "";
    if (viewOnce.type === "imageMessage") {
      await sock.sendMessage(target, {
        image: buffer,
        mimetype: viewOnce.content?.mimetype || "image/jpeg",
        caption
      });
    } else if (viewOnce.type === "videoMessage") {
      await sock.sendMessage(target, {
        video: buffer,
        mimetype: viewOnce.content?.mimetype || "video/mp4",
        caption
      });
    } else if (viewOnce.type === "audioMessage") {
      await sock.sendMessage(target, {
        audio: buffer,
        mimetype: viewOnce.content?.mimetype || "audio/mp4",
        ptt: Boolean(viewOnce.content?.ptt)
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
  if (!isOwner(msg, sock)) return false;
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
    if (!canProcessMessage(username, msg, sock)) return;

    const text = getMessageText(msg).trim();
    if (!text) return;

    const settingCode = text.match(/^(1\.[1-3]|2\.[1-2])$/);
    if (settingCode && await processSettingCode(sock, username, msg, settingCode[1])) return;

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
          text: `⚡ *${elapsed} ms*`,
        }, { quoted: sent });
      }
      return;
    }

    if (command === ".setting") {
      if (!isOwner(msg, sock)) return;
      await sock.sendMessage(msg.key.remoteJid, {
        text: settingsMenu(username)
      }, { quoted: msg });
      return;
    }

    if (text.includes(".")) {
      await sendViewOnce(sock, username, msg);
      return;
    }
  } catch (error) {
    // All command/runtime errors are logged only, never displayed in WhatsApp.
    logger.error({ err: error }, "Message handler failed");
  }
}

async function requestPairingCode(sock, phone) {
  if (!phone || sock.__pairingRequested || isConnected(sock)) return;
  sock.__pairingRequested = true;
  try {
    const raw = await sock.requestPairingCode(phone);
    sock.__pairingCodeResult = String(raw).replace(/[^A-Za-z0-9]/g, "").match(/.{1,4}/g)?.join("-") || raw;
  } catch (error) {
    sock.__pairingError = error.message;
    logger.warn({ err: error }, "Pairing code request failed");
  }
}

async function startBot(username) {
  const clean = cleanUsername(username);
  if (bots.has(clean)) return bots.get(clean);
  if (startingBots.has(clean)) return startingBots.get(clean);

  const startup = (async () => {
    const authPath = sessionPath(clean);
    fs.mkdirSync(authPath, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(authPath);
    let version;
    try {
      const latest = await fetchLatestWaWebVersion();
      version = latest?.version;
    } catch {
      version = undefined;
    }

    const sock = makeWASocket({
      ...(version ? { version } : {}),
      auth: state,
      browser: Browsers.ubuntu("Chrome"),
      printQRInTerminal: false,
      logger,
      markOnlineOnConnect: false,
      syncFullHistory: false,
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
      keepAliveIntervalMs: 25000
    });

    bots.set(clean, sock);
    getSettings(clean);

    sock.ev.on("creds.update", saveCreds);

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
          sock.__pendingPairingPhone = null;
        }
      }

      if (connection === "open") {
        qrStore.delete(clean);
        // Ask WhatsApp to keep the account unavailable; never send composing/available.
        await sock.sendPresenceUpdate("unavailable").catch(() => {});
      }

      if (connection === "close") {
        qrStore.delete(clean);
        if (bots.get(clean) === sock) bots.delete(clean);

        const statusCode = lastDisconnect?.error?.output?.statusCode;
        if (statusCode !== DisconnectReason.loggedOut) {
          setTimeout(() => startBot(clean).catch((error) => {
            logger.error({ err: error }, "Reconnect failed");
          }), 5000).unref?.();
        }
      }
    });

    sock.ev.on("messages.upsert", (event) => {
      for (const message of event.messages || []) {
        cacheViewOnceMessage(message);
        if (event.type === "notify") {
          handleMessage(clean, sock, message);
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
  const number = normalizePhone(phone);
  if (number.length < 8 || number.length > 15) {
    throw new Error("Enter a valid WhatsApp number with country code.");
  }

  const sock = await startBot(username);
  if (isConnected(sock)) return { connected: true };

  sock.__pairingCodeResult = null;
  sock.__pairingError = null;
  sock.__pairingRequested = false;
  sock.__pendingPairingPhone = number;

  if (sock.__qrReady && !sock.__pairingRequested) {
    await requestPairingCode(sock, number);
  }

  for (let i = 0; i < 60; i++) {
    if (sock.__pairingCodeResult) return { connected: false, code: sock.__pairingCodeResult };
    if (sock.__pairingError) throw new Error(sock.__pairingError);
    if (isConnected(sock)) return { connected: true };
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error("Pairing code timed out. Please try again.");
}

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
    const sock = await startBot(username);

    if (isConnected(sock)) {
      return res.json({ ok: true, connected: true });
    }

    for (let i = 0; i < 60; i++) {
      const qr = qrStore.get(username);
      if (qr) return res.json({ ok: true, qr });
      if (isConnected(sock)) return res.json({ ok: true, connected: true });
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

// Restore saved sessions after a restart.
(async () => {
  try {
    const entries = await fsp.readdir(SESSION_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith("session_")) continue;
      const username = cleanUsername(entry.name.slice("session_".length));
      startBot(username).catch((error) => logger.error({ err: error }, "Session restore failed"));
    }
  } catch (error) {
    logger.error({ err: error }, "Session restore scan failed");
  }
})();
