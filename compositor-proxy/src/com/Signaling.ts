import { createLogger } from '../Logger'
import { randomBytes } from 'crypto'
import { config } from '../config'
import type { PeerConnectionState } from './ComWorker'
import { Signaling } from './Com'
import { resetPeerConnectionState } from './ComWorker'
import { RTCIceCandidate, RTCIceServer, RTCPeerConnection, RTCSessionDescription } from 'werift'

const logger = createLogger('compositor-proxy-signaling')

export type DataChannelDesc = { type: 'protocol' | 'frame' | 'xwm' | 'feedback'; clientId: string }
export type FeedbackDataChannelDesc = DataChannelDesc & { surfaceId: number }

type SdpSignalingMessage = {
  type: 'sdp'
  data: RTCSessionDescription | null
  identity: string
}
type IceSignalingMessage = {
  type: 'ice'
  data: RTCIceCandidate | null
  identity: string
}
type IdentitySignalingMessage = {
  type: 'identity'
  data: RTCIceServer[]
  identity: string
}

type SignalingMessage = SdpSignalingMessage | IceSignalingMessage | IdentitySignalingMessage

const textDecoder = new TextDecoder()
const textEncoder = new TextEncoder()

const identity = randomBytes(8).toString('hex')
const peerIdentity: IdentitySignalingMessage = {
  type: 'identity',
  // TODO
  // data: config.server.webrtc.iceServers ?? [],
  data: [{ urls: 'stun:stun.l.google.com:19302' }],
  identity,
}
const peerIdentityMessage = textEncoder.encode(JSON.stringify(peerIdentity))
let compositorPeerIdentity: string | undefined

