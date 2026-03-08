const WebSocket = require("ws");
const axios = require("axios");

// =====================
// STATE
// =====================
const state = {
  ws: null,
  connected: false,
  authenticated: false,
  onlinePlayers: new Set(),

  // Untuk handle request "list" dari REST API
  waitingForList: false,
  waitingForPlayerNames: false, // sudah terima "There are X...", tunggu baris nama
  expectedPlayerCount: 0,
  listResolve: null,
  listReject: null,
  listTimer: null,

  // Reconnect
  reconnectTimer: null,
  reconnectDelay: 5000,
};

// Callback yang bisa di-set dari luar (discordBot)
let onPlayerJoin = null;
let onPlayerLeave = null;
let onServerOnline = null;
let onServerOffline = null;
let axiosClient = null;
let CONFIG = null;

// =====================
// INISIALISASI
// =====================
function init(config, client, callbacks) {
  CONFIG = config;
  axiosClient = client;
  onPlayerJoin = callbacks.onPlayerJoin || null;
  onPlayerLeave = callbacks.onPlayerLeave || null;
  onServerOnline = callbacks.onServerOnline || null;
  onServerOffline = callbacks.onServerOffline || null;

  connect();
}

// =====================
// CONNECT KE PTERODACTYL WS
// =====================
async function connect() {
  try {
    console.log("🔌 Menghubungkan ke Pterodactyl WebSocket...");
    const res = await axiosClient.get(
      `/api/client/servers/${CONFIG.SERVER_ID}/websocket`,
    );
    const { token, socket: wsUrl } = res.data.data;

    const ws = new WebSocket(wsUrl, { headers: { Origin: CONFIG.PANEL_URL } });
    state.ws = ws;

    ws.on("open", () => {
      console.log("✅ WebSocket terhubung, autentikasi...");
      ws.send(JSON.stringify({ event: "auth", args: [token] }));
    });

    ws.on("message", (data) => handleMessage(data));

    ws.on("close", () => {
      console.warn("⚠️ WebSocket terputus, reconnect dalam 5 detik...");
      state.connected = false;
      state.authenticated = false;
      scheduleReconnect();
    });

    ws.on("error", (err) => {
      console.error("❌ WebSocket error:", err.message);
    });
  } catch (err) {
    console.error("❌ Gagal connect WebSocket:", err.message);
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  if (state.waitingForList && state.listReject) {
    state.listReject(new Error("WebSocket terputus saat menunggu list"));
    resetListState();
  }

  if (state.reconnectTimer) return;
  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null;
    connect();
  }, state.reconnectDelay);
}

// =====================
// HANDLE PESAN MASUK
// =====================
function handleMessage(data) {
  try {
    const msg = JSON.parse(data);

    if (msg.event === "auth success") {
      state.connected = true;
      state.authenticated = true;
      console.log("🔐 WebSocket terautentikasi");
      return;
    }

    if (msg.event === "status") {
      handleStatusChange(msg.args[0]);
      return;
    }

    if (msg.event === "console output") {
      const line = msg.args[0];
      console.log("[LOG]", line);
      handleConsoleLine(line);
      return;
    }

    if (msg.event === "daemon error") {
      console.error("❌ Daemon error:", msg.args[0]);
    }
  } catch (e) {}
}

// =====================
// HANDLE STATUS SERVER
// =====================
let previousServerStatus = null;

function handleStatusChange(status) {
  if (previousServerStatus === status) return;

  console.log(`🖥️  Status server: ${previousServerStatus} → ${status}`);

  if (status === "running" && previousServerStatus !== null) {
    if (onServerOnline) onServerOnline();
  }

  if (status === "offline" && previousServerStatus === "running") {
    state.onlinePlayers.clear();
    if (onServerOffline) onServerOffline();
  }

  previousServerStatus = status;
}

