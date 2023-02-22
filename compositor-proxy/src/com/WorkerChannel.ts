import { RTCDataChannel, RTCPeerConnection } from 'werift'
import { Kcp } from './kcp'
import { Channel, DataChannelDesc, FeedbackDataChannelDesc } from './Com'
import { PeerConnectionState } from './ComWorker'

const MAX_BUFFERED_AMOUNT = 1048576
const MTU = 1200 // webrtc datachannel MTU
const SND_WINDOW_SIZE = 1024
const RCV_WINDOW_SIZE = 128

const dataChannelConfig: Parameters<RTCPeerConnection['createDataChannel']>[1] = {
  ordered: false,
  maxRetransmits: 0,
  maxPacketLifeTime: 0,
}

function createDataChannel(peerConnection: RTCPeerConnection, desc: DataChannelDesc): RTCDataChannel {
  return peerConnection.createDataChannel(JSON.stringify(desc), dataChannelConfig)
}

function createARQChannel(
  peerConnectionState: PeerConnectionState,
  type: DataChannelDesc['type'],
  clientId: string,
  desc: DataChannelDesc = {
    type,
    clientId,
  },
): ARQChannel {
  const dataChannel = createDataChannel(peerConnectionState.peerConnection, desc)
  const arqDataChannel = new ARQChannel(peerConnectionState, dataChannel, desc)
  peerConnectionState.peerConnectionResetListeners.push(arqDataChannel.resetListener)
  return arqDataChannel
}

function createSimpleChannel(
  peerConnectionState: PeerConnectionState,
  type: DataChannelDesc['type'],
  clientId: string,
  desc: DataChannelDesc = {
    type,
    clientId,
  },
): SimpleChannel {
  const dataChannel = createDataChannel(peerConnectionState.peerConnection, desc)
  const simpleChannel = new SimpleChannel(peerConnectionState, dataChannel, desc)
  peerConnectionState.peerConnectionResetListeners.push(simpleChannel.resetListener)
  return simpleChannel
}

export function createXWMDataChannel(peerConnectionState: PeerConnectionState, clientId: string): Channel {
  return createARQChannel(peerConnectionState, 'xwm', clientId)
}

export function createFrameDataChannel(peerConnectionState: PeerConnectionState, clientId: string): Channel {
  return createARQChannel(peerConnectionState, 'frame', clientId)
}

export function createProtocolChannel(peerConnectionState: PeerConnectionState, clientId: string): Channel {
  return createARQChannel(peerConnectionState, 'protocol', clientId)
}

export function createFeedbackChannel(
  peerConnectionState: PeerConnectionState,
  clientId: string,
  surfaceId: number,
): Channel {
  const feedbackDataChannelDesc: FeedbackDataChannelDesc = {
    type: 'feedback',
    clientId,
    surfaceId,
  }
  return createSimpleChannel(peerConnectionState, 'feedback', clientId, feedbackDataChannelDesc)
}

export class SimpleChannel implements Channel {
  private openCb?: () => void
  private msgCb?: (msg: Uint8Array) => void
  private closeCb?: () => void
  private errorCb?: (err: Error) => void
  public readonly resetListener = (newPeerConnection: RTCPeerConnection) => {
    this.resetDataChannel(newPeerConnection)
  }

  constructor(
    private readonly peerConnectionState: PeerConnectionState,
    private dataChannel: RTCDataChannel,
    private readonly desc: DataChannelDesc,
  ) {
    this.addDataChannelListeners(dataChannel)
  }

  private addDataChannelListeners(dataChannel: RTCDataChannel) {
    if (dataChannel.readyState === 'open') {
      this.openCb?.()
    } else {
      dataChannel.onopen = () => {
        this.openCb?.()
      }
    }
    dataChannel.onclose = () => {
      this.closeCb?.()
    }
    dataChannel.onerror = (err) => {
      this.errorCb?.(err.error)
    }
    dataChannel.onmessage = (ev) => {
      if (this.msgCb) {
        this.msgCb(ev.data as Buffer)
      }
    }
  }

  get isOpen(): boolean {
    return this.dataChannel.readyState === 'open'
  }

  send(buffer: Uint8Array): void {
    if (this.dataChannel.readyState === 'open' && this.dataChannel.bufferedAmount <= MAX_BUFFERED_AMOUNT) {
      this.dataChannel.send(Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength))
    }
  }

  close(): void {
    if (this.dataChannel.readyState === 'open' || this.dataChannel.readyState === 'connecting') {
      this.dataChannel.close()
    }
  }

  onOpen(cb: () => void): void {
    this.openCb = cb
  }

  onClose(cb: () => void): void {
    this.closeCb = cb
  }

  onError(cb: (err: Error) => void): void {
    this.errorCb = cb
  }

  onMessage(cb: (msg: Uint8Array) => void): void {
    this.msgCb = cb
  }

  resetDataChannel(newPeerConnection: RTCPeerConnection) {
    if (this.dataChannel.readyState === 'open' || this.dataChannel.readyState === 'connecting') {
      this.dataChannel.close()
    }
    const dataChannel = createDataChannel(newPeerConnection, this.desc)
    this.dataChannel = dataChannel
    this.addDataChannelListeners(dataChannel)
  }
}

