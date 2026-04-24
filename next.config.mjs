

const nextConfig = {
  experimental: {
    serverComponentsExternalPackages: ['ws', '@prisma/client'],
  },
  images: {
    unoptimized: true,
  },
};

export default nextConfig;
