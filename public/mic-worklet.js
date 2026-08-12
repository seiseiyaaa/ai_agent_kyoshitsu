/**
 * マイク入力を 16kHz / 16bit / モノラルの PCM にしてメインスレッドへ渡す。
 * Google STT v2 の LINEAR16 にそのまま流せる形。
 *
 * AudioContext を 16kHz で開ければ変換は不要だが、開けない環境もあるため
 * その場合だけ間引きでリサンプルする。
 */

const TARGET_RATE = 16000;
/** まとめて送る長さ。細かすぎると WebSocket のフレームが増えすぎる */
const CHUNK_SAMPLES = 1024;

class MicProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / TARGET_RATE;
    this.cursor = 0;
    this.buffer = new Int16Array(CHUNK_SAMPLES);
    this.filled = 0;
  }

  push(sample) {
    const clamped = Math.max(-1, Math.min(1, sample));
    this.buffer[this.filled++] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    if (this.filled === CHUNK_SAMPLES) {
      const out = this.buffer;
      this.buffer = new Int16Array(CHUNK_SAMPLES);
      this.filled = 0;
      this.port.postMessage(out.buffer, [out.buffer]);
    }
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;

    if (this.ratio === 1) {
      for (let i = 0; i < channel.length; i += 1) this.push(channel[i]);
      return true;
    }
    // 端数がずれていかないよう、小数のカーソルで位置を持つ
    for (let i = this.cursor; i < channel.length; i += this.ratio) {
      this.push(channel[Math.floor(i)]);
    }
    this.cursor = (this.cursor - channel.length) % this.ratio;
    if (this.cursor < 0) this.cursor += this.ratio;
    return true;
  }
}

registerProcessor("mic-processor", MicProcessor);
