import type { UIMessageStreamWriter } from 'ai'
import type { JikuUIMessage, JikuStreamChunk } from '@jiku/types'

export type { JikuUIMessage, JikuStreamChunk }

/** Writer wraps AI SDK UIMessageStreamWriter. */
export type JikuUIMessageStreamWriter = UIMessageStreamWriter<JikuUIMessage>
