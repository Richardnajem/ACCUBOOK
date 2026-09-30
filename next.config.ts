import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["better-sqlite3", "xlsx", "pdf-parse"],
  turbopack: {
    // Keep file tracing inside the project (repo lives under OneDrive; without
    // this, Turbopack walks up to the home dir and warns about package-lock.json).
    root: __dirname,
  },
};

export default nextConfig;
