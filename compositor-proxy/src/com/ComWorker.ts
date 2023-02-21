import { parentPort } from 'node:worker_threads'
import type { Channel, ChannelMessage, FeedbackDataChannelDesc, SignalingMessage } from './Com'
import { isChannelMessage, isSignalingMessage, Signaling } from './Com'
import { RTCPeerConnection } from '@koush/wrtc'
import { config } from '../config'
import {
  createFeedbackChannel,
  createFrameDataChannel,
  createProtocolChannel,
  createXWMDataChannel,
} from './WorkerChannel'

import { createSignaling } from './Signaling'

if (parentPort === null) {
  throw new Error('no parent port.')
}

const parent = parentPort

export type PeerConnectionState = {
  peerConnection: RTCPeerConnection
  readonly peerConnectionResetListeners: ((newPeerConnection: RTCPeerConnection) => void)[]
  polite: false
  makingOffer: boolean
  ignoreOffer: boolean
  isSettingRemoteAnswerPending: boolean
}

function createPeerConnection(): RTCPeerConnection {
  return new RTCPeerConnection({
    iceServers: config.server.webrtc.iceServers,
    portRange: {
      min: config.server.webrtc.portRangeMin ?? 0,
      max: config.server.webrtc.portRangeMax ?? 65535,
    },
  })
}

const peerConnectionState: PeerConnectionState = {
  peerConnection: createPeerConnection(),
  peerConnectionResetListeners: [],
  polite: false,
  makingOffer: false,
  ignoreOffer: false,
  isSettingRemoteAnswerPending: false,
}

export function resetPeerConnectionState(): void {
  peerConnectionState.peerConnection.close()

  const newPeerConnection = createPeerConnection()
  peerConnectionState.peerConnection = newPeerConnection
  for (const peerConnectionResetListener of peerConnectionState.peerConnectionResetListeners) {
    peerConnectionResetListener(newPeerConnection)
  }
}

const channels: Record<number, Channel> = {}

function setupChannel(channel: Channel, channelId: number): Channel {
  channel.onClose(() => {
    const channelOnClose: ChannelMessage<'onClose'> = {
      type: 'onClose',
      data: undefined,
      channelId,
    }
    parent.postMessage(channelOnClose)
  })
  channel.onOpen(() => {
    const channelOnOpen: ChannelMessage<'onOpen'> = {
      type: 'onOpen',
      data: undefined,
      channelId,
    }
    parent.postMessage(channelOnOpen)
  })

  return channel
}

function handleChannelCreate(message: ChannelMessage<'create'>) {
  switch (message.data.type) {
    case 'protocol':
      channels[message.channelId] = setupChannel(
        createProtocolChannel(peerConnectionState, message.data.clientId),
        message.channelId,
      )
      break
    case 'frame':
      channels[message.channelId] = setupChannel(
        createFrameDataChannel(peerConnectionState, message.data.clientId),
        message.channelId,
      )
      break
    case 'xwm':
      channels[message.channelId] = setupChannel(
        createXWMDataChannel(peerConnectionState, message.data.clientId),
        message.channelId,
      )
      break
    case 'feedback':
      channels[message.channelId] = setupChannel(
        createFeedbackChannel(
          peerConnectionState,
          message.data.clientId,
          (message.data as FeedbackDataChannelDesc).surfaceId,
        ),
        message.channelId,
      )
      break
    default:
      throw new Error(`BUG. Unknown channel create type: ${message.data.type}`)
  }
}

export const signaling: Signaling = createSignaling(peerConnectionState)
signaling.onOpenAck = (ackMessage) => {
  const signalingOnOpenAck: SignalingMessage<'onOpenAck'> = {
    type: 'onOpenAck',
    data: ackMessage,
  }
  parent.postMessage(signalingOnOpenAck)
}
signaling.onSend = (sendBuffer) => {
  const signalingOnSend: SignalingMessage<'onSend'> = {
    type: 'onSend',
    data: sendBuffer,
  }
  parent.postMessage(signalingOnSend, [signalingOnSend.data])
}
signaling.onResetPeerConnection = (killAllClients) => {
  const signalingOnResetPeerConnection: SignalingMessage<'onResetPeerConnection'> = {
    type: 'onResetPeerConnection',
    data: killAllClients,
  }
  parent.postMessage(signalingOnResetPeerConnection)
}

function handleMessage(message: ChannelMessage<any> | SignalingMessage<any>) {
  if (isChannelMessage(message, 'send')) {
    channels[message.channelId].send(message.data)
  } else if (isChannelMessage(message, 'close')) {
    channels[message.channelId].close()
  } else if (isChannelMessage(message, 'create')) {
    handleChannelCreate(message)
  } else if (isSignalingMessage(message, 'message')) {
    signaling.message(message.data)
  } else if (isSignalingMessage(message, 'close')) {
    signaling.close()
  } else if (isSignalingMessage(message, 'open')) {
    signaling.open()
  } else {
    throw new Error(`BUG. Invalid message type for com worker ${message.type}`)
  }
}

parent.on('message', handleMessage)
