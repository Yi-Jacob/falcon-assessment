import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Include the bundled demo database in the Vercel server bundle.
  outputFileTracingIncludes: {
    "/**/*": ["./data/falcon-demo.db"],
  },
};

export default nextConfig;
