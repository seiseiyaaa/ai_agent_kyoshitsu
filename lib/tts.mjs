/**
 * 音声合成(要件書 §7.1 / §7.2)。Google Cloud Text-to-Speech。
 *
 * - 定型文は起動時に合成して持っておく。喋るときの待ち時間をゼロにする(§7.1)
 * - 高齢の保護者を想定し、標準よりやや遅い発話速度にする(§7.2)
 */

import textToSpeech from "@google-cloud/text-to-speech";

const VOICE = process.env.TTS_VOICE ?? "ja-JP-Chirp3-HD-Aoede";
/** Chirp3 が使えないプロジェクト向けの退避先 */
const FALLBACK_VOICE = process.env.TTS_FALLBACK_VOICE ?? "ja-JP-Neural2-B";
/** §7.2 標準(1.0)よりやや遅く */
const SPEAKING_RATE = Number(process.env.TTS_SPEAKING_RATE ?? 0.92);

let client = null;
let activeVoice = VOICE;
const cache = new Map();

function getClient() {
  if (!client) client = new textToSpeech.TextToSpeechClient();
  return client;
}

async function synthesizeWith(voiceName, text, audioConfig = {}) {
  const [res] = await getClient().synthesizeSpeech({
    input: { text },
    voice: { languageCode: "ja-JP", name: voiceName },
    audioConfig: {
      audioEncoding: "MP3",
      speakingRate: SPEAKING_RATE,
      // telephony-class-application(電話帯域を模したフィルタ)は掛けない。
      // 高音と低音が削られて留守番電話の音になる。電話経由の場合はすでに
      // 8kHz μ-law に落ちているので、その上から掛けると二重に劣化する
      ...audioConfig,
    },
  });
  return Buffer.from(res.audioContent);
}

/**
 * 認識側に流し込める 16kHz の PCM を作る。疎通確認(scripts/check-google.mjs)用。
 * LINEAR16 は WAV コンテナで返るので、ヘッダを落として生の PCM にする。
 */
export async function synthesizePcm(text) {
  const wav = await synthesizeWith(activeVoice, text, {
    audioEncoding: "LINEAR16",
    sampleRateHertz: 16000,
  });
  return wav.subarray(0, 4).toString("ascii") === "RIFF" ? wav.subarray(44) : wav;
}

/**
 * 出口ごとの音声形式。
 *   browser: ブラウザで再生する MP3
 *   phone  : Twilio がそのまま流せる 8kHz μ-law(§7.2 電話回線の帯域に最適化)
 */
const FORMATS = {
  browser: { audioEncoding: "MP3" },
  phone: { audioEncoding: "MULAW", sampleRateHertz: 8000 },
};

/**
 * テキストを音声にする。同じ文・同じ形式は使い回す。
 * 指定した声が使えなければ一度だけ退避先へ切り替える。
 */
export async function synthesize(text, target = "browser") {
  const hit = cache.get(`${activeVoice}::${target}::${text}`);
  if (hit) return hit;

  const format = FORMATS[target];
  let audio;
  try {
    audio = await synthesizeWith(activeVoice, text, format);
  } catch (err) {
    // 認証エラーは声の問題ではない。ここで退避先に切り替えても直らないので流す
    if (activeVoice === FALLBACK_VOICE || /credential/i.test(err.message)) throw err;
    console.warn(`[tts] ${activeVoice} が使えないため ${FALLBACK_VOICE} に切り替えます: ${err.message}`);
    activeVoice = FALLBACK_VOICE;
    audio = await synthesizeWith(activeVoice, text, format);
  }
  cache.set(`${activeVoice}::${target}::${text}`, audio);
  return audio;
}

/**
 * §7.2 の「やや遅い発話速度」は Chirp3 HD では効かない。
 * この系統の声は speakingRate と pitch を受け付けず、指定しても黙って無視される。
 * 気づかないまま「設定した」と思い込むのが一番まずいので、起動時に知らせる。
 */
function warnIfSpeakingRateIgnored() {
  if (!/Chirp3?-HD/i.test(activeVoice)) return;
  if (SPEAKING_RATE === 1) return;
  console.warn(
    `[tts] ${activeVoice} は発話速度の指定を受け付けません(§7.2 未達)。\n` +
      `      速度を変えたい場合は TTS_VOICE=ja-JP-Neural2-B などに切り替えてください。`
  );
}

/**
 * §7.1 起動時に定型文を作り置きする。
 * 逐次だと件数ぶん待たされるので、まとめて投げる。
 */
export async function warmUp(lines, targets = ["browser", "phone"]) {
  const unique = [...new Set(lines.filter(Boolean))];
  const jobs = targets.flatMap((target) => unique.map((line) => ({ line, target })));

  const CONCURRENCY = 8;
  let failed = null;
  for (let i = 0; i < jobs.length; i += CONCURRENCY) {
    const batch = jobs.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(({ line, target }) => synthesize(line, target))
    );
    failed = results.find((r) => r.status === "rejected")?.reason ?? failed;
    if (failed) break;
  }
  if (failed) {
    console.warn(`[tts] 事前合成に失敗(実行時に再試行します): ${failed.message}`);
    return;
  }

  console.log(
    `[tts] 定型文 ${unique.length} 件 × ${targets.join("/")} を事前合成しました(声: ${activeVoice})`
  );
  warnIfSpeakingRateIgnored();
}

export function currentVoice() {
  return activeVoice;
}
