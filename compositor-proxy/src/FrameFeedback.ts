import { destroyWlResourceSilently, flush, sendEvents } from 'westfield-proxy'
import { performance } from 'perf_hooks'
import type { Channel } from './com'

export class FrameFeedback {
  private serverProcessingDuration = 0
  private clientProcessingDuration = 0
  private clientFeedbackTimestamp = 0
  private parkedFeedbackClockQueue: ((time: number) => void)[] = []
  private activeFeedbackClockInterval = 16.667
  private nextFeedbackClockInterval = this.activeFeedbackClockInterval
  private feedbackClockTimer: NodeJS.Timer | undefined
  private feedbackClockQueue: ((time: number) => void)[] = []

  constructor(
    private wlClient: unknown,
    private messageInterceptors: Record<number, any>,
    private feedbackChannel: Channel,
    private clientRefreshInterval = 16.667,
  ) {
    this.configureFrameFeedbackClock(this.activeFeedbackClockInterval)
    feedbackChannel.onMessage((buffer) => {
      const data = Buffer.from(buffer, buffer.byteOffset, buffer.byteLength)
      const refreshInterval = data.readUInt16LE(0)
      const avgDuration = data.readUInt16LE(2)
      this.updateDelay(refreshInterval, avgDuration)
    })
  }

  configureFrameFeedbackClock(interval: number) {
    if (this.feedbackClockTimer) {
      return
    }

    this.activeFeedbackClockInterval = interval
    this.feedbackClockTimer = setInterval(() => {
      if (this.feedbackClockQueue.length) {
        const time = performance.now()
        for (const virtualVSyncListener of this.feedbackClockQueue) {
          virtualVSyncListener(time)
        }
        this.feedbackClockQueue = []
      }

      if (this.activeFeedbackClockInterval !== this.nextFeedbackClockInterval) {
        if (this.feedbackClockTimer) {
          clearInterval(this.feedbackClockTimer)
          this.feedbackClockTimer = undefined
        }
        console.log(`reconfiguring with interval: ${this.nextFeedbackClockInterval}`)
        this.configureFrameFeedbackClock(this.nextFeedbackClockInterval)
      }
    }, this.activeFeedbackClockInterval)
  }

  destroy() {
    this.feedbackChannel.close()
    clearInterval(this.feedbackClockTimer)
    this.feedbackClockTimer = undefined
  }

  commitNotify(frameCallbacksIds: number[], isDestroyed: () => boolean): void {
    const clockQueue =
      performance.now() - this.clientFeedbackTimestamp > 1500 ? this.parkedFeedbackClockQueue : this.feedbackClockQueue
    clockQueue.push((time) => {
      if (isDestroyed()) {
        return
      }
      this.sendFrameDoneEventsWithCallbacks(time, frameCallbacksIds)
    })
  }

  private tuneFrameRedrawInterval() {
    const clockInterval = Math.ceil(
      Math.max(this.serverProcessingDuration, this.clientProcessingDuration, this.clientRefreshInterval),
    )

    if (
      Math.abs(clockInterval - this.activeFeedbackClockInterval) > 4 ||
      clockInterval === Math.ceil(this.clientRefreshInterval)
    ) {
      this.nextFeedbackClockInterval = clockInterval
    }
  }

  private updateDelay(clientRefreshInterval: number, clientProcessingDuration: number) {
    this.clientFeedbackTimestamp = performance.now()
    this.clientProcessingDuration = clientProcessingDuration
    this.clientRefreshInterval = clientRefreshInterval
    if (this.parkedFeedbackClockQueue.length) {
      this.feedbackClockQueue.push(...this.parkedFeedbackClockQueue)
      this.parkedFeedbackClockQueue = []
    }

    this.tuneFrameRedrawInterval()
  }

  encodingDone(commitTimestamp: number): void {
    this.serverProcessingDuration = performance.now() - commitTimestamp
    this.tuneFrameRedrawInterval()
  }

  sendFrameDoneEventsWithCallbacks(frameDoneTimestamp: number, frameCallbackIds: number[]) {
    for (const frameCallbackId of frameCallbackIds) {
      this.sendFrameDoneEvent(frameDoneTimestamp, frameCallbackId)
      delete this.messageInterceptors[frameCallbackId]
    }

    // this.syncChildren.forEach((syncChild) => syncChild.sendDoneEvents(frameDoneTimestamp))
  }

  private sendFrameDoneEvent(frameDoneTimestamp: number, callbackResourceId: number) {
    const doneSize = 12 // id+size+opcode+time arg
    const deleteSize = 12 // id+size+opcode+id arg

    const messagesBuffer = new ArrayBuffer(doneSize + deleteSize)

    // send done event to callback
    const doneBufu32 = new Uint32Array(messagesBuffer)
    const doneBufu16 = new Uint16Array(messagesBuffer)
    doneBufu32[0] = callbackResourceId
    doneBufu16[2] = 0 // done opcode
    doneBufu16[3] = doneSize
    doneBufu32[2] = frameDoneTimestamp << 0

    // send delete id event to display
    const deleteBufu32 = new Uint32Array(messagesBuffer, doneSize)
    const deleteBufu16 = new Uint16Array(messagesBuffer, doneSize)
    deleteBufu32[0] = 1
    deleteBufu16[2] = 1 // delete opcode
    deleteBufu16[3] = deleteSize
    deleteBufu32[2] = callbackResourceId

    sendEvents(this.wlClient, doneBufu32, new Uint32Array([]))
    flush(this.wlClient)

    destroyWlResourceSilently(this.wlClient, callbackResourceId)
  }

  sendBufferReleaseEvent(bufferResourceId: number) {
    const releaseSize = 8 // id+size+opcode
    const releaseBuffer = new ArrayBuffer(releaseSize)
    const releaseBufu32 = new Uint32Array(releaseBuffer)
    const releaseBufu16 = new Uint16Array(releaseBuffer)
    releaseBufu32[0] = bufferResourceId
    releaseBufu16[2] = 0 // release opcode
    releaseBufu16[3] = releaseSize
    sendEvents(this.wlClient, releaseBufu32, new Uint32Array([]))

    flush(this.wlClient)
  }
}
