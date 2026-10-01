export const metadata = {
  title: 'EasyConnect Group | VTU, NIN/BVN Verification & Digital Services',
  description: 'Your trusted platform for seamless virtual top-ups, NIN and BVN verifications, legal affidavits, CAC registrations, and online appointment bookings.',
  // Once you get your Google Search Console verification tag, add it below:
  // verification: {
  //   google: 'YOUR_UNIQUE_STRING_HERE',
  // },
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        {/* The 'children' prop represents your page.js content */}
        {children}
      </body>
    </html>
  );
}