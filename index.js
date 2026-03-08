require("dotenv").config();
const express = require("express");
const axios = require("axios");
const path = require("path");
const wsManager = require("./wsManager");
const discord = require("./discordBot");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// =====================
// KONFIGURASI
// =====================
const CONFIG = {
  PANEL_URL: process.env.PANEL_URL || "https://your-panel.com",
  API_KEY: process.env.API_KEY || "ptlc_YOUR_API_KEY",
  SERVER_ID: process.env.SERVER_ID || "YOUR_SERVER_ID",
  TIMEOUT: parseInt(process.env.TIMEOUT) || 10000,
};

const axiosClient = axios.create({
  baseURL: CONFIG.PANEL_URL,
  headers: {
    Authorization: `Bearer ${CONFIG.API_KEY}`,
    Accept: "Application/vnd.pterodactyl.v1+json",
    "Content-Type": "application/json",
  },
});

// =====================
// FUNGSI HELPER
// =====================
async function getServerStatus() {
  const res = await axiosClient.get(
    `/api/client/servers/${CONFIG.SERVER_ID}/resources`,
  );
  const data = res.data.attributes;
  return {
    status: data.current_state,
    uptime: data.resources.uptime,
    memory_bytes: data.resources.memory_bytes,
    cpu_absolute: data.resources.cpu_absolute,
    disk_bytes: data.resources.disk_bytes,
  };
}

async function sendPowerAction(action) {
  await axiosClient.post(`/api/client/servers/${CONFIG.SERVER_ID}/power`, {
    signal: action,
  });
}

// =====================
// ROUTES API
// =====================

// GET /api/status
app.get("/api/status", async (req, res) => {
  try {
    const status = await getServerStatus();
    const statusMap = {
      running: "online",
      offline: "offline",
      starting: "starting",
      stopping: "stopping",
    };
    res.json({
      success: true,
      data: {
        status: statusMap[status.status] || status.status,
        uptime_seconds: status.uptime,
        resources: {
          memory_mb: Math.round(status.memory_bytes / 1024 / 1024),
          cpu_percent: Math.round(status.cpu_absolute * 10) / 10,
          disk_mb: Math.round(status.disk_bytes / 1024 / 1024),
        },
      },
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/players — pakai WS persistent, kirim command "list"
app.get("/api/players", async (req, res) => {
  try {
    const status = await getServerStatus();
    if (status.status !== "running") {
      return res.json({
        success: true,
        data: { online: 0, players: [], server_status: status.status },
        timestamp: new Date().toISOString(),
      });
    }

    // Minta data terbaru via WS command "list"
    const players = await wsManager.getOnlinePlayersWS();
    res.json({
      success: true,
      data: { ...players, server_status: "running" },
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/info — all-in-one untuk frontend
app.get("/api/info", async (req, res) => {
  try {
    const status = await getServerStatus();
    const statusMap = {
      running: "online",
      offline: "offline",
      starting: "starting",
      stopping: "stopping",
    };

    let playerData = { online: 0, max: 0, players: [] };
    if (status.status === "running") {
      try {
        playerData = await wsManager.getOnlinePlayersWS();
      } catch (e) {}
    }

    res.json({
      success: true,
      data: {
        status: statusMap[status.status] || status.status,
        uptime_seconds: status.uptime,
        resources: {
          memory_mb: Math.round(status.memory_bytes / 1024 / 1024),
          cpu_percent: Math.round(status.cpu_absolute * 10) / 10,
          disk_mb: Math.round(status.disk_bytes / 1024 / 1024),
        },
        players: playerData,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/power
app.post("/api/power", async (req, res) => {
  const { action } = req.body;

  if (action !== "start") {
    return res.status(403).json({
      success: false,
      error: "Publik hanya diizinkan menghidupkan server (start).",
    });
  }

  try {
    const status = await getServerStatus();
    if (status.status !== "offline") {
      return res.status(400).json({
        success: false,
        error: `Server tidak bisa di-start, status saat ini: ${status.status}`,
      });
    }

    await sendPowerAction("start");
    res.json({
      success: true,
      message: "Server sedang dihidupkan! Tunggu beberapa saat...",
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /health
app.get("/health", (req, res) => {
  const wsState = wsManager.getState();
  res.json({
    status: "ok",
    panel: CONFIG.PANEL_URL,
    server_id: CONFIG.SERVER_ID,
    websocket: {
      connected: wsState.connected,
      authenticated: wsState.authenticated,
      online_players: wsState.onlinePlayers,
    },
  });
});

// Serve frontend
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/test-discord", async (req, res) => {
  await discord.onPlayerJoin("TestPlayer", ["TestPlayer", "Steve"]);
  res.json({ success: true });
});

// =====================
// START SERVER
// =====================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server berjalan di http://localhost:${PORT}`);
  console.log(`📡 Panel  : ${CONFIG.PANEL_URL}`);
  console.log(`🎮 Server : ${CONFIG.SERVER_ID}`);
  console.log(`\nEndpoints:`);
  console.log(`  GET  /api/info     → status + players (all-in-one)`);
  console.log(`  GET  /api/status   → status + resource usage`);
  console.log(`  GET  /api/players  → player online`);
  console.log(`  POST /api/power    → start server (publik)`);
  console.log(`  GET  /health       → health check + WS state`);
  console.log(`  GET  /             → Web UI publik`);

  // Init Discord Bot
  discord.init();

  // Init persistent WebSocket ke Pterodactyl
  wsManager.init(CONFIG, axiosClient, {
    onPlayerJoin: discord.onPlayerJoin,
    onPlayerLeave: discord.onPlayerLeave,
    onServerOnline: discord.onServerOnline,
    onServerOffline: discord.onServerOffline,
  });
});
