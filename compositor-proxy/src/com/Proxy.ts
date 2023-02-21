import type {
  Channel,
  ChannelMessage,
  ChannelMessageTypeMap,
  DataChannelDesc,
  FeedbackDataChannelDesc,
  Signaling,
} from './Com'
import { Worker } from 'node:worker_threads'
import { RTCErrorEvent } from '@koush/wrtc'
import { isChannelMessage, isSignalingMessage, SignalingMessage } from './Com'

const comWorker = new Worker('./src/com/ComWorker')

function handleMessage(message: ChannelMessage<any> | SignalingMessage<any>) {
  if (isChannelMessage(message, 'onMessage')) {
    proxyChannels[message.channelId].handleChannelOnMessage(message.data)
  } else if (isChannelMessage(message, 'onClose')) {
    proxyChannels[message.channelId].handleChannelOnClose()
  } else if (isChannelMessage(message, 'onOpen')) {
    proxyChannels[message.channelId].handleChannelOnOpen()
  } else if (isChannelMessage(message, 'onError')) {
    proxyChannels[message.channelId].handleChannelOnError(message.data)
  } else if (isSignalingMessage(message, 'onSend')) {
    signaling.onSend(message.data)
  } else if (isSignalingMessage(message, 'onResetPeerConnection')) {
    signaling.onResetPeerConnection(message.data)
  } else if (isSignalingMessage(message, 'onOpenAck')) {
    signaling.onOpenAck(message.data)
  } else {
    throw new Error(`BUG. Invalid message type for com proxy ${message.type}`)
  }
}

comWorker.on('message', (message) => {
  handleMessage(message)
})

export const signaling: Signaling = {
  close(): void {
    const signalingCloseMessage: SignalingMessage<'close'> = {
      type: 'close',
      data: undefined,
    }
    comWorker.postMessage(signalingCloseMessage)
  },
  message(data: Uint8Array): void {
    const signalingMessage: SignalingMessage<'message'> = {
      type: 'message',
      data,
    }
    comWorker.postMessage(signalingMessage)
  },
  onOpenAck(ackMessage: Uint8Array): void {
    /* noop */
  },
  onResetPeerConnection(killAllClients: boolean): void {
    /* noop */
  },
  onSend(sendBuffer: Uint8Array): void {
    /* noop */
  },
  open(): void {
    const signalingOpen: SignalingMessage<'open'> = {
      type: 'open',
      data: undefined,
    }
    comWorker.postMessage(signalingOpen)
  },
}

function createChannelMessage(channelId: number, data: DataChannelDesc): ChannelMessage<'create'> {
  return {
    channelId,
    data,
    type: 'create',
  }
}

function createSendMessage(channelId: number, data: Buffer): ChannelMessage<'send'> {
  return {
    channelId,
    data,
    type: 'send',
  }
}

function createCloseMessage(channelId: number): ChannelMessage<'close'> {
  return {
    channelId,
    data: undefined,
    type: 'close',
  }
}

let nextChannelId = 0
const proxyChannels: Record<number, ProxyChannel> = {}

export class ProxyChannel implements Channel {
  isOpen = false

  private closeCb?: () => void
  private messageCb?: (msg: Buffer) => void
  private openCb?: () => void
  private errorCb?: (err: RTCErrorEvent) => void

  constructor(desc: DataChannelDesc, private readonly channelId = nextChannelId++) {
    proxyChannels[channelId] = this
    comWorker.postMessage(createChannelMessage(this.channelId, desc))
  }

  close(): void {
    comWorker.postMessage(createCloseMessage(this.channelId))
    this.isOpen = false
    delete proxyChannels[this.channelId]
  }

  onClose(cb: () => void): void {
    this.closeCb = cb
    // TODO remove from proxyChannels
  }

  onError(cb: (err: RTCErrorEvent) => void): void {
    this.errorCb = cb
  }

  onMessage(cb: (msg: Buffer) => void): void {
    this.messageCb = cb
  }

  onOpen(cb: () => void): void {
    this.openCb = cb
  }

  send(buffer: Buffer): void {
    comWorker.postMessage(createSendMessage(this.channelId, buffer), [buffer])
  }

  handleChannelOnMessage(data: ChannelMessageTypeMap['onMessage']) {
    this.messageCb?.(data)
  }

  handleChannelOnClose() {
    this.closeCb?.()
  }

  handleChannelOnOpen() {
    this.isOpen = true
    this.openCb?.()
  }

  handleChannelOnError(data: ChannelMessageTypeMap['onError']) {
    this.errorCb?.(data)
  }
}

function createProxyChannel(
  type: DataChannelDesc['type'],
  clientId: string,
  desc: DataChannelDesc = {
    type,
    clientId,
  },
): ProxyChannel {
  return new ProxyChannel(desc)
}

export function createXWMDataChannel(clientId: string): Channel {
  return createProxyChannel('xwm', clientId)
}

export function createFrameDataChannel(clientId: string): Channel {
  return createProxyChannel('frame', clientId)
}

export function createProtocolChannel(clientId: string): Channel {
  return createProxyChannel('protocol', clientId)
}

export function createFeedbackChannel(clientId: string, surfaceId: number): Channel {
  const feedbackDataChannelDesc: FeedbackDataChannelDesc = {
    type: 'feedback',
    clientId,
    surfaceId,
  }
  return createProxyChannel('feedback', clientId, feedbackDataChannelDesc)
}
