require("dotenv").config();
const express = require("express");
const axios = require("axios");
const WebSocket = require("ws");
const path = require("path");

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

function getOnlinePlayers() {
  return new Promise(async (resolve, reject) => {
    let ws = null;
    let timer = null;
    let expectingPlayerList = false;
    let onlineCount = 0;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (ws && ws.readyState === WebSocket.OPEN) ws.close();
    };

    try {
      const res = await axiosClient.get(
        `/api/client/servers/${CONFIG.SERVER_ID}/websocket`,
      );
      const { token, socket: wsUrl } = res.data.data;

      ws = new WebSocket(wsUrl, { headers: { Origin: CONFIG.PANEL_URL } });

      timer = setTimeout(() => {
        cleanup();
        reject(new Error("Timeout: Server tidak merespons"));
      }, CONFIG.TIMEOUT);

      ws.on("open", () => {
        ws.send(JSON.stringify({ event: "auth", args: [token] }));
      });

      ws.on("message", (data) => {
        try {
          const msg = JSON.parse(data);
          if (msg.event === "auth success") {
            ws.send(JSON.stringify({ event: "send command", args: ["list"] }));
          }
          if (msg.event === "console output") {
            const line = msg.args[0];
            if (line.includes("players online")) {
              const match = line.match(
                /There are (\d+)\/(\d+) players online/i,
              );
              if (match) {
                onlineCount = parseInt(match[1]);
                const maxPlayers = parseInt(match[2]);
                if (onlineCount === 0) {
                  cleanup();
                  resolve({ online: 0, max: maxPlayers, players: [] });
                  return;
                }
                expectingPlayerList = true;
              }
            } else if (expectingPlayerList && onlineCount > 0) {
              const players = line
                .trim()
                .split(",")
                .map((p) => p.trim())
                .filter((p) => p.length > 0);
              cleanup();
              resolve({ online: onlineCount, players });
            }
          }
          if (msg.event === "daemon error") {
            cleanup();
            reject(new Error(`Daemon error: ${msg.args[0]}`));
          }
        } catch (e) {}
      });

      ws.on("error", (err) => {
        cleanup();
        reject(new Error(`WebSocket error: ${err.message}`));
      });
    } catch (err) {
      cleanup();
      reject(new Error(`Gagal koneksi: ${err.message}`));
    }
  });
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

// GET /api/players
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
    const players = await getOnlinePlayers();
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
        playerData = await getOnlinePlayers();
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

// POST /api/power — publik hanya bisa start
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
  res.json({
    status: "ok",
    panel: CONFIG.PANEL_URL,
    server_id: CONFIG.SERVER_ID,
  });
});

// Serve frontend
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
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
  console.log(`  GET  /             → Web UI publik`);
});
