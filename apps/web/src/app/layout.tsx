import type { ReactNode } from 'react';
import type { Metadata } from 'next';
import { PRODUCT_NAME, PRODUCT_TAGLINE } from '@col/core';
import { ToastProvider } from '@/components/UndoToast';
import './globals.css';

export const metadata: Metadata = {
  title: { default: PRODUCT_NAME, template: `%s · ${PRODUCT_NAME}` },
  description: PRODUCT_TAGLINE,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
}
