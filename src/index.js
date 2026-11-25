const { runGuardian } = require("./guardian");

runGuardian()
  .then(() => {
    console.log("[FzServerGuardian] Monitoring run completed.");
    process.exit(0);
  })
  .catch(async error => {
    console.error("[FzServerGuardian] Fatal error:", error);
    const webhook = process.env.DISCORD_WEBHOOK_URL;
    if (webhook) {
      try {
        await fetch(webhook, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            embeds: [{
              title: "❌ FzServerGuardian failed",
              description: String(error.message || error).slice(0, 1800),
              color: 0xED4245,
              timestamp: new Date().toISOString()
            }]
          })
        });
      } catch {}
    }
    process.exit(1);
  });
