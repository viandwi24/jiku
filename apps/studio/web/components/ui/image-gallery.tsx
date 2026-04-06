'use client'

import { useCallback, useEffect, useState } from 'react'
import { ChevronLeft, ChevronRight, X, ZoomIn } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface GalleryImage {
  src: string
  alt?: string
  filename?: string
}

interface ImageGalleryProps {
  images: GalleryImage[]
  initialIndex?: number
  open: boolean
  onClose: () => void
}

export function ImageGallery({ images, initialIndex = 0, open, onClose }: ImageGalleryProps) {
  const [current, setCurrent] = useState(initialIndex)

  useEffect(() => {
    if (open) setCurrent(initialIndex)
  }, [open, initialIndex])

  const prev = useCallback(() => {
    setCurrent(i => (i - 1 + images.length) % images.length)
  }, [images.length])

  const next = useCallback(() => {
    setCurrent(i => (i + 1) % images.length)
  }, [images.length])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') prev()
      else if (e.key === 'ArrowRight') next()
      else if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, prev, next, onClose])

  if (!open || images.length === 0) return null

  const img = images[current]!

  return (
    /* Backdrop — clicking here closes the gallery */
    <div
      className="fixed inset-0 z-50 bg-black/95 backdrop-blur-sm"
      onClick={onClose}
    >
      {/* Content panel — stops propagation so clicks inside don't reach backdrop */}
      <div
        className="flex flex-col h-full"
        onClick={e => e.stopPropagation()}
      >
        {/* Top bar */}
        <div className="flex items-center justify-between px-4 py-3 shrink-0">
          <span className="text-sm text-white/60 truncate max-w-xs">
            {img.filename ?? img.alt ?? `Image ${current + 1}`}
          </span>
          <div className="flex items-center gap-3">
            <span className="text-sm text-white/40 tabular-nums">
              {current + 1} / {images.length}
            </span>
            <button
              onClick={onClose}
              className="rounded-full p-1.5 text-white/60 hover:text-white hover:bg-white/10 transition-colors"
              aria-label="Close"
            >
              <X className="size-5" />
            </button>
          </div>
        </div>

        {/* Main image area — clicking empty space around image closes gallery */}
        <div
          className="flex-1 flex items-center justify-center relative min-h-0 px-12 cursor-zoom-out"
          onClick={onClose}
        >
          {/* Prev button */}
          {images.length > 1 && (
            <button
              onClick={e => { e.stopPropagation(); prev() }}
              className="absolute left-2 z-10 rounded-full p-2 text-white/60 hover:text-white hover:bg-white/10 transition-colors"
              aria-label="Previous image"
            >
              <ChevronLeft className="size-7" />
            </button>
          )}

          {/* Image — stop propagation so clicking image doesn't close */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            key={img.src}
            src={img.src}
            alt={img.alt ?? img.filename ?? ''}
            className="max-w-full max-h-full object-contain select-none rounded-lg cursor-default"
            style={{ maxHeight: 'calc(100vh - 180px)' }}
            draggable={false}
            onClick={e => e.stopPropagation()}
          />

          {/* Next button */}
          {images.length > 1 && (
            <button
              onClick={e => { e.stopPropagation(); next() }}
              className="absolute right-2 z-10 rounded-full p-2 text-white/60 hover:text-white hover:bg-white/10 transition-colors"
              aria-label="Next image"
            >
              <ChevronRight className="size-7" />
            </button>
          )}
        </div>

        {/* Thumbnail strip */}
        {images.length > 1 && (
          <div className="shrink-0 px-4 py-3 flex items-center justify-center gap-2 overflow-x-auto">
            {images.map((thumb, i) => (
              <button
                key={i}
                onClick={() => setCurrent(i)}
                className={cn(
                  'shrink-0 rounded-md overflow-hidden border-2 transition-all',
                  i === current
                    ? 'border-white/80 opacity-100 scale-105'
                    : 'border-transparent opacity-40 hover:opacity-70'
                )}
                aria-label={`Go to image ${i + 1}`}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={thumb.src}
                  alt={thumb.alt ?? ''}
                  className="w-14 h-14 object-cover"
                  draggable={false}
                />
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

/** Small trigger wrapper — wraps an image and opens the gallery on click */
interface ImageGalleryTriggerProps {
  images: GalleryImage[]
  index: number
  children: React.ReactNode
  className?: string
}

export function ImageGalleryTrigger({ images, index, children, className }: ImageGalleryTriggerProps) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn('relative group block', className)}
        aria-label="View full image"
      >
        {children}
        <span className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity bg-black/20 rounded-lg">
          <ZoomIn className="size-5 text-white drop-shadow" />
        </span>
      </button>
      <ImageGallery images={images} initialIndex={index} open={open} onClose={() => setOpen(false)} />
    </>
  )
}
