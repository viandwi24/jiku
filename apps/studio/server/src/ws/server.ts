import { WebSocketServer } from 'ws'
import type { IncomingMessage } from 'http'
import type { Server } from 'http'
import { verifyJwt } from '../middleware/auth.ts'
import { handleChatMessage } from './chat.ts'

export function attachWebSocketServer(httpServer: Server): void {
  const wss = new WebSocketServer({ noServer: true })

  // Upgrade HTTP → WS for /ws/chat/:conversationId
  httpServer.on('upgrade', async (req: IncomingMessage, socket, head) => {
    const url = req.url ?? ''
    const match = url.match(/^\/ws\/chat\/([^?]+)/)
    if (!match) {
      socket.destroy()
      return
    }

    const conversationId = match[1]!

    // Auth: token from Authorization header or ?token= query param
    const authHeader = req.headers['authorization'] ?? ''
    const token = authHeader.replace('Bearer ', '').split(',')[0]?.trim()
      || new URL(url, 'http://x').searchParams.get('token')
      || ''

    const payload = await verifyJwt(token)
    const userId = typeof payload?.user_id === 'string' ? payload.user_id : null

    if (!userId) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
      return
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      console.log('[ws] client connected', conversationId)

      ws.on('message', async (data) => {
        await handleChatMessage(
          { userId, conversationId },
          (msg) => ws.send(msg),
          String(data),
        )
      })

      ws.on('close', () => {
        console.log('[ws] client disconnected', conversationId)
      })
    })
  })
}
