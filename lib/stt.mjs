/**
 * 音声認識(要件書 §7.1「音声認識をストリーミング処理とする」)。
 * Google Cloud Speech-to-Text v2 の streamingRecognize を使う。
 *
 * 発話の切れ目は、認識の確定(isFinal)を基準に決める。
 * ひと続きの発話が複数の確定に割れることがあるので、確定後に少し待ってから閉じる。
 * サーバ側の音声区間検出(SPEECH_ACTIVITY_END)も併用するが、両方から呼ばれても
 * 同じ発話を二重に出さないよう flush() 側で抑えている。
 */

import speech from "@google-cloud/speech";

const LOCATION = process.env.STT_LOCATION ?? "global";
const MODEL = process.env.STT_MODEL ?? "long";
const SAMPLE_RATE = 16_000;
/**
 * 認識が確定してから、続きが来ないか待つ時間。
 * 「小学2年生」と「です」のように、ひと続きの発話が複数の確定に割れることがある。
 * 待たずに切ると文が欠ける。
 */
export const SETTLE_MS = Number(process.env.STT_SETTLE_MS ?? 900);
/**
 * 日本語は文の途中で息を継ぐことが多い。
 * 「体験をお願いしたいんですけど…」で切ると、話の途中で応答してしまう。
 * 語尾がまだ続きそうな形なら、この分だけ余計に待つ。
 */
const CONTINUATION_MS = Number(process.env.STT_CONTINUATION_MS ?? 800);
/** まだ続きそうな語尾。読点で終わっている場合も継続とみなす */
const CONTINUING = /(、|けど|けれど|ですが|ますが|でして|ので|から|なので|して|くて|とか|など|で|て|が|し|と)$/;
/** Google 側が「話し終わった」と判断するまでの無音の長さ */
const SPEECH_END_TIMEOUT_MS = Number(process.env.STT_SPEECH_END_MS ?? 1200);
/**
 * 確定が一度も来ないまま途中経過だけが続いた場合の打ち切り。
 * ここに頼るのは例外時だけなので、長めに取ってある。
 */
const PARTIAL_TIMEOUT_MS = Number(process.env.STT_PARTIAL_TIMEOUT_MS ?? 2500);
/** v2 のストリームは開きっぱなしにできない。手前で張り直す */
const STREAM_MAX_MS = 4 * 60 * 1000;

let client = null;
let recognizerPath = null;

async function getClient() {
  if (!client) {
    client = new speech.v2.SpeechClient(
      LOCATION === "global" ? {} : { apiEndpoint: `${LOCATION}-speech.googleapis.com` }
    );
  }
  if (!recognizerPath) {
    const projectId = await client.getProjectId();
    recognizerPath = `projects/${projectId}/locations/${LOCATION}/recognizers/_`;
  }
  return client;
}

/**
 * 教室の電話で頻出する語を認識側に教える(§7.3 聞き取り精度)。
 * 何も指定しないと「小学」が「同額」に化けるといった取り違えが起きる。
 */
const PHRASES = [
  "体験レッスン",
  "体験",
  "見学",
  "入会",
  "小学",
  "中学",
  "年生",
  // 学年は電話の帯域(8kHz)だと崩れやすい。実測で「小5」が「兵庫」になった
  "小1",
  "小2",
  "小3",
  "小4",
  "小5",
  "小6",
  "中1",
  "中2",
  "中3",
  "年長",
  "年中",
  "英会話",
  "月謝",
  "振替",
  "欠席",
  "遅刻",
  "駐車場",
  "曜日",
];

/**
 * まだ話し続けそうかを語尾で判断する。
 * 自動句読点が付くので、末尾の句点は落としてから見る。
 */
export function stillTalking(text) {
  const tail = String(text ?? "").replace(/[。．！？!?\s]+$/u, "");
  return tail !== "" && CONTINUING.test(tail);
}

function streamingConfig({ encoding, sampleRateHertz }) {
  return {
    config: {
      adaptation: {
        phraseSets: [
          {
            inlinePhraseSet: {
              phrases: PHRASES.map((value) => ({ value })),
              boost: 10,
            },
          },
        ],
      },
      explicitDecodingConfig: { encoding, sampleRateHertz, audioChannelCount: 1 },
      languageCodes: ["ja-JP"],
      model: MODEL,
      features: { enableAutomaticPunctuation: true },
    },
    streamingFeatures: {
      interimResults: true,
      enableVoiceActivityEvents: true,
      // 一番早く切る設定にしない。話の途中で応答するより、少し待つほうがよい
      endpointingSensitivity: "ENDPOINTING_SENSITIVITY_STANDARD",
      voiceActivityTimeout: {
        speechEndTimeout: {
          seconds: Math.floor(SPEECH_END_TIMEOUT_MS / 1000),
          nanos: (SPEECH_END_TIMEOUT_MS % 1000) * 1e6,
        },
      },
    },
  };
}

