import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["better-sqlite3", "xlsx", "pdf-parse"],
  experimental: {
    // Cap build workers. Next defaults to (cores-1) = 23 workers here, which
    // exhausts free memory during page-data collection and crashes the build
    // worker (exit code 0xC0000409) on constrained machines.
    cpus: 4,
  },
  turbopack: {
    // Keep file tracing inside the project (repo lives under OneDrive; without
    // this, Turbopack walks up to the home dir and warns about package-lock.json).
    root: __dirname,
  },
};

export default nextConfig;
