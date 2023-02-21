import type { RTCErrorEvent } from '@koush/wrtc'

export type DataChannelDesc = { type: 'protocol' | 'frame' | 'xwm' | 'feedback'; clientId: string }
export type FeedbackDataChannelDesc = DataChannelDesc & { surfaceId: number }

export interface ChannelMessage<T extends keyof ChannelMessageTypeMap> {
  type: T
  data: ChannelMessageTypeMap[T]
  channelId: number
}

export interface ChannelMessageTypeMap {
  isOpen: boolean
  close: undefined
  send: Buffer
  onOpen: undefined
  onClose: undefined
  onError: RTCErrorEvent
  onMessage: Buffer
  create: DataChannelDesc
}

export function isChannelMessage<T extends keyof ChannelMessageTypeMap>(
  message: ChannelMessage<any> | SignalingMessage<any>,
  type: T,
): message is ChannelMessage<T> {
  return message.type === type
}

export interface Channel {
  send(buffer: ArrayBufferView): void

  close(): void

  isOpen: boolean

  onOpen(cb: () => void): void

  onClose(cb: () => void): void

  onError(cb: (err: RTCErrorEvent) => void): void

  onMessage(cb: (msg: Buffer) => void): void
}

export interface SignalingMessage<T extends keyof SignalingMessageTypeMap> {
  type: T
  data: SignalingMessageTypeMap[T]
}

export interface SignalingMessageTypeMap {
  onSend: Uint8Array
  onResetPeerConnection: boolean
  onOpenAck: Uint8Array
  open: undefined
  close: undefined
  message: Uint8Array
}

export function isSignalingMessage<T extends keyof SignalingMessageTypeMap>(
  message: ChannelMessage<any> | SignalingMessage<any>,
  type: T,
): message is SignalingMessage<T> {
  return message.type === type
}

export interface Signaling {
  onSend(sendBuffer: Uint8Array): void
  onResetPeerConnection(killAllClients: boolean): void
  onOpenAck(ackMessage: Uint8Array): void
  open(): void
  close(): void
  message(data: Uint8Array): void
}
