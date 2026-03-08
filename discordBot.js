const { Client, GatewayIntentBits, EmbedBuilder } = require("discord.js");

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

let CHANNEL_ID = null;

function init() {
  const token = process.env.DISCORD_TOKEN;
  CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;

  if (!token || !CHANNEL_ID) {
    console.warn(
      "⚠️  DISCORD_TOKEN atau DISCORD_CHANNEL_ID tidak diset, Discord notif dinonaktifkan",
    );
    return;
  }

  client.once("ready", () => {
    console.log(`🤖 Discord Bot online: ${client.user.tag}`);
  });

  client.login(token).catch((err) => {
    console.error("❌ Gagal login Discord:", err.message);
  });
}

async function sendEmbed(embed) {
  if (!CHANNEL_ID || !client.isReady()) return;
  try {
    const channel = await client.channels.fetch(CHANNEL_ID);
    await channel.send({ embeds: [embed] });
  } catch (err) {
    console.error("❌ Gagal kirim Discord:", err.message);
  }
}

// =====================
// CALLBACKS UNTUK wsManager
// =====================

async function onPlayerJoin(playerName, onlinePlayers) {
  console.log(`📢 Notif Discord: ${playerName} joined`);
  const embed = new EmbedBuilder()
    .setColor(0x00c853)
    .setTitle("🟢 Player Join")
    .setDescription(`**${playerName}** telah bergabung ke server!`)
    .addFields({
      name: `👥 Online sekarang (${onlinePlayers.length})`,
      value:
        onlinePlayers.length > 0
          ? onlinePlayers.map((p) => `• ${p}`).join("\n")
          : "*Tidak ada*",
    })
    .setTimestamp();

  await sendEmbed(embed);
}

async function onPlayerLeave(playerName, onlinePlayers) {
  console.log(`📢 Notif Discord: ${playerName} left`);
  const embed = new EmbedBuilder()
    .setColor(0xff1744)
    .setTitle("🔴 Player Leave")
    .setDescription(`**${playerName}** telah keluar dari server.`)
    .addFields({
      name: `👥 Online sekarang (${onlinePlayers.length})`,
      value:
        onlinePlayers.length > 0
          ? onlinePlayers.map((p) => `• ${p}`).join("\n")
          : "*Tidak ada*",
    })
    .setTimestamp();

  await sendEmbed(embed);
}

async function onServerOnline() {
  console.log("📢 Notif Discord: Server online");
  const embed = new EmbedBuilder()
    .setColor(0x2196f3)
    .setTitle("✅ Server Online")
    .setDescription("Minecraft server telah menyala dan siap dimainkan!")
    .setTimestamp();

  await sendEmbed(embed);
}

async function onServerOffline() {
  console.log("📢 Notif Discord: Server offline");
  const embed = new EmbedBuilder()
    .setColor(0x9e9e9e)
    .setTitle("⛔ Server Offline")
    .setDescription("Minecraft server telah mati.")
    .setTimestamp();

  await sendEmbed(embed);
}

module.exports = {
  init,
  onPlayerJoin,
  onPlayerLeave,
  onServerOnline,
  onServerOffline,
};
