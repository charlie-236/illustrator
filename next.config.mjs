

const nextConfig = {
  experimental: {
    serverComponentsExternalPackages: ['ws', '@prisma/client', 'node-ssh'],
  },
  images: {
    unoptimized: true,
  },
};

export default nextConfig;
