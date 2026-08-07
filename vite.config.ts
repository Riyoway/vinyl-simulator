import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

const APP_DESCRIPTION =
  "Play your own audio on an interactive 3D vinyl turntable.";

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["favicon-32x32.png", "apple-touch-icon.png"],
      manifest: {
        id: "/",
        name: "Vinyl Simulator",
        short_name: "Vinyl Sim",
        description: APP_DESCRIPTION,
        start_url: "/",
        scope: "/",
        display: "standalone",
        background_color: "#141619",
        theme_color: "#141619",
        icons: [
          {
            src: "pwa-192x192.png",
            sizes: "192x192",
            type: "image/png",
            purpose: "any",
          },
          {
            src: "pwa-512x512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "any",
          },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,json,glb,svg,jpg,jpeg}"],
        maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
        cleanupOutdatedCaches: true,
      },
    }),
  ],
});
