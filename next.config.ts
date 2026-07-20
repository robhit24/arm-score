import type { NextConfig } from "next";
import path from "node:path";

// Pin the Turbopack workspace root to this project. Without this Next.js 16
// walks up the tree, finds the stray /Users/rdotco/package-lock.json + proxy.js,
// and tries to treat that proxy.js as our Next routing middleware — fails
// the build with "Proxy is missing expected function export name".
const nextConfig: NextConfig = {
  turbopack: {
    root: path.resolve(__dirname),
  },
};

export default nextConfig;
