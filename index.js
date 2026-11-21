"use strict";

const express = require("express");
const pino = require("pino");
const fs = require("fs");
const path = require("path");

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  Browsers,
  downloadMediaMessage,
  getContentType
} = require("@whiskeysockets/baileys");

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, "data");
const SESSION_DIR = path.join(DATA_DIR, "sessions");

fs.mkdirSync(SESSION_DIR, { recursive: true });

const logger = pino({ level: process.env.LOG_LEVEL || "info" });

// ================== DASHBOARD (Express) ==================
const app = express();
app.use(express.static(__dirname));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/health", (_req, res) => res.json({ ok: true }));

app.listen(PORT, "0.0.0.0", () => {
  logger.info(`Dashboard running on port ${PORT}`);
});

// ================== VIEW-ONCE SAVE ==================

// සියලුම message wrappers (viewOnce, associatedChildMessage, etc.) unwrap කරයි
function unwrapContent(message) {
  if (!message) return null;
  let content = message;

  for (let i = 0; i < 10; i++) {
    if (content?.documentWithCaptionMessage?.message) {
      content = content.documentWithCaptionMessage.message;
    } else if (content?.ephemeralMessage?.message) {
      content = content.ephemeralMessage.message;
    } else if (content?.viewOnceMessageV2Extension?.message) {
      content = content.viewOnceMessageV2Extension.message;
    } else if (content?.viewOnceMessageV2?.message) {
      content = content.viewOnceMessageV2.message;
    } else if (content?.viewOnceMessage?.message) {
      content = content.viewOnceMessage.message;
    } else if (content?.viewOnceMessageV3?.message) {
      content = content.viewOnceMessageV3.message;
    } else if (content?.associatedChildMessage?.message) {
      content = content.associatedChildMessage.message;
    } else if (content?.editedMessage?.message) {
      content = content.editedMessage.message;
    } else {
      break;
    }
  }

  return content;
}

// Quoted message එකෙන් view-once content එක extract කරයි
function getQuotedViewOnce(msg) {
  const content = unwrapContent(msg?.message);
  if (!content) return null;

  const type = getContentType(content);
  const context = type ? content[type]?.contextInfo : null;
  if (!context?.quotedMessage || !context?.stanzaId) return null;

  const quoted = {
    key: {
      remoteJid: context.remoteJid || msg.key.remoteJid,
      fromMe: false,
      id: context.stanzaId,
      participant: context.participant || msg.key.remoteJid
    },
    message: context.quotedMessage
  };

  const unwrapped = unwrapContent(quoted.message);
  if (!unwrapped) return null;

  const mediaType = getContentType(unwrapped);
  if (!mediaType) return null;

  const media = unwrapped[mediaType];
  if (!media?.viewOnce) return null;

  return { type: mediaType, media, message: quoted };
}

// View-once image/video/audio එක download කර owner ගේ private inbox එකට යවයි
async function saveViewOnce(sock, msg) {
  try {
    const quotedViewOnce = getQuotedViewOnce(msg);
    if (!quotedViewOnce) return;

    const { type, media, message: quoted } = quotedViewOnce;

    if (!sock?.user?.id) return;
    const ownerJid = `${String(sock.user.id).split("@")[0].split(":")[0]}@s.whatsapp.net`;

    const buffer = await downloadMediaMessage(
      quoted,
      "buffer",
      {},
      {
        logger,
        reuploadRequest: async (updatedMessage) =>
          sock.updateMediaMessage(updatedMessage)
      }
    );

    if (!Buffer.isBuffer(buffer) || !buffer.length) return;

    const caption = media.caption || "";

    if (type === "imageMessage") {
      await sock.sendMessage(ownerJid, { image: buffer, caption });
    } else if (type === "videoMessage") {
      await sock.sendMessage(ownerJid, { video: buffer, caption });
    } else if (type === "audioMessage") {
      await sock.sendMessage(ownerJid, {
        audio: buffer,
        mimetype: media.mimetype || "audio/mp4",
        ptt: Boolean(media.ptt)
      });
    }
  } catch (error) {
    logger.warn({ err: error }, "View-once save failed");
  }
}

// ================== BOT START ==================
async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);

  const sock = makeWASocket({
    auth: state,
    // ✅ නිවැරදි කරන ලද්දේ මෙතනයි: androidPhone වෙනුවට ubuntu භාවිතා කර ඇත
    browser: Browsers.ubuntu("Chrome"), 
    printQRInTerminal: true,
    logger,
    markOnlineOnConnect: false,
    syncFullHistory: false,
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 60000,
    keepAliveIntervalMs: 25000
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === "open") {
      logger.info("✅ WhatsApp connected successfully");
      await sock.sendPresenceUpdate("unavailable").catch(() => {});
    }

    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      if (statusCode !== DisconnectReason.loggedOut) {
        logger.info("Reconnecting...");
        setTimeout(() => startBot().catch((e) => logger.error(e)), 5000);
      } else {
        logger.warn("Logged out. Delete session folder and pair again.");
      }
    }
  });

  sock.ev.on("messages.upsert", (event) => {
    if (event.type !== "notify") return;

    for (const msg of event.messages || []) {
      if (!msg?.message || !msg?.key) continue;
      if (msg.key.remoteJid === "status@broadcast") continue;

      // ඕනෑම වචනයකට reply කළ විට view-once media එක save වේ
      saveViewOnce(sock, msg);
    }
  });

  return sock;
}

startBot().catch((error) => {
  logger.error({ err: error }, "Bot start failed");
});
