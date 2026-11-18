import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'waffle — the free, open source cluely',
  description:
    'Cluely charges $149.99 a month to be hidden from screen share. Waffle is a free, open source meeting overlay for Mac that runs on the Claude or ChatGPT you already pay for.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://api.fontshare.com" />
        <link rel="stylesheet" href="https://api.fontshare.com/v2/css?f[]=general-sans@1&display=swap" />
      </head>
      <body>{children}</body>
    </html>
  );
}
