import { createLogger } from './Logger'
import type { WebSocket, WebSocketBehavior } from 'uWebSockets.js'
import { URLSearchParams } from 'url'
import type { CompositorProxySession } from './CompositorProxySession'
import { signaling } from './com'

const logger = createLogger('compositor-proxy-signaling')

type UserData = {
  searchParams: URLSearchParams
  compositorProxySession: CompositorProxySession
}

let openWs: WebSocket<UserData> | null = null

let sendBuffer: Uint8Array[] = []

function cachedSend(message: Uint8Array) {
  openWs?.send(message, true) ?? sendBuffer.push(message)
}

function flushCachedSends(openWs: WebSocket<UserData>) {
  if (sendBuffer.length === 0) {
    return
  }
  for (const message of sendBuffer) {
    openWs.send(message, true)
  }
  sendBuffer = []
}

const textDecoder = new TextDecoder()

signaling.onSend = (sendData) => {
  cachedSend(sendData)
}

export function webRTCSignaling(compositorProxySession: CompositorProxySession): WebSocketBehavior<UserData> {
  signaling.onResetPeerConnection = (killAllClients) => {
    compositorProxySession.onResetPeerConnectionState(killAllClients)
  }
  return {
    sendPingsAutomatically: true,
    upgrade: (res, req, context) => {
      /* This immediately calls open handler, you must not use res after this call */
      res.upgrade(
        {
          searchParams: new URLSearchParams(req.getQuery()),
          compositorProxySession,
        },
        /* Spell these correctly */
        req.getHeader('sec-websocket-key'),
        req.getHeader('sec-websocket-protocol'),
        req.getHeader('sec-websocket-extensions'),
        context,
      )
    },
    open: (ws: WebSocket<UserData>) => {
      if (openWs !== null) {
        ws.close()
        return
      }
      const { searchParams } = ws.getUserData()
      if (searchParams.get('compositorSessionId') !== compositorProxySession.compositorSessionId) {
        const message = 'Bad or missing compositorSessionId query parameter.'
        ws.end(4403, message)
        return
      }

      logger.info(`New signaling connection from ${textDecoder.decode(ws.getRemoteAddressAsText())}.`)
      signaling.onOpenAck = (ackMessage) => {
        ws.send(ackMessage, true)
        openWs = ws
        flushCachedSends(ws)
      }
      signaling.open()
    },
    message: (ws: WebSocket<UserData>, message: ArrayBuffer) => {
      const target = Buffer.allocUnsafe(message.byteLength)
      Buffer.from(message).copy(target)
      signaling.message(target)
    },
    close: (ws: WebSocket<UserData>, code: number, message: ArrayBuffer) => {
      logger.info(`Signaling connection closed. Code: ${code}. Message: ${textDecoder.decode(message)}`)
      openWs = null
      if (code === 4001) {
        // user closed connection
        signaling.close()
      }
    },
  }
}
