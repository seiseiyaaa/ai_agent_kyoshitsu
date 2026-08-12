/**
 * Google の音声合成と音声認識の疎通確認。マイクもスピーカーも要らない。
 *
 * 合成した音声をそのまま認識に流し込んで、元の文が戻ってくるかを見る。
 * 実機で喋る前に、認証・API有効化・音声形式がそろっているかをここで確かめる。
 *
 *   node phone-agent/scripts/check-google.mjs
 */

import { createRecognizer } from "../lib/stt.mjs";
import { currentVoice, synthesizePcm } from "../lib/tts.mjs";

/** ブラウザから送られてくるのと同じ粒度(16kHz / 16bit / 100ms)に刻む */
const CHUNK_BYTES = 3200;

const SAMPLES = [
  "体験レッスンをお願いしたいのですが",
  "小学2年生です",
  "090-1234-5678です",
];

console.log("1. 音声合成を試します...");
const clips = [];
for (const text of SAMPLES) {
  const pcm = await synthesizePcm(text);
  clips.push({ text, pcm });
  console.log(`   OK 「${text}」 → ${(pcm.length / 32000).toFixed(1)}秒`);
}
console.log(`   使用した声: ${currentVoice()}\n`);

console.log("2. 合成した音声を認識に流します...");
const heard = [];
const recognizer = await createRecognizer({
  onPartial: () => {},
  onUtterance: (text) => heard.push(text),
});

for (const clip of clips) {
  for (let i = 0; i < clip.pcm.length; i += CHUNK_BYTES) {
    recognizer.write(clip.pcm.subarray(i, i + CHUNK_BYTES));
    // 実時間に近い速さで流す。まとめて投げると認識側が発話を切り分けられない
    await new Promise((r) => setTimeout(r, 100));
  }
  // 発話の切れ目を作るための無音
  const silence = Buffer.alloc(CHUNK_BYTES);
  for (let i = 0; i < 12; i += 1) {
    recognizer.write(silence);
    await new Promise((r) => setTimeout(r, 100));
  }
}
await new Promise((r) => setTimeout(r, 1500));
recognizer.close();

console.log("");
/** 句読点や表記の揺れは見ない。内容が取れているかだけを判定する */
const strip = (s) => s.replace(/[、。ー\s-]/g, "");

let ok = 0;
for (let i = 0; i < SAMPLES.length; i += 1) {
  const got = heard[i];
  const match = got != null && strip(got) === strip(SAMPLES[i]);
  if (match) ok += 1;
  console.log(`   ${match ? "OK " : "NG "} 送った「${SAMPLES[i]}」 → 聞こえた「${got ?? "(なし)"}」`);
}
const segmented = heard.length === SAMPLES.length;
if (!segmented) {
  console.log(`\n   発話の区切りがずれています(送信 ${SAMPLES.length}件 → 確定 ${heard.length}件)`);
  console.log(`   確定した内容: ${JSON.stringify(heard)}`);
}

console.log(`\n区切り: ${segmented ? "OK" : "NG"} / 文字の一致: ${ok}/${SAMPLES.length}`);
console.log(
  [
    "",
    "ここで流しているのは合成音声です。人の声とは癖が違うので、",
    "文字が一致しなくても区切りが合っていれば疎通としては問題ありません。",
    "認識精度そのものは、実際に電話で話して測ってください。",
  ].join("\n")
);
// 疎通確認なので、発話を正しく切り分けられていれば合格とする
process.exit(segmented ? 0 : 1);
