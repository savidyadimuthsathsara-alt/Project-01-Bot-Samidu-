"use strict";

const express = require("express");
const pino = require("pino");
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
  fetchLatestBaileysVersion
} = require("@whiskeysockets/baileys");

const PORT = Number(process.env.PORT || 3000);

// Railway Volume එක /app/data ට mount කරන්න. නැත්නම් local ./data use කරයි.
const DATA_DIR =
  process.env.RAILWAY_VOLUME_MOUNT_PATH ||
  path.join(__dirname, "data");

const SESSION_DIR = path.join(DATA_DIR, "sessions");

fs.mkdirSync(SESSION_DIR, { recursive: true });

const logger = pino({ level: process.env.LOG_LEVEL || "info" });

const app = express();
app.get("/health", (_req, res) => res.json({ ok: true }));
app.listen(PORT, "0.0.0.0", () => {
  logger.info(`Bot listening on ${PORT}`);
});

// ================== VIEW-ONCE SAVE ==================

// View-once / ephemeral / associatedChildMessage wrappers ඔක්කොම unwrap කරන function
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

function getText(msg) {
  const c = unwrapContent(msg?.message);
  if (!c) return "";
  return (
    c.conversation ||
    c.extendedTextMessage?.text ||
    c.imageMessage?.caption ||
    c.videoMessage?.caption ||
    ""
  );
}

function getQuotedMessage(msg) {
  const content = unwrapContent(msg?.message);
  if (!content) return null;

  const type = getContentType(content);
  const context = type ? content[type]?.contextInfo : null;
  if (!context?.quotedMessage || !context?.stanzaId) return null;

  return {
    key: {
      remoteJid: context.remoteJid || msg.key.remoteJid,
      fromMe: false,
      id: context.stanzaId,
      participant: context.participant || msg.key.remoteJid
    },
    message: context.quotedMessage
  };
}

async function saveViewOnce(sock, msg) {
  try {
    const quoted = getQuotedMessage(msg);
    if (!quoted) return;

    // Wrapper ඔක්කොම අයින් කරලා final content එක ගන්න
    const content = unwrapContent(quoted.message);
    if (!content) return;

    const type = getContentType(content);
    if (!type) return;

    const media = content[type];
    if (!media?.viewOnce) return; // view-once image එකක් නෙමෙයි නම් නවතින්න

    // Download එකට unwrapped content එක දෙන්න
    const downloadMessage = { ...quoted, message: content };

    const buffer = await downloadMediaMessage(
      downloadMessage,
      "buffer",
      {},
      {
        logger,
        reuploadRequest: async (updatedMessage) =>
          sock.updateMediaMessage(updatedMessage)
      }
    );

    if (!Buffer.isBuffer(buffer) || !buffer.length) return;

    const target = msg.key.remoteJid;
    const caption = media.caption || "";

    if (type === "imageMessage") {
      await sock.sendMessage(target, { image: buffer, caption });
    } else if (type === "videoMessage") {
      await sock.sendMessage(target, { video: buffer, caption });
    } else if (type === "audioMessage") {
      await sock.sendMessage(target, {
        audio: buffer,
        mimetype: media.mimetype || "audio/mp4",
        ptt: Boolean(media.ptt)
      });
    }
  } catch (error) {
    // ⚠️ WhatsApp එකට කිසිම error message එකක් යවන්නේ නැහැ. Server log එකට විතරයි.
    logger.warn({ err: error }, "View-once save failed");
  }
}

// ================== BOT START ==================

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);

  let version;
  try {
    const latest = await fetchLatestBaileysVersion();
    version = latest?.version;
  } catch {
    version = undefined;
  }

  const sock = makeWASocket({
    ...(version ? { version } : {}),
    auth: state,
    browser: Browsers.ubuntu("Chrome"),
    printQRInTerminal: true, // Railway logs එකේ QR එක පෙන්වයි
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
      logger.info("✅ WhatsApp connected");
      await sock.sendPresenceUpdate("unavailable").catch(() => {});
    }

    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;

      // loggedOut නම් reconnect කරන්නේ නැහැ
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

      const text = getText(msg).trim();

      // View-once image එකට reply කරලා "." යැව්වම save වෙනවා
      if (text === ".") {
        saveViewOnce(sock, msg);
      }
    }
  });

  return sock;
}

startBot().catch((error) => {
  logger.error({ err: error }, "Bot start failed");
});
