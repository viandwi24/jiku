import type { Metadata, Viewport } from 'next'
import { Geist, Geist_Mono } from 'next/font/google'
import './globals.css'
import { Providers } from '@/components/providers'

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
})

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
})

export const metadata: Metadata = {
  title: {
    default: 'Jiku Studio',
    template: '%s — Jiku Studio',
  },
  description: 'Agentic AI platform — build, manage, and deploy intelligent agents for your team.',
  metadataBase: new URL('https://studio.jiku.app'),
  openGraph: {
    type: 'website',
    siteName: 'Jiku Studio',
    title: 'Jiku Studio',
    description: 'Agentic AI platform — build, manage, and deploy intelligent agents for your team.',
    images: [{ url: '/logo.png', width: 1080, height: 1080, alt: 'Jiku Studio' }],
  },
  twitter: {
    card: 'summary',
    title: 'Jiku Studio',
    description: 'Agentic AI platform — build, manage, and deploy intelligent agents for your team.',
    images: ['/logo.png'],
  },
  icons: {
    icon: [
      { url: '/logo.svg', type: 'image/svg+xml' },
      { url: '/logo.png', type: 'image/png' },
    ],
    apple: '/logo.png',
  },
}

export const viewport: Viewport = {
  themeColor: '#FFA553',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`} suppressHydrationWarning>
      <body className="min-h-full flex flex-col">
        <Providers>{children}</Providers>
      </body>
    </html>
  )
}
