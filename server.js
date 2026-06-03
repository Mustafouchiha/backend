require("dotenv").config();

const app = require("./app");
const { connect } = require("./db");

async function start() {
  await connect();

  const { getBot } = require('./bot');
  if (process.env.TELEGRAM_BOT_TOKEN) {
    getBot();
  } else {
    console.log('⚠️  TELEGRAM_BOT_TOKEN topilmadi — bot ishga tushmadi');
  }

  const PORT = process.env.PORT || 5000;
  app.listen(PORT, () => {
    console.log(`🚀 Server http://localhost:${PORT} da ishlamoqda`);
  });

  // Render free tier uxlab qolmasligi uchun har 10 daqiqada o'z-o'zini ping
  if (process.env.NODE_ENV === "production" && process.env.RENDER_EXTERNAL_URL) {
    const https = require("https");
    setInterval(() => {
      https.get(`${process.env.RENDER_EXTERNAL_URL}/api/ping`, (res) => {
        console.log(`🏓 Self-ping: ${res.statusCode}`);
      }).on("error", () => {});
    }, 10 * 60 * 1000); // 10 daqiqa
  }
}

start().catch((err) => {
  console.error("❌ Server start xatosi:", err.message);
  process.exit(1);
});

module.exports = app;
