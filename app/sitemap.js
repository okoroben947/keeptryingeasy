export default async function sitemap() {
  const baseUrl = 'https://easyconnectgroup.vercel.app';

  return [
    {
      url: baseUrl,
      lastModified: new Date(),
      changeFrequency: 'daily',
      priority: 1.0,
    }
  ];
}