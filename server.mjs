/**
 * AI電話一次応答の検証サーバ(要件書 第1工程)。
 *
 * ブラウザ(マイク・スピーカー) ── WebSocket ── ここ ── Google STT / Claude / Google TTS
 *
 * 050番号もキャリア転送も使わない。スピーカーフォン越しに自分の携帯からかけ、
 * 会話がどこまで成立するかだけを見る構成にしてある。
 * 着信数・応答率の実測(要件書 §11 第1段階)は別途 050 を発行して行う。
 */

import http from "node:http";
import { createReadStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GoogleAuth } from "google-auth-library";
import { WebSocketServer } from "ws";

import {
  isSheetMode,
  loadClassroom,
  loadClassroomRaw,
  saveClassroomRaw,
} from "./lib/classroom.mjs";
import { isConfigured as isClaudeConfigured } from "./lib/claude.mjs";
import {
  begin,
  createSession,
  FIXED_LINES,
  openingLine,
  predictableLines,
  step,
  summarize,
} from "./lib/dialog.mjs";
import { handleCallEnd } from "./lib/notify.mjs";
import { createRecognizer, SETTLE_MS } from "./lib/stt.mjs";
import { handleTwilioStream, twiml } from "./lib/twilio-stream.mjs";
import { currentVoice, synthesize, warmUp } from "./lib/tts.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(HERE, "public");
const LOG_DIR = path.join(HERE, "logs");
const PORT = Number(process.env.PORT ?? 8788);

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8" };

/**
 * GCPの認証を先に確かめる。
 * 認証が無いまま起動すると、音声クライアントが裏側で例外を投げてプロセスごと落ちる。
 * 何が足りないのか分からない落ち方をするので、手前で止めて手順を出す。
 */
async function requireGoogleCredentials() {
  try {
    await new GoogleAuth({
      scopes: ["https://www.googleapis.com/auth/cloud-platform"],
    }).getClient();
  } catch {
    console.error(
      [
        "",
        "GCPの認証情報が見つかりません。音声認識と音声合成が使えないため起動できません。",
        "",
        "  gcloud auth application-default login",
        "  gcloud services enable speech.googleapis.com texttospeech.googleapis.com",
        "",
      ].join("\n")
    );
    process.exit(1);
  }
}

/** 音声クライアントは裏で非同期に失敗することがある。通話1本のために落とさない */
process.on("unhandledRejection", (err) => {
  console.error("[警告] 処理されなかったエラー:", err?.message ?? err);
});

await requireGoogleCredentials();
/** 管理画面から保存されたら差し替える。通話中のセッションは古いまま、次の着信から新しい設定 */
let classroom = await loadClassroom();

// ---- HTTP(画面と録音の受け取り) ----

