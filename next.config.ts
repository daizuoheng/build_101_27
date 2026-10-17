import type { NextConfig } from "next";

// Sin cacheComponents: la app es dinámica (base, cookies, IA) y los route
// handlers no deben prerenderizarse en build.
const nextConfig: NextConfig = {
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
