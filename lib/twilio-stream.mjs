/**
 * Twilio Media Streams との接続(要件書 §2.1 の着信を、実際の電話回線で受ける)。
 *
 * Twilio は着信の音声を WebSocket で送ってきて、こちらが返した音声を発信者に流す。
 * ブラウザ版と同じ形なので、会話・教室データ・通知はそのまま使い回せる。
 *
 * 音声は 8kHz μ-law。Google の音声認識も合成もこの形式を扱えるので、変換はしない。
 * 電話回線の帯域そのままで処理することになり、§7.2 の要件にも合う。
 */

import { begin, createSession, FIXED_LINES, step, summarize } from "./dialog.mjs";
import { handleCallEnd } from "./notify.mjs";
import { createRecognizer, SETTLE_MS } from "./stt.mjs";
import { synthesize } from "./tts.mjs";

/** μ-law 8kHz の 20ミリ秒ぶん。Twilio が期待する粒度 */
const FRAME_BYTES = 160;

/**
 * 着信時に Twilio へ返す指示(TwiML)。
 * <Connect><Stream> は双方向。<Start><Stream> だと音声を返せないので使わない。
 */
export function twiml({ wsUrl, from }) {
  const escape = (s) =>
    String(s ?? "").replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<Response>",
    "  <Connect>",
    `    <Stream url="${escape(wsUrl)}">`,
    `      <Parameter name="from" value="${escape(from)}" />`,
    "    </Stream>",
    "  </Connect>",
    "</Response>",
  ].join("\n");
}

/**
 * 通話1本ぶんの WebSocket を処理する。
 * ブラウザ版の wss ハンドラと役割は同じで、扱う音声形式と合図の出し方だけが違う。
 */
export function handleTwilioStream(ws, { classroom, onLog = console.log }) {
  let session = null;
  let recognizer = null;
  let streamSid = null;
  let utteranceEndAt = 0;
  let busy = false;
  let ended = false;
  /** 再生完了の合図に使う通し番号 */
  let markSeq = 0;
  let pendingMark = null;

  function sendJson(obj) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
  }

  /**
   * 音声を Twilio へ流し、最後に目印を置く。
   * 目印が返ってきた時点で発信者への再生が終わっているので、そこで認識を再開する。
   */
  async function speak(text, { measure = false } = {}) {
    const t0 = Date.now();
    let audio = null;
    try {
      audio = await synthesize(text, "phone");
    } catch (err) {
      console.error("[tts] 合成に失敗:", err.message);
      return;
    }

    for (let i = 0; i < audio.length; i += FRAME_BYTES) {
      sendJson({
        event: "media",
        streamSid,
        media: { payload: audio.subarray(i, i + FRAME_BYTES).toString("base64") },
      });
    }
    pendingMark = `say-${(markSeq += 1)}`;
    sendJson({ event: "mark", streamSid, mark: { name: pendingMark } });

    if (measure && utteranceEndAt) {
      // 発話終了を見極めるための待ち時間を引く。ブラウザ側の表示と同じ基準
      const felt = Math.max(0, Date.now() - utteranceEndAt - SETTLE_MS);
      onLog(`  AI: ${text}   [${felt}ms / 合成 ${Date.now() - t0}ms]`);
    } else {
      onLog(`  AI: ${text}`);
    }
  }

  /** 応答を考えている間に届いた発話。捨てると長い発話の後半が消える */
  let pendingUtterances = [];

  async function onUtterance(text) {
    if (!session || session.state === "DONE") return;
    if (busy) {
      pendingUtterances.push(text);
      return;
    }
    if (pendingMark) {
      // AIの発話中に保護者が話し始めた(被せ)。Twilio に溜まっている音声を
      // 捨てさせて、すぐ聞く側に回る。電話の受話音声には自声が混ざらないので
      // エコーの心配は無い
      sendJson({ event: "clear", streamSid });
      pendingMark = null;
    }
    busy = true;
    utteranceEndAt = Date.now();
    onLog(`  保護者: ${text}`);

    try {
      const result = await step(session, text);
      await speak(result.say, { measure: true });
      if (result.done) {
        // 最後の一言を言い終わるまで待ってから切る
        setTimeout(() => finish(), 6000);
      }
    } catch (err) {
      // §7.5 何が起きても、最悪「連絡先を取得して通知する」に落とす
      console.error("[dialog] 想定外の失敗:", err);
      await speak(FIXED_LINES.fallback);
    } finally {
      busy = false;
      // 考えている間に届いていた発話をまとめて処理する
      if (pendingUtterances.length > 0 && session && session.state !== "DONE") {
        const queued = pendingUtterances.join("、");
        pendingUtterances = [];
        await onUtterance(queued);
      }
    }
  }

  async function finish() {
    if (ended || !session) return;
    ended = true;
    const summary = summarize(session);
    const slotRaw = session.slot;
    session = null;
    recognizer?.close();
    recognizer = null;

    await handleCallEnd(summary, slotRaw);
    onLog(
      `[通話終了] 要件=${summary.intent} 仮予約=${summary.booked ? summary.slot : "なし"} ` +
        `連絡先=${summary.phone || "未取得"}`
    );
    if (ws.readyState === ws.OPEN) ws.close();
  }

  ws.on("message", async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    switch (msg.event) {
      case "start": {
        streamSid = msg.streamSid;
        const from = msg.start?.customParameters?.from ?? "";
        onLog(`\n[着信] ${from || "発信者番号なし"}`);

        session = createSession({ classroom, callerNumber: from });
        recognizer = await createRecognizer({
          onPartial: () => {},
          onUtterance,
          encoding: "MULAW",
          sampleRateHertz: 8000,
        });
        await speak(begin(session).say);
        return;
      }

      case "media": {
        // 自分が喋っている間に届く音は、自分の声の回り込みなので捨てる
        recognizer?.write(Buffer.from(msg.media.payload, "base64"));
        return;
      }

      case "mark": {
        if (msg.mark?.name === pendingMark) pendingMark = null;
        return;
      }

      case "stop": {
        await finish();
        return;
      }

      default:
        // connected など、こちらで何もしなくてよいイベント
        return;
    }
  });

  ws.on("close", () => {
    finish().catch(() => {});
  });
}