const checkInterval = 30
const checkListeners: (() => void)[] = []

function check() {
  for (const checkListener of checkListeners) {
    checkListener()
  }
}

setInterval(check, checkInterval)

export class ARQChannel implements Channel {
  private kcp?: Kcp
  private openCb?: () => void
  private closeCb?: () => void
  private errorCb?: (err: Error) => void
  private msgCb?: (event: Uint8Array) => void
  public readonly resetListener = (newPeerConnection: RTCPeerConnection) => {
    this.resetDataChannel(newPeerConnection)
  }
  private checkListener?: () => void

  constructor(
    private readonly peerConnectionState: PeerConnectionState,
    private dataChannel: RTCDataChannel,
    private readonly desc: DataChannelDesc,
  ) {
    this.addDataChannelListeners(dataChannel)
  }

  private addDataChannelListeners(dataChannel: RTCDataChannel) {
    if (dataChannel.readyState === 'open') {
      this.initKcp(dataChannel)
      this.openCb?.()
    } else {
      dataChannel.onopen = () => {
        this.initKcp(dataChannel)
        this.openCb?.()
      }
    }
    dataChannel.onclose = () => {
      if (this.kcp) {
        if (this.checkListener) {
          const idx = checkListeners.indexOf(this.checkListener)
          if (idx >= 0) {
            checkListeners.splice(idx, 1)
          }
          this.checkListener = undefined
        }
        this.kcp.release()
        this.kcp = undefined
      }
      this.closeCb?.()
    }
    dataChannel.onerror = (err) => {
      this.errorCb?.(err.error)
    }
  }

  send(buffer: Uint8Array) {
    // TODO forward error correction: https://github.com/ronomon/reed-solomon#readme & https://github.com/skywind3000/kcp/wiki/KCP-Best-Practice-EN
    if (this.kcp) {
      this.kcp.send(Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength))
      this.kcp.flush(false)
    }
  }

  private check(kcp: Kcp) {
    this.checkListener = () => {
      kcp.update()
    }
    checkListeners.push(this.checkListener)
  }

  close(): void {
    if (this.dataChannel.readyState === 'open' || this.dataChannel.readyState === 'connecting') {
      this.dataChannel.close()
    }
    const index = this.peerConnectionState.peerConnectionResetListeners.indexOf(this.resetListener)
    if (index > -1) {
      this.peerConnectionState.peerConnectionResetListeners.splice(index, 1)
    }
  }

  get isOpen(): boolean {
    return this.dataChannel.readyState === 'open'
  }

  private initKcp(dataChannel: RTCDataChannel) {
    if (dataChannel.id === null) {
      throw new Error('BUG. Datachannel does not have an id.')
    }
    const kcp = new Kcp(dataChannel.id, this)
    kcp.setMtu(MTU) // webrtc datachannel MTU
    kcp.setWndSize(SND_WINDOW_SIZE, RCV_WINDOW_SIZE)
    kcp.setNoDelay(1, checkInterval, 2, 1)
    kcp.setOutput((data, len) => {
      if (len > 0 && dataChannel.readyState === 'open' && dataChannel.bufferedAmount <= MAX_BUFFERED_AMOUNT) {
        dataChannel.send(data.subarray(0, len))
        kcp.update()
      }
    })

    dataChannel.onmessage = (message) => {
      if (kcp.snd_buf === undefined) {
        return
      }
      // TODO forward error correction: https://github.com/ronomon/reed-solomon#readme & https://github.com/skywind3000/kcp/wiki/KCP-Best-Practice-EN
      kcp.input(message.data as Buffer, true, false)
      let size = -1
      while ((size = kcp.peekSize()) > 0) {
        const buffer = Buffer.alloc(size)
        const len = kcp.recv(buffer)
        if (len >= 0 && this.msgCb) {
          this.msgCb(buffer.subarray(0, len))
        }
      }
    }

    this.check(kcp)
    this.kcp = kcp
  }

  onOpen(cb: () => void): void {
    this.openCb = cb
  }

  onClose(cb: () => void): void {
    this.closeCb = cb
  }

  onError(cb: (err: Error) => void): void {
    this.errorCb = cb
  }

  onMessage(cb: (msg: Uint8Array) => void): void {
    this.msgCb = cb
  }

  resetDataChannel(newPeerConnection: RTCPeerConnection) {
    if (this.dataChannel.readyState === 'open' || this.dataChannel.readyState === 'connecting') {
      this.dataChannel.close()
    }
    const dataChannel = createDataChannel(newPeerConnection, this.desc)
    this.dataChannel = dataChannel
    this.addDataChannelListeners(dataChannel)
  }
}
