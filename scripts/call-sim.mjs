/**
 * 通話をまるごと1本、ブラウザ無しで流す。
 *
 * 保護者の発話を音声合成して、ブラウザと同じ形式でサーバへ送り込む。
 * WebSocket・音声認識・会話・音声合成・通知まで、実機と同じ経路を通る。
 * 電話を持つ前に、配線がつながっているかをここで確かめる。
 *
 *   PORT=8788 node phone-agent/scripts/call-sim.mjs [台本ID]
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

import { synthesizePcm } from "../lib/tts.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT ?? "8788";
const CHUNK_BYTES = 3200; // 16kHz / 16bit / 100ms

const scenarios = JSON.parse(
  await readFile(path.join(HERE, "..", "data", "scenarios.json"), "utf8")
);
const scenario = scenarios.find((s) => s.id === (process.argv[2] ?? "trial-basic"));
if (!scenario) {
  console.error(`台本が見つかりません: ${process.argv[2]}`);
  process.exit(1);
}

console.log(`台本: ${scenario.id} — ${scenario.note}\n`);

console.log("保護者の発話を合成しています...");
const clips = [];
for (const text of scenario.utterances) {
  clips.push({ text, pcm: await synthesizePcm(text) });
}
console.log(`  ${clips.length}件を用意しました\n`);

const ws = new WebSocket(`ws://localhost:${PORT}`);
const latencies = [];
let summary = null;

/** サーバが喋り終える(= playback-done を返してよい)まで待つ */
let resolveSpoken = null;
const waitForSpoken = () => new Promise((r) => (resolveSpoken = r));

ws.on("open", () => {
  ws.send(JSON.stringify({ type: "start", callerNumber: scenario.callerNumber }));
});

ws.on("message", (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.type === "heard") {
    console.log(`  保護者(認識): ${msg.text}`);
  } else if (msg.type === "say") {
    const at = msg.latencyFromSpeechEndMs;
    console.log(`  AI: ${msg.text}${at == null ? "" : `   [${at}ms / 合成 ${msg.ttsMs}ms]`}`);
    if (at != null) latencies.push(at);
    // 実機では音声を再生している時間。合成にかかった長さぶん待つ
    setTimeout(() => {
      ws.send(JSON.stringify({ type: "playback-done" }));
      resolveSpoken?.();
    }, 300);
  } else if (msg.type === "ended") {
    summary = msg.summary;
  }
});

ws.on("error", (err) => {
  console.error(`\nサーバに接続できません(ポート ${PORT})。`);
  console.error(`  ${err.message}`);
  console.error("  npm run phone-agent でサーバを起動してから実行してください。");
  process.exit(1);
});

await waitForSpoken(); // 冒頭アナウンス

for (const clip of clips) {
  if (summary) break;
  console.log(`\n保護者(送信): ${clip.text}`);
  for (let i = 0; i < clip.pcm.length; i += CHUNK_BYTES) {
    ws.send(clip.pcm.subarray(i, i + CHUNK_BYTES));
    await new Promise((r) => setTimeout(r, 100));
  }
  // 発話の切れ目を作る無音
  const silence = Buffer.alloc(CHUNK_BYTES);
  for (let i = 0; i < 10 && !summary; i += 1) {
    ws.send(silence);
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!summary) await waitForSpoken();
}

if (!summary) {
  ws.send(JSON.stringify({ type: "hangup" }));
  await new Promise((r) => setTimeout(r, 2000));
}
ws.close();

console.log("\n──── 結果 ────");
if (summary) {
  console.log(`  要件: ${summary.intent}`);
  console.log(`  学年: ${summary.gradeLabel || "未取得"}`);
  console.log(`  仮予約: ${summary.slot || "なし"}`);
  console.log(`  お名前: ${summary.name || "未取得"}`);
  console.log(`  連絡先: ${summary.phone || "未取得"}`);
} else {
  console.log("  通話が終了しませんでした");
}
if (latencies.length > 0) {
  const avg = Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length);
  const within = latencies.filter((v) => v <= 1500).length;
  console.log(`\n  応答の遅延: 平均 ${avg}ms / 1.5秒以内 ${within}/${latencies.length}件`);
}
process.exit(0);
