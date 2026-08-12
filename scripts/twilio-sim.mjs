/**
 * Twilio のふりをして、電話の経路をまるごと1本流す。
 *
 * Twilio Media Streams と同じ手順(connected → start → media → mark → stop)で
 * サーバとやり取りする。実際に番号を買う前に、電話側の配線を確かめられる。
 *
 *   PORT=8790 node phone-agent/scripts/twilio-sim.mjs [台本ID]
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

import { synthesize } from "../lib/tts.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT ?? "8788";
const FRAME_BYTES = 160; // μ-law 8kHz の20ミリ秒

const scenarios = JSON.parse(
  await readFile(path.join(HERE, "..", "data", "scenarios.json"), "utf8")
);
const scenario = scenarios.find((s) => s.id === (process.argv[2] ?? "trial-basic"));
if (!scenario) {
  console.error(`台本が見つかりません: ${process.argv[2]}`);
  process.exit(1);
}

console.log(`台本: ${scenario.id} — ${scenario.note}\n`);
console.log("保護者の発話を電話の音声形式(8kHz μ-law)で合成しています...");
const clips = [];
for (const text of scenario.utterances) {
  clips.push({ text, mulaw: await synthesize(text, "phone") });
}
console.log(`  ${clips.length}件を用意しました\n`);

const ws = new WebSocket(`ws://localhost:${PORT}/twilio/stream`);
const streamSid = "MZsimulated0000000000000000000000";

/** サーバから届いた音声の長さ。再生時間ぶん待ってから目印を返すために使う */
let receivedBytes = 0;
let resolvePlayback = null;
const waitForPlayback = () => new Promise((r) => (resolvePlayback = r));
let stopped = false;

ws.on("open", () => {
  ws.send(JSON.stringify({ event: "connected", protocol: "Call", version: "1.0.0" }));
  ws.send(
    JSON.stringify({
      event: "start",
      streamSid,
      start: {
        streamSid,
        callSid: "CAsimulated",
        tracks: ["inbound"],
        mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 },
        customParameters: { from: scenario.callerNumber },
      },
    })
  );
});

ws.on("message", (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.event === "media") {
    receivedBytes += Buffer.from(msg.media.payload, "base64").length;
    return;
  }
  if (msg.event === "mark") {
    // 8000バイト = 1秒。実際の受話者と同じだけ待ってから「聞き終わった」と返す
    const playMs = (receivedBytes / 8000) * 1000;
    receivedBytes = 0;
    setTimeout(() => {
      ws.send(JSON.stringify({ event: "mark", streamSid, mark: { name: msg.mark.name } }));
      resolvePlayback?.();
    }, Math.min(playMs, 12000));
  }
});

ws.on("close", () => {
  stopped = true;
  resolvePlayback?.();
});

ws.on("error", (err) => {
  console.error(`\nサーバに接続できません(ポート ${PORT})。`);
  console.error(`  ${err.message}`);
  process.exit(1);
});

await waitForPlayback(); // 冒頭アナウンスの再生完了を待つ

for (const clip of clips) {
  if (stopped) break;
  console.log(`保護者(送信): ${clip.text}`);
  for (let i = 0; i < clip.mulaw.length; i += FRAME_BYTES) {
    if (stopped) break;
    ws.send(
      JSON.stringify({
        event: "media",
        streamSid,
        media: { payload: clip.mulaw.subarray(i, i + FRAME_BYTES).toString("base64") },
      })
    );
    await new Promise((r) => setTimeout(r, 20));
  }
  // 発話の切れ目を作る無音(μ-law の無音は 0xFF)
  const silence = Buffer.alloc(FRAME_BYTES, 0xff);
  for (let i = 0; i < 50 && !stopped; i += 1) {
    ws.send(JSON.stringify({ event: "media", streamSid, media: { payload: silence.toString("base64") } }));
    await new Promise((r) => setTimeout(r, 20));
  }
  if (!stopped) await waitForPlayback();
}

if (!stopped) {
  ws.send(JSON.stringify({ event: "stop", streamSid, stop: { callSid: "CAsimulated" } }));
  await new Promise((r) => setTimeout(r, 3000));
}
ws.close();
console.log("\n通話を終了しました。サーバ側のログに結果が出ています。");
process.exit(0);
