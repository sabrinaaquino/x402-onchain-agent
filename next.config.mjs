import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The Venice client lib uses native crypto + elliptic on the server only.
  // Keep these out of the client bundle.
  serverExternalPackages: ["elliptic", "ethers", "siwe", "viem"],
  // Pin the workspace root so Next doesn't pick up an unrelated parent lockfile.
  outputFileTracingRoot: __dirname,
};

export default nextConfig;
