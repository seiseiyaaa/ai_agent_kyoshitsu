/**
 * 通知と仮予約の登録(要件書 §5.1 / §5.2 / §3.3[6])。
 *
 * 仕様に合わせて出し分ける。
 *   体験申込・質問・在籍者の連絡 → 即時
 *   営業電話                     → 即時に出さず、まとめ通知用に貯める(§5.2)
 *
 * メールは src/lib/mail.ts と同じ考え方で、キー未設定ならコンソール出力のモック。
 * 仮予約は Google カレンダーに「【仮】」付きで入れる。確定は人がやる(§3.3[6])。
 */

import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GoogleAuth } from "google-auth-library";

import { summarizeCall } from "./claude.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.join(HERE, "..", "logs");

const WEEKDAY_INDEX = { 日: 0, 月: 1, 火: 2, 水: 3, 木: 4, 金: 5, 土: 6 };

// ---- メール ----

async function sendMail({ to, subject, text }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey || !to) {
    console.log("\n===== [通知モック] =====");
    console.log(`To: ${to || "(宛先未設定)"}`);
    console.log(`件名: ${subject}`);
    console.log("------------------------");
    console.log(text);
    console.log("========================\n");
    return { ok: true, mode: "mock" };
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: process.env.MAIL_FROM, to, subject, text }),
  });
  return { ok: res.ok, mode: "resend" };
}

// ---- SMS(§5.1) ----

/**
 * SMSを送る。Twilio の認証情報が無ければコンソールに出すだけ(src/lib/mail.ts と同じ考え方)。
 *
 * 日本の携帯宛は、Twilio が日本の送信用番号を出していないため、
 * 米国番号か、事前登録した英数字の送信者IDから送ることになる。
 * 英数字の送信者IDは一方向のみで、有料アカウントが前提。
 */
async function sendSms({ to, text }) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_SMS_FROM;

  if (!sid || !token || !from || !to) {
    console.log("\n===== [SMSモック] =====");
    console.log(`宛先: ${to || "(未設定)"}`);
    console.log("-----------------------");
    console.log(text);
    console.log(`(${text.length}文字)`);
    console.log("=======================\n");
    return { ok: true, mode: "mock" };
  }

  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ To: to, From: from, Body: text }),
  });
  if (!res.ok) console.error("[notify] SMS送信に失敗:", await res.text());
  return { ok: res.ok, mode: "twilio" };
}

// ---- 通知文(§5.1) ----

