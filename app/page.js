// app/layout.js or app/page.js

export const metadata = {
  title: 'EasyConnect Group - VTU, Digital Services & Verification',
  description: 'Your trusted platform for fast virtual top-ups, NIN/BVN verifications, legal services, and digital utilities.',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}