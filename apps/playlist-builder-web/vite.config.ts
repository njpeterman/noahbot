import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      manifest: {
        name: "Playlist Builder",
        short_name: "Playlist",
        description: "Personal music client with custom playback telemetry.",
        theme_color: "#1db954",
        background_color: "#0a0a0a",
        display: "standalone",
        start_url: "/",
      },
    }),
  ],
  server: {
    host: true,
    port: 5173,
    proxy: {
      "/api": "http://localhost:3002",
    },
  },
});
