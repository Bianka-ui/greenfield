import { Kcp } from './kcp'

const MAX_BUFFERED_AMOUNT = 1048576
const MTU = 1200 // webrtc datachannel MTU
const SND_WINDOW_SIZE = 128
const RCV_WINDOW_SIZE = 1024

export interface Channel {
  send(buffer: ArrayBufferView): void
  close(): void
  readyState: RTCDataChannelState
  onOpen(cb: () => void): void
  onClose(cb: () => void): void
  onError(cb: (err: RTCErrorEvent) => void): void
  onMessage(cb: (msg: Uint8Array) => void): void
}

export class SimpleChannel implements Channel {
  private openCb?: () => void
  private msgCb?: (msg: Uint8Array) => void
  private closeCb?: () => void
  private errorCb?: (err: RTCErrorEvent) => void

  constructor(public readonly dataChannel: RTCDataChannel) {
    this.addDataChannelListeners(dataChannel)
  }

  private addDataChannelListeners(dataChannel: RTCDataChannel) {
    dataChannel.binaryType = 'arraybuffer'
    if (dataChannel.readyState === 'open') {
      this.openCb?.()
    } else {
      dataChannel.addEventListener(
        'open',
        () => {
          this.openCb?.()
        },
        { passive: true, once: true },
      )
    }
    dataChannel.addEventListener(
      'close',
      () => {
        this.closeCb?.()
      },
      { passive: true, once: true },
    )
    dataChannel.addEventListener(
      'error',
      // @ts-ignore
      (err: RTCErrorEvent) => {
        this.errorCb?.(err)
      },
      { passive: true },
    )
    dataChannel.addEventListener(
      'message',
      (ev: MessageEvent<ArrayBuffer | string>) => {
        if (this.msgCb) {
          this.msgCb(new Uint8Array(ev.data as ArrayBuffer))
        }
      },
      { passive: true },
    )
  }

  get readyState(): RTCDataChannelState {
    return this.dataChannel.readyState
  }

  send(buffer: ArrayBufferView): void {
    if (this.dataChannel.readyState === 'open' && this.dataChannel.bufferedAmount <= MAX_BUFFERED_AMOUNT) {
      this.dataChannel.send(buffer)
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

  onError(cb: (err: RTCErrorEvent) => void): void {
    this.errorCb = cb
  }

  onMessage(cb: (msg: Uint8Array) => void): void {
    this.msgCb = cb
  }
}

const checkInterval = 20
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
  private msgCb?: (msg: Uint8Array) => void
  private closeCb?: () => void
  private errorCb?: (err: RTCErrorEvent) => void
  private checkListener?: () => void

  constructor(public readonly dataChannel: RTCDataChannel) {
    this.addDataChannelListeners(dataChannel)
  }

  private addDataChannelListeners(dataChannel: RTCDataChannel) {
    dataChannel.binaryType = 'arraybuffer'
    if (dataChannel.readyState === 'open') {
      this.initKcp(dataChannel)
      this.openCb?.()
    } else {
      dataChannel.addEventListener(
        'open',
        () => {
          this.initKcp(dataChannel)
          this.openCb?.()
        },
        { passive: true, once: true },
      )
    }
    dataChannel.addEventListener(
      'close',
      () => {
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
      },
      { passive: true, once: true },
    )
    dataChannel.addEventListener(
      'error',
      // @ts-ignore
      (err: RTCErrorEvent) => {
        this.errorCb?.(err)
      },
      { passive: true },
    )
  }

  send(buffer: ArrayBufferView): void {
    // TODO forward error correction: https://github.com/ronomon/reed-solomon#readme & https://github.com/skywind3000/kcp/wiki/KCP-Best-Practice-EN
    if (this.kcp) {
      this.kcp.send(new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength))
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
  }

  get readyState(): RTCDataChannelState {
    return this.dataChannel.readyState
  }

  private initKcp(dataChannel: RTCDataChannel) {
    if (dataChannel.id === null) {
      throw new Error('BUG. Datachannel does not have an id.')
    }
    const kcp = new Kcp(dataChannel.id, this)
    kcp.setMtu(MTU) // webrtc datachannel MTU
    kcp.setWndSize(SND_WINDOW_SIZE, RCV_WINDOW_SIZE)
    kcp.setNoDelay(1, checkInterval, 2, 1)
    kcp.setOutput((buf, len) => {
      if (len > 0 && dataChannel.readyState === 'open' && dataChannel.bufferedAmount <= MAX_BUFFERED_AMOUNT) {
        this.dataChannel.send(buf.subarray(0, len))
        kcp.update()
      }
    })

    dataChannel.addEventListener(
      'message',
      (ev: MessageEvent<ArrayBuffer | string>) => {
        if (kcp.snd_buf === undefined) {
          return
        }
        // TODO forward error correction: https://github.com/ronomon/reed-solomon#readme & https://github.com/skywind3000/kcp/wiki/KCP-Best-Practice-EN
        kcp.input(new Uint8Array(ev.data as ArrayBuffer), true, false)
        let size = -1
        while ((size = kcp.peekSize()) > 0) {
          const buffer = new Uint8Array(size)
          const len = kcp.recv(buffer)
          if (len >= 0 && this.msgCb) {
            this.msgCb(buffer.subarray(0, len))
          }
        }
      },
      { passive: true },
    )

    this.check(kcp)
    this.kcp = kcp
  }

  onOpen(cb: () => void): void {
    this.openCb = cb
  }

  onClose(cb: () => void): void {
    this.closeCb = cb
  }

  onError(cb: (err: RTCErrorEvent) => void): void {
    this.errorCb = cb
  }

  onMessage(cb: (msg: Uint8Array) => void): void {
    this.msgCb = cb
  }
}
