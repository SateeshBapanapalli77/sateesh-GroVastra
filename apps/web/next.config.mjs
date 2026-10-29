/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async rewrites() {
    return [
      {
        source: '/api/proxy/:path*',
        destination: 'http://localhost:4000/:path*',
      },
      {
        source: '/api/:path*',
        destination: 'http://localhost:4000/:path*',
      },

    ];
  },
};

export default nextConfig;