function formatStamp(iso) {
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(
    d.getMinutes()
  ).padStart(2, "0")}`;
}

const INTENT_LABEL = {
  trial: "体験申込",
  question: "質問・相談",
  message: "在籍者からの連絡",
  sales: "営業電話",
  unclear: "要件不明",
};

export function buildNotification(summary, recap = "") {
  // 見学は体験と分けて表示する。折り返しの準備が違う
  const label =
    summary.intent === "trial" && summary.visitType === "tour"
      ? "見学申込"
      : INTENT_LABEL[summary.intent] ?? "問い合わせ";
  const lines = [`【${label}】${formatStamp(summary.startedAt)}`];

  // 在籍生徒の登録番号なら、名乗りが無くても誰のご家庭かは分かっている
  const who = summary.name
    ? `${summary.name}さま`
    : summary.knownStudent
      ? `${summary.knownStudent}さんのご家庭`
      : "お名前未取得";
  const grade = summary.gradeLabel ? `(${summary.gradeLabel})` : "";
  const what =
    label === "体験申込" ? "体験のお問い合わせ" : label === "見学申込" ? "見学のお問い合わせ" : "お電話";
  lines.push(`${who}${grade}から${what}`);

  // 在籍生徒の登録番号からの着信は、誰の関係者かが先生には一番の情報
  if (summary.knownStudent) {
    const g = summary.knownStudentGrade ? `(${summary.knownStudentGrade})` : "";
    lines.push(`在籍: ${summary.knownStudent}さん${g}の登録番号から`);
  }

  if (summary.slot) {
    lines.push(`ご希望: ${summary.slot} ${summary.courseName}`);
  } else if (summary.needsConsult) {
    // 日時が確定していない仮予約。先生が調整する前提であることを一目で分かるようにする
    const wish = summary.requestedTime ? `「${summary.requestedTime}」` : "指定なし";
    lines.push(`ご希望: ${wish} ※日時は要相談`);
    if (summary.courseName) lines.push(`コース: ${summary.courseName}`);
  }
  lines.push(`連絡先: ${summary.phone || "未取得"}`);
  if (!summary.name && !summary.knownStudent && summary.callerNumber) {
    lines.push("※ お名前は聞き取れていません");
  }

  // §5.3 通話の要約。作れなかった場合は付けずに、確定した項目だけを送る
  if (recap) lines.push("", recap);

  return { subject: `【${label}】${who}`, text: lines.join("\n") };
}

// ---- 仮予約(Google カレンダー) ----

/** 「火曜日の16時」から直近の該当日時を出す */
function nextOccurrence(weekday, startAt, from = new Date()) {
  const target = WEEKDAY_INDEX[weekday];
  if (target == null) return null;
  const [h, m] = startAt.split(":").map(Number);
  const d = new Date(from);
  d.setHours(h, m ?? 0, 0, 0);
  let delta = (target - d.getDay() + 7) % 7;
  if (delta === 0 && d <= from) delta = 7;
  d.setDate(d.getDate() + delta);
  return d;
}

/**
 * カレンダーに仮予約を入れる。CALENDAR_ID 未設定なら何もしない。
 * サービスアカウントを使う場合、対象カレンダーをそのアドレスに共有しておくこと。
 */
export async function createTentativeBooking(summary, slotRaw) {
  const calendarId = process.env.CALENDAR_ID;
  if (!calendarId || !slotRaw) return { ok: false, reason: "カレンダー未設定" };

  const start = nextOccurrence(slotRaw.weekday, slotRaw.startAt);
  if (!start) return { ok: false, reason: "日時を解決できませんでした" };
  const end = new Date(start.getTime() + 60 * 60 * 1000);

  try {
    const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/calendar.events"] });
    const clientAuth = await auth.getClient();
    const res = await clientAuth.request({
      url: `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
      method: "POST",
      data: {
        // §3.3[6] 確定ではないことを、カレンダー上でも一目で分かるようにする
        summary: `【仮】体験 ${summary.name || "お名前未取得"}さま ${summary.gradeLabel}`,
        description: [
          `コース: ${summary.courseName}`,
          `連絡先: ${summary.phone || "未取得"}`,
          "AI一次応答による仮予約です。先生の確認後に確定してください。",
        ].join("\n"),
        start: { dateTime: start.toISOString(), timeZone: "Asia/Tokyo" },
        end: { dateTime: end.toISOString(), timeZone: "Asia/Tokyo" },
        status: "tentative",
      },
    });
    return { ok: true, eventId: res.data.id };
  } catch (err) {
    console.error("[notify] 仮予約の登録に失敗:", err.message);
    return { ok: false, reason: err.message };
  }
}

// ---- 通話1件の後処理 ----

/**
 * 通話が終わったら呼ぶ。ログを残し、必要なら通知と仮予約を出す。
 * §5.2 に従い、営業電話は即時通知しない。
 */
export async function handleCallEnd(summary, slotRaw) {
  await mkdir(LOG_DIR, { recursive: true });
  await appendFile(path.join(LOG_DIR, "calls.jsonl"), `${JSON.stringify(summary)}\n`, "utf8");

  if (summary.intent === "sales") {
    await appendFile(path.join(LOG_DIR, "sales.jsonl"), `${JSON.stringify(summary)}\n`, "utf8");
    return { notified: false, booking: null };
  }

  const booking = summary.booked ? await createTentativeBooking(summary, slotRaw) : null;
  const recap = await summarizeCall(summary.turns ?? []);
  const notification = buildNotification(summary, recap ?? "");

  // §5.1 SMSとメールの両方に出す。どちらかが失敗しても、もう片方は届かせる
  const [sms, mail] = await Promise.allSettled([
    sendSms({ to: process.env.CLASSROOM_NOTIFY_SMS ?? "", text: notification.text }),
    sendMail({ to: process.env.CLASSROOM_NOTIFY_EMAIL ?? "", ...notification }),
  ]);
  if (sms.status === "rejected") console.error("[notify] SMS:", sms.reason?.message);
  if (mail.status === "rejected") console.error("[notify] メール:", mail.reason?.message);

  return { notified: true, booking, recap };
}
