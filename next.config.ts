import type { NextConfig } from "next";

// Sin cacheComponents: la app es dinámica (base, cookies, IA) y los route
// handlers no deben prerenderizarse en build.
const nextConfig: NextConfig = {
  // Solo `next dev`: IPs desde las que se abre la app en la red local (p. ej. celulares en una demo sin https),
  // separadas por coma. Next bloquea por defecto sus recursos de desarrollo pedidos desde otro host.
  allowedDevOrigins: process.env.ALLOWED_DEV_ORIGINS?.split(",").map((s) => s.trim()).filter(Boolean),
  serverExternalPackages: ["pg", "sharp", "@typesafe-ai/sdk"],
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
