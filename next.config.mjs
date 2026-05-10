

const nextConfig = {
  experimental: {
    serverComponentsExternalPackages: ['ws', '@prisma/client', 'node-ssh'],
    instrumentationHook: true,
  },
  images: {
    unoptimized: true,
  },
};

export default nextConfig;