/**
 * 認識セッションを1つ作る。
 *
 * 音声形式は入口によって違う。
 *   ブラウザ: 16kHz の LINEAR16
 *   電話    : 8kHz の μ-law(Twilio がそのまま送ってくる形式)
 * どちらも Google 側が対応しているので、変換せずそのまま流す。
 *
 * @param {(text: string) => void} onPartial 途中経過(画面表示用)
 * @param {(text: string) => void} onUtterance 発話が切れたときの確定テキスト
 */
export async function createRecognizer({
  onPartial,
  onUtterance,
  encoding = "LINEAR16",
  sampleRateHertz = SAMPLE_RATE,
}) {
  const speechClient = await getClient();

  let stream = null;
  let openedAt = 0;
  let timer = null;
  let finalText = "";
  let partialText = "";
  let lastEmitted = "";
  let lastEmittedAt = 0;
  let closed = false;
  /** 合成音声の再生中は認識結果を捨てる(自分の声を拾わないため) */
  let muted = false;

  function clearTimer() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  /**
   * 溜まっているテキストを1つの発話として確定する。
   *
   * 確定できたらストリームを張り直す。Google は確定済みのテキストを
   * そのストリーム内で再送してくることがあり、そのまま使い続けると
   * 前の発話の断片が次の発話に混ざる。1発話1ストリームにすれば起きない。
   * 張り直しの間は応答生成と音声合成が走っているので、待ち時間には出ない。
   */
  function flush() {
    clearTimer();
    const text = (finalText || partialText).trim();
    finalText = "";
    partialText = "";
    if (!text || muted) return;
    if (text === lastEmitted && Date.now() - lastEmittedAt < 2000) return;
    lastEmitted = text;
    lastEmittedAt = Date.now();
    restart();
    onUtterance(text);
  }

  function armTimer(ms) {
    clearTimer();
    timer = setTimeout(flush, ms);
  }

  function openStream() {
    stream = speechClient._streamingRecognize();
    openedAt = Date.now();

    stream.on("data", (res) => {
      if (res.speechEventType === "SPEECH_ACTIVITY_END") {
        // ここで即座に閉じない。文末の確定がこの後に届くことがあるため、
        // 待機タイマーに任せて取りこぼしを防ぐ
        armTimer(SETTLE_MS);
        return;
      }
      for (const result of res.results ?? []) {
        const text = result.alternatives?.[0]?.transcript ?? "";
        if (!text) continue;
        if (result.isFinal) {
          finalText += text;
          partialText = "";
          // 続きの確定が来るかもしれないので、少し待ってから発話を閉じる。
          // まだ言い終わっていなさそうな語尾なら、さらに待つ
          armTimer(SETTLE_MS + (stillTalking(finalText) ? CONTINUATION_MS : 0));
        } else {
          partialText = text;
          onPartial?.((finalText + text).trim());
          // まだ何も確定していないなら、認識が働いていない場合に備えて長めに待つ
          armTimer(finalText ? SETTLE_MS : PARTIAL_TIMEOUT_MS);
        }
      }
    });

    stream.on("error", (err) => {
      if (closed) return;
      console.error("[stt] ストリームエラー:", err.message);
      closeStream();
    });

    stream.on("end", () => {
      if (!closed) closeStream();
    });

    stream.write({
      recognizer: recognizerPath,
      streamingConfig: streamingConfig({ encoding, sampleRateHertz }),
    });
  }

  /**
   * ストリームを畳む。ここでは開き直さない。
   * AIが喋っている間は音声が流れてこないので、開けたままだと Google 側で
   * 「音声が来ない」とタイムアウトされる。次に音声が届いた時点で開き直す。
   */
  function closeStream() {
    try {
      stream?.removeAllListeners();
      stream?.end();
    } catch {
      // 畳む途中で落ちても問題ない
    }
    stream = null;
  }

  const restart = closeStream;

  return {
    /** 音声をそのまま流す。ブラウザなら16kHz PCM、電話なら8kHz μ-law */
    write(pcm) {
      if (closed) return;
      if (stream && Date.now() - openedAt > STREAM_MAX_MS) closeStream();
      if (!stream) openStream();
      try {
        stream.write({ audio: pcm });
      } catch (err) {
        console.error("[stt] 書き込み失敗:", err.message);
        closeStream();
      }
    },
    /** 合成音声の再生中に呼ぶ。自分の声を要件として拾わないようにする */
    setMuted(next) {
      muted = next;
      if (next) {
        clearTimer();
        finalText = "";
        partialText = "";
      }
    },
    close() {
      closed = true;
      clearTimer();
      closeStream();
    },
  };
}
