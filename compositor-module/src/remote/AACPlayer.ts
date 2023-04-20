const audioContext = new AudioContext();
// let audioBufferSource: AudioBufferSourceNode| null ;


export class AACPlayer {
  private audioContext: AudioContext;
  private audioDecoder: AudioDecoder;
  private bufferQueue: AudioBuffer[] = [];
  private nextBufferTime: number; 

  constructor() {
    this.audioContext = new AudioContext();
    this.nextBufferTime = this.audioContext.currentTime + 1;
    this.audioDecoder = new AudioDecoder({
      output: (audioData: AudioData) => {
        this.handleDecodedAudio(audioData);
      },
      error: (error: DOMException) => {
        console.error("AudioDecoder error:", error);
      },
    });
  }

  handleDecodedAudio(audioData: AudioData): void {
    // const audioBuffer = audioData.createAudioBuffer();

    const numberOfChannels = audioData.numberOfChannels;
    const length = audioData.numberOfFrames;
    const sampleRate = audioData.sampleRate;
    console.log("data ", audioData.sampleRate, " Kontext " ,audioContext.sampleRate);
    const audioBuffer = this.audioContext.createBuffer(numberOfChannels, length, sampleRate);
    
    for (let channel = 0; channel < numberOfChannels; channel++) {
      const buffer = audioBuffer.getChannelData(channel);
      audioData.copyTo(buffer, { planeIndex: channel });
    }

    this.bufferQueue.push(audioBuffer);

    if (this.bufferQueue.length === 1) {
      this.playNextBuffer();
    }
  }

  playNextBuffer(): void {
    if (this.bufferQueue.length === 0) return;


    const audioBuffer = this.bufferQueue.shift()!;
    const bufferSource = this.audioContext.createBufferSource();

    // bufferSource.playbackRate.value = 1;
    bufferSource.buffer = audioBuffer;


    console.log(bufferSource.buffer );
    bufferSource.connect(this.audioContext.destination);

    bufferSource.start(this.nextBufferTime);
    this.nextBufferTime += audioBuffer.duration;

    bufferSource.addEventListener("ended", () => {
      this.playNextBuffer();
    });
  }

  decodeAndPlay(encodedData: ArrayBuffer): void {
    
 
    this.audioDecoder.configure({
      codec: "mp4a.40.05",
      // aac: { format: 'adts' },
        sampleRate: 48000,
        numberOfChannels: 2,
    
      });
   
    this.audioDecoder.decode(
      new EncodedAudioChunk({
      type: 'key',
      data: encodedData,
      timestamp: 0,
    }));
  
  }
}