function sendJsonResponse(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  // ---- 管理画面(教室設定の閲覧・編集) ----
  if (req.url === "/admin" || req.url === "/admin/") {
    res.writeHead(302, { Location: "/admin.html" });
    res.end();
    return;
  }
  if (req.url === "/admin/api/classroom") {
    if (req.method === "GET") {
      const { file, raw } = await loadClassroomRaw();
      sendJsonResponse(res, 200, { file, sheetMode: isSheetMode(), data: raw });
      return;
    }
    if (req.method === "PUT") {
      if (isSheetMode()) {
        sendJsonResponse(res, 409, {
          error: "スプレッドシート(CLASSROOM_SHEET_ID)運用中のため、ここからは編集できません",
        });
        return;
      }
      const chunks = [];
      for await (const c of req) chunks.push(c);
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString());
      } catch {
        sendJsonResponse(res, 400, { error: "JSONとして読めませんでした" });
        return;
      }
      try {
        await saveClassroomRaw(body);
      } catch (err) {
        sendJsonResponse(res, 422, { error: err.message, details: err.validation ?? [] });
        return;
      }
      classroom = await loadClassroom();
      // 新しい教室データから決まる文を作り直す。待たせない(次の通話までに済めばよい)
      warmUp([
        ...Object.values(FIXED_LINES),
        openingLine(classroom),
        ...predictableLines(classroom),
      ]).catch((err) => console.warn("[tts] 再合成に失敗:", err.message));
      console.log(`[設定] 教室データを更新しました(生徒${classroom.students.length}名、案内事項${classroom.notes.length}件)`);
      sendJsonResponse(res, 200, { ok: true });
      return;
    }
  }

  /**
   * Twilio からの着信通知。ここで「音声をこのWebSocketに流してくれ」と返す。
   * 公開URLは固定できない(トンネルを張り直すと変わる)ので、
   * Twilio が送ってきた Host ヘッダーからそのまま組み立てる。
   */
  if (req.method === "POST" && req.url.startsWith("/twilio/voice")) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const form = new URLSearchParams(Buffer.concat(chunks).toString());
    const from = form.get("From") ?? "";
    console.log(`[着信通知] ${from} → ${form.get("To") ?? ""}`);

    res.writeHead(200, { "Content-Type": "text/xml; charset=utf-8" });
    res.end(twiml({ wsUrl: `wss://${req.headers.host}/twilio/stream`, from }));
    return;
  }

  if (req.method === "POST" && req.url === "/recording") {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    await mkdir(path.join(LOG_DIR, "recordings"), { recursive: true });
    const name = `${new Date().toISOString().replace(/[:.]/g, "-")}.webm`;
    await writeFile(path.join(LOG_DIR, "recordings", name), Buffer.concat(chunks));
    console.log(`[録音] logs/recordings/${name}`);
    res.writeHead(200).end("ok");
    return;
  }

  const rel = req.url === "/" ? "/index.html" : req.url.split("?")[0];
  const file = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ""));
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end("forbidden");
    return;
  }
  // ファイルが開けたことを確かめてからヘッダーを書く。
  // 先に200を書いてしまうと、存在しないファイル(ブラウザが勝手に取りにくる
  // /favicon.ico など)で404を書けずに例外になり、サーバごと落ちる。
  const stream = createReadStream(file);
  stream.once("open", () => {
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] ?? "application/octet-stream" });
    stream.pipe(res);
  });
  stream.once("error", () => {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("not found");
  });
});

// ---- WebSocket(通話1本 = 接続1本) ----

const wss = new WebSocketServer({ server });

/**
 * ws は HTTP サーバのエラーをこちらにも転送してくる。
 * 受け取り手がいないとプロセスごと落ちるので、必ず置いておく。
 * 起動時のポート衝突は listen() 側で拾って別のポートに逃がす。
 */
wss.on("error", (err) => {
  if (err.code !== "EADDRINUSE") console.error("[ws] エラー:", err.message);
});

