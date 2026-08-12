/**
 * 教室データの参照(要件書 §4.1「参照するデータ」/ §4.3「空き状況の鮮度」)。
 *
 * 既定はローカルJSON。CLASSROOM_SHEET_ID を設定すると Google スプレッドシートを見る。
 * どちらの経路でも同じ形に正規化して返すので、呼び出し側は出どころを知らなくてよい。
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GoogleAuth } from "google-auth-library";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** §4.3 これを超えて更新されていない枠は「空きあり」と案内しない */
const FRESHNESS_DAYS = 60;

// ---- 学年の正規化(§7.3「2年生」「小2」「小学2年」を同一に扱う) ----

const KANJI_DIGITS = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

function toHalfWidthDigits(s) {
  return s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
}

function readDigit(s) {
  const half = toHalfWidthDigits(s);
  const m = half.match(/\d/);
  if (m) return Number(m[0]);
  for (const [kanji, n] of Object.entries(KANJI_DIGITS)) {
    if (s.includes(kanji)) return n;
  }
  return null;
}

/**
 * 発話から学年を取り出す。小1〜6 を 1〜6、中1〜3 を 7〜9 として返す。
 * 判定できなければ null(呼び出し側が聞き直す)。
 */
export function normalizeGrade(text) {
  if (!text) return null;
  const s = toHalfWidthDigits(String(text));

  if (/年長|幼稚園|保育園|未就学/.test(s)) return 0;

  const chu = s.match(/中(?:学(?:校)?)?\s*([1-3一二三])\s*年?/);
  if (chu) {
    const n = readDigit(chu[1]);
    if (n) return n + 6;
  }

  const sho = s.match(/(?:小(?:学(?:校)?)?)\s*([1-6一二三四五六])\s*年?/);
  if (sho) {
    const n = readDigit(sho[1]);
    if (n) return n;
  }

  // 学年だけを言われた場合(「2年生」)は小学生として扱う(§7.3)
  const bare = s.match(/([1-6一二三四五六])\s*年生/);
  if (bare) {
    const n = readDigit(bare[1]);
    if (n) return n;
  }
  return null;
}

/** 学年番号を発話用の表記に戻す */
export function gradeLabel(grade) {
  if (grade === 0) return "未就学";
  if (grade <= 6) return `小学${grade}年生`;
  return `中学${grade - 6}年生`;
}

// ---- 読み込み ----

/**
 * 空き状況は3値で持つ(§4.1)。
 * アキコマの教室ページがこの3つで管理しているため、そこに合わせる。
 * 定員と在籍数で入力された場合は、そこから3値に落とす。
 */
const AVAILABILITY = { 空きあり: "open", 残りわずか: "few", 満席: "full" };

function normalizeAvailability(raw) {
  const given = AVAILABILITY[raw.availability] ?? raw.availability;
  if (given === "open" || given === "few" || given === "full") return given;

  const capacity = Number(raw.capacity ?? 0);
  const enrolled = Number(raw.enrolled ?? 0);
  const remaining = capacity - enrolled;
  if (remaining <= 0) return "full";
  return remaining <= 1 ? "few" : "open";
}

function normalizeSlot(raw) {
  return {
    id: String(raw.id ?? `${raw.weekday}-${raw.startAt}`),
    weekday: String(raw.weekday ?? "").replace(/曜日?$/, ""),
    startAt: String(raw.startAt ?? ""),
    capacity: raw.capacity == null ? null : Number(raw.capacity),
    availability: normalizeAvailability(raw),
    updatedAt: String(raw.updatedAt ?? ""),
  };
}

