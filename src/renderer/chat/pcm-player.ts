/**
 * PCM16 streaming audio player for TTS.
 *
 * MiMo-V2.5-TTS streaming returns base64-encoded PCM16 chunks
 * (24kHz mono). This class feeds them into a Web Audio API
 * AudioContext for gap-free playback as chunks arrive.
 */
const SAMPLE_RATE = 24000;

export class PcmStreamPlayer {
  private ctx: AudioContext | null = null;
  private nextTime = 0;
  private stopped = false;

  /** Start a new playback session. */
  start(): void {
    this.stopped = false;
    this.nextTime = 0;
    this.ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
  }

  /** Feed a base64 PCM16 chunk into the playback queue. */
  feed(pcmBase64: string): void {
    if (!this.ctx || this.stopped) return;
    const float32 = this.base64Pcm16ToFloat32(pcmBase64);
    if (float32.length === 0) return;

    const buffer = this.ctx.createBuffer(1, float32.length, SAMPLE_RATE);
    buffer.getChannelData(0).set(float32);

    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.ctx.destination);

    const now = this.ctx.currentTime;
    if (this.nextTime < now) this.nextTime = now;
    source.start(this.nextTime);
    this.nextTime += float32.length / SAMPLE_RATE;
  }

  /** Stop playback and release resources. */
  stop(): void {
    this.stopped = true;
    if (this.ctx) {
      this.ctx.close().catch(() => {});
      this.ctx = null;
    }
  }

  get isStopped(): boolean {
    return this.stopped;
  }

  private base64Pcm16ToFloat32(base64: string): Float32Array {
    const binary = atob(base64);
    const len = binary.length;
    const sampleCount = len >> 1;
    const buffer = new ArrayBuffer(sampleCount * 4);
    const float32 = new Float32Array(buffer);
    for (let i = 0; i < sampleCount; i++) {
      const lo = binary.charCodeAt(i * 2);
      const hi = binary.charCodeAt(i * 2 + 1);
      const sample = (hi << 8) | lo;
      float32[i] = (sample < 0x8000 ? sample : sample - 0x10000) / 32768;
    }
    return float32;
  }
}