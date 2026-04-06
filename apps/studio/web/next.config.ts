import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: [
    '@jiku/ui',
    '@jiku/types'
  ],
};

export default nextConfig;
