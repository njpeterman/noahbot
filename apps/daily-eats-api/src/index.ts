import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "0.0.0.0";

const app = express();

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", service: "daily-eats-api", time: new Date().toISOString() });
});

app.get("/api/hello", (_req, res) => {
  res.json({
    message: "Hello from Daily Eats 🌮",
    location: "Grand Junction, CO",
    deals: [
      { restaurant: "Placeholder Tacos", deal: "$1 taco Tuesday", expires: "soon" },
    ],
  });
});

const webDist = path.resolve(__dirname, "../../daily-eats-web/dist");
app.use(express.static(webDist));
app.get("*", (_req, res) => {
  res.sendFile(path.join(webDist, "index.html"));
});

app.listen(PORT, HOST, () => {
  console.log(`daily-eats-api listening on http://${HOST}:${PORT}`);
});
