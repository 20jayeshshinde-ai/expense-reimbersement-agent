// Entry point: load .env, then start the HTTP server (trying the next port if one is busy).
import "./env.js";
const { default: app } = await import("./app.js");
const { checkAI } = await import("./llm.js");
const { warmUpOcr } = await import("./localAI.js");

function start(port, attemptsLeft = 10) {
  const server = app.listen(port);
  server.on("listening", async () => {
    console.log(`Expense & Reimbursement Agent on http://localhost:${port}`);
    warmUpOcr().catch((e) => console.warn(`Local OCR warm-up failed: ${e.message}`));
    const s = await checkAI();
    console.log(s.state === "ok" ? `AI engine: ${s.provider} ✔ (${s.detail})` : `AI engine: Local AI (offline) – ${s.detail}`);
  });
  server.on("error", (err) => {
    if (err.code === "EADDRINUSE" && attemptsLeft > 0) {
      console.warn(`Port ${port} is already in use – trying ${port + 1}…`);
      start(port + 1, attemptsLeft - 1);
    } else {
      console.error(`Could not start server: ${err.message}`);
      process.exit(1);
    }
  });
}
start(Number(process.env.PORT || 3000));