// =====================
// HANDLE CONSOLE LINE
// =====================
function handleConsoleLine(line) {
  // ── RESPONSE DARI COMMAND "list" ──────────────────────────────
  if (state.waitingForList) {
    // Baris 1: "There are X/Y players online:"
    const countMatch = line.match(/There are (\d+)\/(\d+) players online/i);
    if (countMatch) {
      const onlineCount = parseInt(countMatch[1]);
      const maxPlayers = parseInt(countMatch[2]);

      if (onlineCount === 0) {
        state.onlinePlayers.clear();
        resolveList({ online: 0, max: maxPlayers, players: [] });
        return;
      }

      // Ada player → tunggu baris nama berikutnya
      state.waitingForPlayerNames = true;
      state.expectedPlayerCount = onlineCount;
      return;
    }

    // Baris 2: nama-nama player — hanya proses kalau flag aktif
    if (state.waitingForPlayerNames) {
      // Bukan baris log biasa (tidak ada timestamp Bedrock)
      if (!line.match(/^\[[\d\-\s:]+INFO\]/)) {
        const players = line
          .trim()
          .split(",")
          .map((p) => p.trim())
          .filter((p) => p.length > 0);

        if (players.length > 0) {
          console.log("📋 Player list:", players);
          state.onlinePlayers = new Set(players);
          resolveList({ online: players.length, players });
          return;
        }
      }
    }
  }

  // ── DETECT JOIN (Bedrock) ─────────────────────────────────────
  const joinMatch = line.match(/Player connected:\s(\w+),/);
  if (joinMatch) {
    const player = joinMatch[1];
    if (!state.onlinePlayers.has(player)) {
      state.onlinePlayers.add(player);
      console.log(`🟢 ${player} joined (online: ${state.onlinePlayers.size})`);
      if (onPlayerJoin) onPlayerJoin(player, [...state.onlinePlayers]);
    }
    return;
  }

  // ── DETECT LEAVE (Bedrock) ────────────────────────────────────
  const leaveMatch = line.match(/Player disconnected:\s(\w+),/);
  if (leaveMatch) {
    const player = leaveMatch[1];
    if (state.onlinePlayers.has(player)) {
      state.onlinePlayers.delete(player);
      console.log(`🔴 ${player} left (online: ${state.onlinePlayers.size})`);
      if (onPlayerLeave) onPlayerLeave(player, [...state.onlinePlayers]);
    }
    return;
  }

  // ── DETECT SERVER STOP (Bedrock) ─────────────────────────────
  if (line.match(/Quit correctly/i) || line.match(/Server stop/i)) {
    console.log("⛔ Server shutdown terdeteksi dari log");
    state.onlinePlayers.clear();
    if (onServerOffline) onServerOffline();
  }
}

// =====================
// RESOLVE LIST REQUEST
// =====================
function resolveList(data) {
  if (state.listTimer) clearTimeout(state.listTimer);
  if (state.listResolve) state.listResolve(data);
  resetListState();
}

function resetListState() {
  state.waitingForList = false;
  state.waitingForPlayerNames = false;
  state.expectedPlayerCount = 0;
  state.listResolve = null;
  state.listReject = null;
  state.listTimer = null;
}

// =====================
// PUBLIC: GET ONLINE PLAYERS
// =====================
function getOnlinePlayersWS() {
  return new Promise((resolve, reject) => {
    if (!state.authenticated) {
      return resolve({
        online: state.onlinePlayers.size,
        players: [...state.onlinePlayers],
      });
    }

    state.waitingForList = true;
    state.waitingForPlayerNames = false;
    state.listResolve = resolve;
    state.listReject = reject;

    state.listTimer = setTimeout(() => {
      console.warn("⚠️ Timeout list, fallback ke state lokal");
      resolve({
        online: state.onlinePlayers.size,
        players: [...state.onlinePlayers],
      });
      resetListState();
    }, 15000);

    state.ws.send(JSON.stringify({ event: "send command", args: ["list"] }));
  });
}

// =====================
// PUBLIC: GET STATE
// =====================
function getState() {
  return {
    connected: state.connected,
    authenticated: state.authenticated,
    onlinePlayers: [...state.onlinePlayers],
  };
}

module.exports = { init, getOnlinePlayersWS, getState };
