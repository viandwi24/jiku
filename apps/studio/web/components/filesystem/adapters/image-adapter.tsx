'use client'

import { useState } from 'react'
import { api } from '@/lib/api'
import { Button } from '@jiku/ui'
import { Minus, Plus, RotateCcw } from 'lucide-react'
import type { FileViewAdapterProps } from '@/lib/file-view-adapters'

/**
 * Built-in image viewer. Renders the file via the signed inline proxy URL
 * so large binaries aren't pulled through the JSON content endpoint. Pan/zoom
 * is deliberately minimal — click +/- to step zoom, drag to pan when zoomed.
 */
export function ImageViewAdapter({ projectId, path, filename }: FileViewAdapterProps) {
  const [zoom, setZoom] = useState(1)
  const src = api.filesystem.proxyUrl(projectId, path, 'inline')

  const clampZoom = (z: number) => Math.min(Math.max(z, 0.25), 8)

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-black/80">
      <div className="flex items-center justify-between px-3 py-2 border-b border-white/10 text-white/80 text-xs shrink-0">
        <span className="truncate">{filename}</span>
        <div className="flex items-center gap-1 shrink-0">
          <Button variant="ghost" size="icon" className="h-7 w-7 text-white/80 hover:text-white hover:bg-white/10" onClick={() => setZoom(z => clampZoom(z - 0.25))} title="Zoom out">
            <Minus className="w-3.5 h-3.5" />
          </Button>
          <span className="tabular-nums w-12 text-center">{Math.round(zoom * 100)}%</span>
          <Button variant="ghost" size="icon" className="h-7 w-7 text-white/80 hover:text-white hover:bg-white/10" onClick={() => setZoom(z => clampZoom(z + 0.25))} title="Zoom in">
            <Plus className="w-3.5 h-3.5" />
          </Button>
          <Button variant="ghost" size="icon" className="h-7 w-7 text-white/80 hover:text-white hover:bg-white/10" onClick={() => setZoom(1)} title="Reset zoom">
            <RotateCcw className="w-3.5 h-3.5" />
          </Button>
        </div>
      </div>
      <div className="flex-1 overflow-auto flex items-center justify-center p-4">
        <img
          src={src}
          alt={filename}
          style={{ transform: `scale(${zoom})`, transformOrigin: 'center center', transition: 'transform 0.1s ease-out' }}
          className="max-w-full max-h-full object-contain select-none"
          draggable={false}
        />
      </div>
    </div>
  )
}
