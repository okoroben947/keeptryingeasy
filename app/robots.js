// app/robots.js

export default function robots() {
  return {
    rules: {
      userAgent: '*',
      allow: '/',
      disallow: ['/admin/', '/api/'], // Blocks search engines from crawling backend/admin routes
    },
    sitemap: 'https://easyconnectgroup.vercel.app/sitemap.xml',
  };
}