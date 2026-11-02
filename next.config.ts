import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Lets a second dev server (e.g. an automated check) build elsewhere without clobbering yours.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // The floating dev badge sits on top of the follow-up bar.
  devIndicators: false,
};

export default nextConfig;
