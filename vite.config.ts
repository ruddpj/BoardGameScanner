import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "./",
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("/node_modules/@supabase/")) return "supabase";
          if (id.includes("/node_modules/@zxing/")) return "scanner";
          if (id.includes("/node_modules/qrcode/")) return "qrcode";
          if (id.includes("/node_modules/react")) return "react";
        },
      },
    },
  },
});
