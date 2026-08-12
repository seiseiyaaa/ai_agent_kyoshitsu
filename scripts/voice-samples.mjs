/**
 * 冒頭アナウンスの読み上げサンプルを作る。声と文言を耳で選ぶための道具。
 *
 * 「留守電っぽい」と感じる原因は主に2つある。
 *   1. effectsProfileId の telephony-class-application(電話帯域を模したフィルタ)
 *   2. 一文が長く、区切りが無いこと
 * どちらも切り替えて比べられるようにしてある。
 *
 *   node phone-agent/scripts/voice-samples.mjs
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import textToSpeech from "@google-cloud/text-to-speech";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "..", "samples");
const client = new textToSpeech.TextToSpeechClient();

/** いまの文言。一文が長く、AIであることが「自動音声」に埋もれている */
const CURRENT =
  "あおば英会話教室でございます。" +
  "ただいま担当者が席を外しておりますので、自動音声で承ります。" +
  "内容は録音させていただきます。 どのようなご用件でしょうか。";

/** 短く区切り、AIが出ていることを先に言う(§3.2 / §8.4) */
const REVISED =
  "お電話ありがとうございます。あおば英会話教室です。" +
  "ただいま担当者が席を外しております。" +
  "AIが代わりに、ご用件をお伺いします。" +
  "通話は録音させていただきます。" +
  "それでは、ご用件をお聞かせください。";

const CASES = [
  { id: "1-現行", voice: "ja-JP-Chirp3-HD-Aoede", telephony: true, text: CURRENT },
  { id: "2-Aoede", voice: "ja-JP-Chirp3-HD-Aoede", telephony: false, text: REVISED },
  { id: "3-Autonoe", voice: "ja-JP-Chirp3-HD-Autonoe", telephony: false, text: REVISED },
  { id: "4-Callirrhoe", voice: "ja-JP-Chirp3-HD-Callirrhoe", telephony: false, text: REVISED },
  { id: "5-Despina", voice: "ja-JP-Chirp3-HD-Despina", telephony: false, text: REVISED },
  // Neural2 は Chirp3 と違って発話速度を指定できる(§7.2)
  { id: "6-Neural2", voice: "ja-JP-Neural2-B", telephony: false, text: REVISED, rate: 0.95 },
];

await mkdir(OUT, { recursive: true });

for (const c of CASES) {
  const [res] = await client.synthesizeSpeech({
    input: { text: c.text },
    voice: { languageCode: "ja-JP", name: c.voice },
    audioConfig: {
      audioEncoding: "MP3",
      ...(c.rate ? { speakingRate: c.rate } : {}),
      ...(c.telephony ? { effectsProfileId: ["telephony-class-application"] } : {}),
    },
  });
  const file = path.join(OUT, `${c.id}.mp3`);
  await writeFile(file, Buffer.from(res.audioContent));
  console.log(
    `${c.id.padEnd(14)} ${c.voice.padEnd(26)} ` +
      `電話フィルタ=${c.telephony ? "あり" : "なし"} → samples/${c.id}.mp3`
  );
}

console.log(`\n出力先: ${OUT}`);