function normalizeClassroom(raw) {
  const settings = raw.settings ?? {};
  return {
    name: String(raw.name ?? ""),
    address: String(raw.address ?? ""),
    phone: String(raw.phone ?? ""),
    nearest: String(raw.nearest ?? ""),
    parking: String(raw.parking ?? ""),
    /**
     * 教室ごとの応答モード(教室運営者が選ぶ)。
     *   full      : 空き枠の提示から仮予約まで AI が進める(既定)
     *   reception : 受付だけ。用件と連絡先を預かり、案内は先生が折り返しで行う
     */
    settings: {
      mode: settings.mode === "reception" ? "reception" : "full",
      /** 教室見学(授業を見るだけ)を受け付けるか */
      allowTour: settings.allowTour !== false,
    },
    /**
     * 先生があらかじめ承認した案内事項。ここに書かれた内容は、
     * §3.4 の定型範囲を超えていても AI が答えてよい(先生の言葉の代読なので)。
     * 例:「個別の体験レッスンは日程調整のうえ対応可」「体験は無料」
     */
    notes: (raw.notes ?? []).map(String).filter(Boolean),
    /** 在籍生徒。電話番号が一致した着信は在籍者からの連絡として扱う */
    students: (raw.students ?? []).map((s) => ({
      name: String(s.name ?? ""),
      phone: String(s.phone ?? "").replace(/\D/g, ""),
      grade: String(s.grade ?? ""),
    })),
    courses: (raw.courses ?? []).map((c) => ({
      id: String(c.id ?? c.name),
      name: String(c.name ?? ""),
      gradeMin: Number(c.gradeMin ?? 0),
      gradeMax: Number(c.gradeMax ?? 9),
      monthlyFee: c.monthlyFee == null ? null : Number(c.monthlyFee),
      slots: (c.slots ?? []).map(normalizeSlot),
    })),
  };
}

// ---- 管理画面からの読み書き ----

/** 管理画面が編集対象にするファイル。スプレッドシート運用時は編集不可 */
export function classroomFilePath() {
  return process.env.CLASSROOM_JSON ?? path.join(HERE, "..", "data", "classroom.json");
}

export function isSheetMode() {
  return Boolean(process.env.CLASSROOM_SHEET_ID);
}

