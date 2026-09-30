import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The PDF report reads its fonts from disk at runtime; make sure a
  // deployment bundles them with the route that needs them.
  outputFileTracingIncludes: {
    "/api/report": ["./lib/server/fonts/**/*"],
  },
};

export default nextConfig;
