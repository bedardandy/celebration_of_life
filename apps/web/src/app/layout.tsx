import type { ReactNode } from 'react';
import type { Metadata } from 'next';
import { PRODUCT_NAME, PRODUCT_TAGLINE } from '@col/core';
import './globals.css';

export const metadata: Metadata = {
  title: PRODUCT_NAME,
  description: PRODUCT_TAGLINE,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