wss.on("connection", (ws, req) => {
  // 電話からの接続はブラウザとは音声形式も合図の出し方も違うので、別で扱う
  if (req.url?.startsWith("/twilio/stream")) {
    handleTwilioStream(ws, { classroom });
    return;
  }
  let session = null;
  let recognizer = null;
  /** 発話が切れた時刻。ここから音声を返すまでが §1.3「応答の遅延」 */
  let utteranceEndAt = 0;
  let busy = false;
  /** クライアントがAIの音声を再生中か。再生中の発話は「被せ」として扱う */
  let playing = false;
  /** いま読み上げている文。認識結果が自声の回り込みかどうかの判定に使う */
  let speakingText = "";

  const send = (obj) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(obj));

  /**
   * 認識結果が、いま自分が読み上げている文の聞き取りではないか。
   * ブラウザのエコーキャンセルは完全ではなく、スピーカーの音を拾うことがある。
   * 被せ(バージイン)を許すには、この振り分けが要る。
   */
  function looksLikeEcho(heard) {
    if (!speakingText) return false;
    const norm = (t) => String(t).replace(/[、。．！？!?\s]/g, "");
    const h = norm(heard);
    const sp = norm(speakingText);
    if (h.length < 4) return true; // 再生中の短い切れ端はノイズ扱い
    return sp.includes(h) || sp.includes(h.slice(0, 6));
  }

  /** 文を合成して送る。認識は止めない(被せを受け付けるため) */
  async function speak(text, { measure = false } = {}) {
    const t0 = Date.now();
    let audio = null;
    try {
      audio = await synthesize(text);
    } catch (err) {
      console.error("[tts] 合成に失敗:", err.message);
    }
    const latencyMs = measure && utteranceEndAt ? Date.now() - utteranceEndAt : null;

    playing = true;
    speakingText = text;
    send({
      type: "say",
      text,
      audio: audio ? audio.toString("base64") : null,
      ttsMs: Date.now() - t0,
      latencyMs,
      // 発話終了を見極めるための待ち時間を引くと、体感の遅延に近づく
      latencyFromSpeechEndMs: latencyMs == null ? null : Math.max(0, latencyMs - SETTLE_MS),
    });
  }

  /** 応答を考えている間に届いた発話。捨てると長い発話の後半が消える */
  let pendingUtterances = [];

  async function onUtterance(text) {
    if (!session || session.state === "DONE") return;
    if (busy) {
      pendingUtterances.push(text);
      return;
    }
    if (playing) {
      // AIの発話中に声が届いた。自声の回り込みなら捨て、本物なら被せとして
      // 再生を打ち切って聞く側に回る
      if (looksLikeEcho(text)) return;
      send({ type: "interrupt" });
      playing = false;
      speakingText = "";
    }
    busy = true;
    utteranceEndAt = Date.now();
    send({ type: "heard", text });

    try {
      const result = await step(session, text);
      await speak(result.say, { measure: true });
      if (result.done) await endCall();
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

  async function endCall() {
    if (!session) return;
    const summary = summarize(session);
    const slotRaw = session.slot;
    session = null;
    recognizer?.close();
    recognizer = null;

    const outcome = await handleCallEnd(summary, slotRaw);
    send({ type: "ended", summary, outcome });
    console.log(
      `[通話終了] 要件=${summary.intent} 仮予約=${summary.booked ? summary.slot : "なし"} ` +
        `連絡先=${summary.phone || "未取得"}`
    );
  }

  ws.on("message", async (data, isBinary) => {
    if (isBinary) {
      recognizer?.write(data);
      return;
    }

    const msg = JSON.parse(data.toString());
    if (msg.type === "start") {
      session = createSession({ classroom, callerNumber: msg.callerNumber ?? "" });
      recognizer = await createRecognizer({
        onPartial: (text) => send({ type: "partial", text }),
        onUtterance,
      });
      const opening = begin(session);
      send({ type: "state", state: session.state });
      await speak(opening.say);
      return;
    }
    if (msg.type === "playback-done") {
      playing = false;
      speakingText = "";
      if (session) send({ type: "state", state: session.state });
      return;
    }
    if (msg.type === "hangup") {
      await endCall();
    }
  });

  ws.on("close", () => {
    recognizer?.close();
    recognizer = null;
    session = null;
  });
});

// ---- 起動 ----

await warmUp([
  ...Object.values(FIXED_LINES),
  openingLine(classroom),
  ...predictableLines(classroom),
]);

/**
 * 空いているポートで起動する。
 * 既定のポートを別のプロセスが使っていることは普通にあるので、
 * 起動失敗で終わらせず、隣のポートへずらして立ち上げる。
 */
function listen(port, remaining = 10) {
  server.once("error", (err) => {
    if (err.code !== "EADDRINUSE" || remaining === 0) throw err;
    console.warn(`[起動] ポート ${port} は使用中のため ${port + 1} を試します`);
    listen(port + 1, remaining - 1);
  });
  server.listen(port);
}

// 実際に着いたポートを1度だけ知らせる。listen の成功コールバックに書くと、
// 失敗した回のぶんも後からまとめて呼ばれて二重に出る
server.once("listening", () => {
  console.log(`\n教室: ${classroom.name}(コース ${classroom.courses.length}件)`);
  console.log(`Claude: ${isClaudeConfigured() ? "有効" : "未設定(要件分類が働きません)"}`);
  console.log(`音声: ${currentVoice()}`);
  console.log(`\n  http://localhost:${server.address().port}  を開いてください\n`);
});

listen(PORT);