export function createSignaling(peerConnectionState: PeerConnectionState): Signaling {
  logger.info(`Listening for signaling connections using identity: ${peerIdentity.identity}`)
  const signaling: Signaling = {
    onSend(sendBuffer) {
      /* noop */
    },
    onResetPeerConnection(killAllClients: boolean) {
      /* noop */
    },
    onOpenAck(ackMessage: Uint8Array) {
      /* noop */
    },
    open() {
      this.onOpenAck(peerIdentityMessage)
    },
    close() {
      // user closed connection
      compositorPeerIdentity = undefined
      resetPeerConnection(true)
    },
    async message(data: Uint8Array) {
      const messageData = textDecoder.decode(data)
      const messageObject = JSON.parse(messageData)

      if (isSignalingMessage(messageObject)) {
        if (messageObject.type === 'identity') {
          logger.info(`Received compositor signaling identity: ${messageObject.identity}.`)
          if (compositorPeerIdentity && messageObject.identity !== compositorPeerIdentity) {
            logger.info(
              `Compositor signaling identity has changed. Old: ${compositorPeerIdentity}. New: ${messageObject.identity}. Creating new peer connection.`,
            )
            // Remote compositor has restarted. Shutdown the old peer connection before handling any signaling.
            compositorPeerIdentity = messageObject.identity
            resetPeerConnection(false)
          } else if (compositorPeerIdentity === undefined) {
            // Connecting to remote proxy for the first time
            compositorPeerIdentity = messageObject.identity
          } // else re-connecting, ignore.
        } else if (
          messageObject.identity === compositorPeerIdentity &&
          messageObject.type === 'ice' &&
          messageObject.data
        ) {
          try {
            await peerConnectionState.peerConnection.addIceCandidate(messageObject.data)
          } catch (err) {
            if (!peerConnectionState.ignoreOffer) throw err // Suppress ignored offer's candidates
          }
        } else if (
          messageObject.identity === compositorPeerIdentity &&
          messageObject.type === 'sdp' &&
          messageObject.data?.sdp
        ) {
          // An offer may come in while we are busy processing SRD(answer).
          // In this case, we will be in "stable" by the time the offer is processed,
          // so it is safe to chain it on our Operations Chain now.
          const readyForOffer =
            !peerConnectionState.makingOffer &&
            (peerConnectionState.peerConnection.signalingState == 'stable' ||
              peerConnectionState.isSettingRemoteAnswerPending)
          const offerCollision = messageObject.data.type === 'offer' && !readyForOffer

          peerConnectionState.ignoreOffer = !peerConnectionState.polite && offerCollision
          if (peerConnectionState.ignoreOffer) {
            return
          }

          peerConnectionState.isSettingRemoteAnswerPending = messageObject.data.type === 'answer'
          await peerConnectionState.peerConnection.setRemoteDescription(messageObject.data)
          peerConnectionState.isSettingRemoteAnswerPending = false

          if (messageObject.data.type === 'offer') {
            const answer = await peerConnectionState.peerConnection.createAnswer()
            await peerConnectionState.peerConnection.setLocalDescription(answer)
            const signalingMessage: SdpSignalingMessage = {
              type: 'sdp',
              data: peerConnectionState.peerConnection.localDescription ?? null,
              identity,
            }
            this.onSend(textEncoder.encode(JSON.stringify(signalingMessage)))
          }
        }
      }
    },
  }

  const handleIceCandidate: Parameters<RTCPeerConnection['onIceCandidate']['subscribe']>[0] = (candidate) => {
    // TODO?
    // if (ev.protocol === 'tcp') {
    //   return
    // }
    const signalingMessage: IceSignalingMessage = {
      type: 'ice',
      data: candidate,
      identity,
    }
    signaling.onSend(textEncoder.encode(JSON.stringify(signalingMessage)))
  }

  const handleNegotiationNeeded: Parameters<RTCPeerConnection['onNegotiationneeded']['subscribe']>[0] = async () => {
    try {
      peerConnectionState.makingOffer = true
      const offer = await peerConnectionState.peerConnection.createOffer()
      const signalingMessage: SdpSignalingMessage = {
        type: 'sdp',
        data: offer,
        identity,
      }

      signaling.onSend(textEncoder.encode(JSON.stringify(signalingMessage)))

      await peerConnectionState.peerConnection.setLocalDescription(offer)
    } catch (err) {
      console.error(err)
    } finally {
      peerConnectionState.makingOffer = false
    }
  }

  const handleIceConnectionStateChange: Parameters<
    RTCPeerConnection['iceConnectionStateChange']['subscribe']
  >[0] = () => {
    if (peerConnectionState.peerConnection.iceConnectionState === 'failed') {
      console.log('TODO. restart ice')
      //peerConnectionState.peerConnection.restartIce()
    }
  }

  peerConnectionState.peerConnection.onNegotiationneeded.subscribe(handleNegotiationNeeded)
  peerConnectionState.peerConnection.onIceCandidate.subscribe(handleIceCandidate)
  peerConnectionState.peerConnection.iceConnectionStateChange.subscribe(handleIceConnectionStateChange)

  const resetPeerConnection = (killAllClients: boolean) => {
    peerConnectionState.peerConnection.onIceCandidate.allUnsubscribe()
    peerConnectionState.peerConnection.onNegotiationneeded.allUnsubscribe()
    peerConnectionState.peerConnection.iceConnectionStateChange.allUnsubscribe()
    signaling.onResetPeerConnection(killAllClients)
    resetPeerConnectionState()
    peerConnectionState.peerConnection.onNegotiationneeded.subscribe(handleNegotiationNeeded)
    peerConnectionState.peerConnection.onIceCandidate.subscribe(handleIceCandidate)
    peerConnectionState.peerConnection.iceConnectionStateChange.subscribe(handleIceConnectionStateChange)
  }

  return signaling
}

function isSignalingMessage(messageObject: any): messageObject is SignalingMessage {
  if (messageObject === null) {
    return false
  }
  return messageObject.type === 'sdp' || messageObject.type === 'ice' || messageObject.type === 'identity'
}