/** 生のJSON(コメント用フィールド等も含む)を返す。管理画面の編集用 */
export async function loadClassroomRaw() {
  const candidates = [
    classroomFilePath(),
    path.join(HERE, "..", "data", "classroom.sample.json"),
  ];
  for (const file of candidates) {
    try {
      return { file, raw: JSON.parse(await readFile(file, "utf8")) };
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
  }
  throw new Error("教室データが見つかりません");
}

/**
 * 管理画面から受け取った内容を検証する。
 * 保存してから通話が壊れるより、保存時に弾くほうがよい。
 */
export function validateClassroomRaw(raw) {
  const errors = [];
  if (!raw || typeof raw !== "object") return ["データの形式が不正です"];
  if (!String(raw.name ?? "").trim()) errors.push("教室名が空です");

  const mode = raw.settings?.mode;
  if (mode != null && mode !== "full" && mode !== "reception") {
    errors.push(`応答モードが不正です: ${mode}`);
  }

  for (const [i, s] of (raw.students ?? []).entries()) {
    const name = String(s.name ?? "").trim();
    const digits = String(s.phone ?? "").replace(/\D/g, "");
    if (!name) errors.push(`在籍生徒${i + 1}件目: お名前が空です`);
    if (digits.length < 10 || digits.length > 11) {
      errors.push(`在籍生徒${i + 1}件目(${name || "名前なし"}): 電話番号は10〜11桁で入力してください`);
    }
  }

  const AVAIL = new Set(["空きあり", "残りわずか", "満席", "open", "few", "full"]);
  for (const c of raw.courses ?? []) {
    for (const slot of c.slots ?? []) {
      if (slot.availability != null && !AVAIL.has(slot.availability)) {
        errors.push(`${c.name} ${slot.weekday}${slot.startAt}: 空き状況が不正です`);
      }
    }
  }
  return errors;
}

/** 検証済みの内容をファイルに書き戻す */
export async function saveClassroomRaw(raw) {
  const errors = validateClassroomRaw(raw);
  if (errors.length > 0) {
    const err = new Error(errors.join(" / "));
    err.validation = errors;
    throw err;
  }
  const { writeFile } = await import("node:fs/promises");
  await writeFile(classroomFilePath(), `${JSON.stringify(raw, null, 2)}\n`, "utf8");
}

/** 発信者番号が在籍生徒の登録番号と一致するか(下10〜11桁で比べる) */
export function findStudentByPhone(classroom, callerNumber) {
  const digits = String(callerNumber ?? "").replace(/\D/g, "");
  if (digits.length < 10) return null;
  const tail = digits.slice(-10);
  return classroom.students.find((s) => s.phone && s.phone.slice(-10) === tail) ?? null;
}

async function loadFromSheet(sheetId) {
  const auth = new GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
  const clientAuth = await auth.getClient();
  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}` +
    `/values:batchGet?ranges=classroom!A:B&ranges=courses!A:F&ranges=slots!A:F`;
  const res = await clientAuth.request({ url });
  const [meta, courses, slots] = res.data.valueRanges.map((r) => r.values ?? []);

  const info = Object.fromEntries(meta.slice(1).map((row) => [row[0], row[1] ?? ""]));
  const slotsByCourse = new Map();
  for (const row of slots.slice(1)) {
    const [courseId, id, weekday, startAt, capacity, enrolled, updatedAt] = row;
    if (!courseId) continue;
    if (!slotsByCourse.has(courseId)) slotsByCourse.set(courseId, []);
    slotsByCourse.get(courseId).push({ id, weekday, startAt, capacity, enrolled, updatedAt });
  }

  return normalizeClassroom({
    name: info["教室名"] ?? info.name,
    address: info["住所"] ?? info.address,
    phone: info["電話番号"] ?? info.phone,
    nearest: info["最寄り"] ?? info.nearest,
    parking: info["駐車場"] ?? info.parking,
    courses: courses.slice(1).map((row) => {
      const [id, name, gradeMin, gradeMax, monthlyFee] = row;
      return { id, name, gradeMin, gradeMax, monthlyFee, slots: slotsByCourse.get(id) ?? [] };
    }),
  });
}

/**
 * 教室データを読み込む。優先順は
 *   CLASSROOM_SHEET_ID → CLASSROOM_JSON → data/classroom.json → data/classroom.sample.json
 * 実際の教室を入れた classroom.json を置けば、設定なしでそちらを見る。
 */
export async function loadClassroom() {
  const sheetId = process.env.CLASSROOM_SHEET_ID;
  if (sheetId) return loadFromSheet(sheetId);

  const candidates = [
    process.env.CLASSROOM_JSON,
    path.join(HERE, "..", "data", "classroom.json"),
    path.join(HERE, "..", "data", "classroom.sample.json"),
  ].filter(Boolean);

  for (const file of candidates) {
    try {
      return normalizeClassroom(JSON.parse(await readFile(file, "utf8")));
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
  }
  throw new Error("教室データが見つかりません");
}

// ---- 空き枠の判定 ----

function daysSince(dateText, now) {
  if (!dateText) return Infinity;
  const t = Date.parse(dateText);
  if (Number.isNaN(t)) return Infinity;
  return (now.getTime() - t) / 86_400_000;
}

/** その学年で受けられるコース(§3.3[2] 該当年齢のコースのみを候補にする) */
export function coursesForGrade(classroom, grade) {
  if (grade == null) return [];
  return classroom.courses.filter((c) => grade >= c.gradeMin && grade <= c.gradeMax);
}

/**
 * 案内してよい空き枠を返す(§3.3[3] 満席枠は提示しない / §4.3 古い枠は案内しない)。
 *
 * 戻り値の stale は「空きはあるが情報が古い枠」。ここに該当したら
 * 呼び出し側は「先生に確認いたします」へ切り替える(§4.3)。
 */
export function availableSlots(course, now = new Date()) {
  const offerable = [];
  const stale = [];
  for (const slot of course.slots) {
    if (slot.availability === "full") continue; // 満席は提示しない
    if (daysSince(slot.updatedAt, now) > FRESHNESS_DAYS) stale.push(slot);
    else offerable.push(slot);
  }
  return { offerable, stale };
}

/** 「火曜日の16時」の形に整える(§7.2 数字と日時は明瞭に) */
export function slotLabel(slot) {
  const [h, m] = slot.startAt.split(":");
  const time = Number(m) === 0 ? `${Number(h)}時` : `${Number(h)}時${Number(m)}分`;
  return `${slot.weekday}曜日の${time}`;
}
