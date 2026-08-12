/**
 * 通話フローのステートマシン(要件書 §3.1 / §3.3 / §7.4)。
 *
 * 進行はここが全部持つ。LLM は分類と応答文だけで、次にどこへ行くかは決めない。
 * 会話が迷子になると通話が破綻するため(§7.4)、遷移は明示的に書く。
 */

import {
  availableSlots,
  coursesForGrade,
  findStudentByPhone,
  gradeLabel,
  normalizeGrade,
  slotLabel,
} from "./classroom.mjs";
import { composeReply, HANDOFF_LINE, interpret } from "./claude.mjs";

/** §7.4 これだけ続けて意図が取れなければ、連絡先の聴取に切り替える */
const UNCLEAR_LIMIT = 3;

export const STATES = {
  OPENING: "OPENING",
  INTENT: "INTENT",
  TRIAL_GRADE: "TRIAL_GRADE",
  TRIAL_COURSE: "TRIAL_COURSE",
  TRIAL_SLOT: "TRIAL_SLOT",
  TRIAL_SLOT_CONFIRM: "TRIAL_SLOT_CONFIRM",
  CONTACT_NAME: "CONTACT_NAME",
  CALLER_NUMBER_CONFIRM: "CALLER_NUMBER_CONFIRM",
  CONTACT_PHONE: "CONTACT_PHONE",
  CONTACT_CONFIRM: "CONTACT_CONFIRM",
  MESSAGE_MORE: "MESSAGE_MORE",
  DONE: "DONE",
};

/**
 * 固定文(§7.1「定型的な応答は生成せず、事前録音または即時合成で返す」)。
 * ここに置いた文は起動時に TTS へ流して音声を作り置きする。
 */
export const FIXED_LINES = {
  askIntent: "どのようなご用件でしょうか。",
  askGrade: "お子さまは何年生でいらっしゃいますか。",
  askGradeAgain: "恐れ入ります、お子さまの学年をもう一度お願いできますでしょうか。",
  askName: "お名前をお願いいたします。",
  askPhone: "お電話番号をお願いいたします。",
  /**
   * §7.3 電話番号は誤認識が起きやすい。発信者番号が取れているなら、
   * 11桁を言わせて聞き取るより、この番号でよいかを確かめるほうが確実。
   */
  confirmCallerNumber: "ご連絡先は、いまおかけのお電話番号でよろしいでしょうか。",
  askPhoneAgain: "恐れ入ります、お電話番号をもう一度ゆっくりお願いできますでしょうか。",
  handoff: HANDOFF_LINE,
  salesClose: "担当者へお伝えします。失礼いたします。",
  messageAck: "承りました。担当者へお伝えいたします。失礼いたします。",
  /** 伝言はいったん受けてから、追加が無いか確かめる。一方的に切らない */
  messageMore: "承りました。先生にお伝えいたします。ほかにご用件はございますか。",
  /** reception モード: 案内は先生が折り返しで行う */
  receptionLead: "承知いたしました。詳しいご案内は先生から折り返しいたします。",
  checkWithTeacher: "そちらは先生に確認いたします。折り返しご連絡いたしますので、少々お待ちくださいませ。",
  /**
   * 時間割に無い日時、満席の枠、開講時間が違う場合。
   * 「できません」で終わらせず、希望として預かって先生につなぐ。
   * ここで切ると、体験の見込み客をそのまま失う。
   */
  consultTime: "ご希望の日時は先生に確認いたします。ご希望として承っておきますので、",
  thanks: "ありがとうございました。失礼いたします。",
  fallback:
    "申し訳ございません。担当者から折り返しご連絡いたします。お名前とお電話番号をお願いできますでしょうか。",
};

/**
 * 冒頭アナウンス(§3.2)。
 * AIであることを明示し、録音を告げる。「レッスン中」とは断定しない。
 */
export function openingLine(classroom, knownStudent = null) {
  // 一文を短く切る。長く続けると読み下しになって留守番電話のように聞こえる。
  // 「自動音声」ではなく「AI」と言い切る(§3.2 / §8.4)。録音の告知は必須(§8.1)。
  if (knownStudent) {
    // 在籍生徒の登録番号からの着信。予約フローに引き込まず、伝言を促す
    return (
      `${classroom.name}です。先生に代わって、AIが対応します。` +
      `${knownStudent.name}さんのご登録のお電話番号からですね。` +
      `ご用件は先生にお伝えしますので、どうぞお話しください。` +
      `通話は録音させていただきます。`
    );
  }
  return (
    `${classroom.name}です。先生に代わって、AIが対応します。よろしくお願いいたします。` +
    `通話は録音させていただきます。それでは、ご用件をどうぞ。`
  );
}

/**
 * 教室データから決まる文を先に全部書き出す(§7.1 定型は生成せず作り置き)。
 *
 * 空き枠の案内や日時の確認は、学年と枠の組み合わせで数が決まる。
 * 実測すると、これらの合成に0.7〜1.5秒かかっていて応答の遅延の主因だった。
 * 起動時に合成しておけば、通話中は取り出すだけで済む。
 */
export function predictableLines(classroom) {
  const lines = [];

  for (const course of classroom.courses) {
    const { offerable } = availableSlots(course);
    for (const slot of course.slots) {
      lines.push(`${slotLabel(slot)}でよろしいでしょうか。`);
      lines.push(
        `${slotLabel(slot)}で仮のお申し込みを承りました。先生から改めてご連絡いたします。 ${FIXED_LINES.thanks}`
      );
      lines.push(
        `お電話をいただいた番号へ、先生からご連絡いたします。 ` +
          `${slotLabel(slot)}で仮のお申し込みを承りました。先生から改めてご連絡いたします。 ${FIXED_LINES.thanks}`
      );
    }

    for (let grade = course.gradeMin; grade <= course.gradeMax; grade += 1) {
      const shown = offerable.slice(0, 2).map(slotLabel);
      if (shown.length === 0) continue;
      const when = shown.length === 1 ? shown[0] : `${shown[0]}か、${shown[1]}`;
      lines.push(
        `${gradeLabel(grade)}ですと、${when}に空きがございます。ご希望はいかがでしょうか。`
      );
    }
  }

  // 学年に複数コースがある場合の選択肢提示
  for (let grade = 0; grade <= 9; grade += 1) {
    const candidates = coursesForGrade(classroom, grade);
    if (candidates.length < 2) continue;
    const names = candidates.map((c) => c.name).join("と");
    lines.push(`${gradeLabel(grade)}ですと、${names}がございます。どちらをご希望でしょうか。`);
  }

  // 見学の言い回し
  for (const course of classroom.courses) {
    const { offerable } = availableSlots(course);
    const shown = offerable.slice(0, 2).map(slotLabel);
    if (shown.length === 0) continue;
    const when = shown.length === 1 ? shown[0] : `${shown[0]}か、${shown[1]}`;
    for (let grade = course.gradeMin; grade <= course.gradeMax; grade += 1) {
      lines.push(
        `${gradeLabel(grade)}の授業ですと、${when}にございます。ご見学のご希望はいかがでしょうか。`
      );
    }
    for (const slot of course.slots) {
      lines.push(
        `${slotLabel(slot)}でご見学の仮のお申し込みを承りました。先生から改めてご連絡いたします。 ${FIXED_LINES.thanks}`
      );
    }
  }

  // 在籍生徒の登録番号からの着信に出す冒頭文
  for (const student of classroom.students) {
    lines.push(openingLine(classroom, student));
  }

  lines.push(`先生から折り返しご連絡いたします。 ${FIXED_LINES.thanks}`);
  lines.push(
    `仮のお申し込みとして承りました。日時は先生から改めてご相談させていただきます。 ${FIXED_LINES.thanks}`
  );
  return lines;
}

export function createSession({ classroom, callerNumber = "" }) {
  return {
    classroom,
    callerNumber,
    /** 発信者番号が在籍生徒の登録番号と一致した場合、その生徒 */
    knownStudent: findStudentByPhone(classroom, callerNumber),
    /** lesson=体験レッスン / tour=教室見学 */
    visitType: "lesson",
    state: STATES.OPENING,
    unclearCount: 0,
    intent: "",
    answeredQuestion: false,
    grade: null,
    course: null,
    offered: [],
    slot: null,
    /** 時間割に無い日時を希望された場合の、発話そのまま */
    requestedTime: "",
    /** 日時を先生と詰める必要がある状態。仮予約自体は取る */
    needsConsult: false,
    name: "",
    phone: "",
    lastPrompt: "",
    turns: [],
    startedAt: Date.now(),
  };
}

/** 通話の開始。冒頭アナウンス＋用件の聞き取りへ */
export function begin(session) {
  session.state = STATES.INTENT;
  // 冒頭文の中で用件を促しているので、askIntent を重ねない
  const say = openingLine(session.classroom, session.knownStudent);
  session.lastPrompt = say;
  return { say, done: false };
}

// ---- 電話番号 ----

function digitsOnly(s) {
  return String(s ?? "")
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/\D/g, "");
}

/** 1桁ずつ区切って読み上げる(§7.2 数字は明瞭に) */
function spellPhone(phone) {
  return digitsOnly(phone).split("").join("、");
}

/**
 * 学年は発話の字面を優先して読む。
 * LLMの抽出は「中学2年生」を「2年生」に丸めることがあり、字面のほうが確実。
 * 字面から読めないときだけ LLM の抽出に頼る。
 */
function gradeFrom(read, utterance) {
  return normalizeGrade(utterance) ?? normalizeGrade(read.grade);
}

function plausiblePhone(phone) {
  const d = digitsOnly(phone);
  return d.length >= 10 && d.length <= 11;
}

// ---- 各段階の処理 ----

/**
 * 日時が決まらないまま希望だけ預かる。
 * 「時間割に無い」「満席」「開講時間が違う」はいずれも断る理由にならず、
 * 先生が調整できる余地があるため、仮予約として残す。
 */
function goConsult(session, requestedTime) {
  session.needsConsult = true;
  if (requestedTime) session.requestedTime = String(requestedTime).trim();
  return goContact(session, FIXED_LINES.consultTime);
}

function goContact(session, lead) {
  session.state = STATES.CONTACT_NAME;
  return { say: lead ? `${lead} ${FIXED_LINES.askName}` : FIXED_LINES.askName, done: false };
}

/** §3.3[3] 空き枠の提示。満席と鮮度切れは classroom.mjs 側で除外済み */
function offerSlots(session) {
  const { offerable, stale } = availableSlots(session.course);

  if (offerable.length === 0) {
    // 提示できる枠が無い(満席、または §4.3 の鮮度切れ)。
    // ここで断らず、希望として預かって先生に渡す
    return goConsult(session, "");
  }

  session.offered = offerable.slice(0, 2);
  session.state = STATES.TRIAL_SLOT;
  const labels = session.offered.map(slotLabel);
  const when = labels.length === 1 ? labels[0] : `${labels[0]}か、${labels[1]}`;
  const say =
    session.visitType === "tour"
      ? `${gradeLabel(session.grade)}の授業ですと、${when}にございます。ご見学のご希望はいかがでしょうか。`
      : `${gradeLabel(session.grade)}ですと、${when}に空きがございます。ご希望はいかがでしょうか。`;
  session.lastPrompt = say;
  return { say, done: false };
}

function pickCourse(session, hint) {
  const candidates = coursesForGrade(session.classroom, session.grade);
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];
  if (hint) {
    const hit = candidates.find((c) => c.name.includes(hint) || hint.includes(c.name));
    if (hit) return hit;
  }
  return null;
}

function matchSlot(session, choice) {
  if (!choice) return null;
  const text = String(choice);
  return (
    session.offered.find((s) => text.includes(s.weekday)) ??
    session.offered.find((s) => text.includes(String(Number(s.startAt.split(":")[0])))) ??
    null
  );
}

/**
 * §3.4「回答してよい」に挙がっている項目だけを列挙する。
 * ここに無いもの(教材の詳細・他教室との比較・指導方針・割引・在籍生徒の情報)は
 * 教室が答える領域なので、AIは触れずに人へ渡す。
 */
const ANSWERABLE_TOPICS = new Set(["fee", "location", "parking", "schedule", "course"]);

/** §3.4 回答してよい範囲の質問に答える。範囲外は null を返して逃がす */
async function answerQuestion(session, topic, question) {
  const c = session.classroom;

  if (!ANSWERABLE_TOPICS.has(topic)) {
    // §3.4 の定型範囲の外。ただし先生が承認した案内事項(notes)に答えが
    // 書かれていれば、その代読として答えてよい。無ければ null → 先生へ渡す
    if (c.notes.length === 0) return null;
    return composeReply({
      situation: "保護者からの問い合わせに、先生が用意した案内事項の範囲で答える",
      facts: c.notes,
      question,
      allowNoAnswer: true,
    });
  }

  const facts = [];
  switch (topic) {
    case "location":
      facts.push(`教室の住所は${c.address}`, `最寄りは${c.nearest}`);
      break;
    case "parking":
      facts.push(`駐車場は${c.parking}`);
      break;
    case "fee": {
      const withFee = c.courses.filter((x) => x.monthlyFee != null);
      if (withFee.length === 0) return null;
      for (const x of withFee) facts.push(`${x.name}の月謝は${x.monthlyFee}円`);
      break;
    }
    case "schedule":
    case "course": {
      // §3.4 曜日・時間・空き状況までは答えてよい。満席の枠を空きがあるように
      // 見せないよう、状況もそのまま事実として渡す
      const AVAIL = { open: "空きあり", few: "残りわずか", full: "満席" };
      for (const x of c.courses) {
        const target =
          x.gradeMin === x.gradeMax
            ? gradeLabel(x.gradeMin)
            : `${gradeLabel(x.gradeMin)}から${gradeLabel(x.gradeMax)}`;
        const when = x.slots.map((s) => `${slotLabel(s)}(${AVAIL[s.availability]})`).join("と");
        facts.push(`${x.name}の${target}のクラスは${when}`);
      }
      break;
    }
    default:
      return null;
  }
  // 学年ごとにコースを分けている都合上、同じ内容が何度も並ぶことがある。
  // 定型範囲の質問でも、案内事項に関連する補足(体験無料など)があれば使ってよい
  const unique = [...new Set([...facts, ...c.notes])];
  if (unique.length === 0) return null;
  return composeReply({
    situation: "保護者からの問い合わせに電話で答える",
    facts: unique,
    question,
  });
}

/**
 * 発話を1つ受け取り、次に読み上げる文を返す。
 * 例外は投げない。詰まったら必ず連絡先の聴取へ落とす(§7.5)。
 */
export async function step(session, utterance) {
  const read = await interpret({
    utterance,
    state: session.state,
    lastPrompt: session.lastPrompt,
  });
  const turn = { at: Date.now(), utterance, read, state: session.state, reply: "" };
  session.turns.push(turn);

  const result = await route(session, utterance, read);
  // 通話後の要約(§5.3)で使うため、こちらが何と答えたかも残す
  turn.reply = result.say;
  session.lastPrompt = result.say;
  return result;
}

/** 学年の言い直しを受け付ける段階。ここより後(電話番号の確認中など)は流れを乱すだけなので見ない */
const GRADE_CORRECTABLE_STATES = new Set([
  STATES.TRIAL_COURSE,
  STATES.TRIAL_SLOT,
  STATES.TRIAL_SLOT_CONFIRM,
  STATES.CONTACT_NAME,
]);

async function route(session, utterance, read) {
  // 営業電話はどの段階でも打ち切る(§3.5)
  if (read.intent === "sales") {
    session.intent = "sales";
    session.state = STATES.DONE;
    return { say: FIXED_LINES.salesClose, done: true };
  }

  // ---- 言い直しの受け付け(どの段階でも) ----
  // ステートマシンは「いま聞いていること」しか見ないので、途中の訂正は
  // ここでまとめて拾う。拾わないと同じ質問を繰り返して会話が壊れる。

  // 体験レッスン⇄教室見学の言い直し(「体験じゃなくて見学だけしたい」)。
  // LLMの抽出が取りこぼしても、発話に「見学」があれば字面で拾う
  if (session.intent === "trial") {
    const saysTour = read.visitType === "tour" || /見学/.test(utterance);
    const saysLesson = /体験/.test(utterance) && !/見学/.test(utterance);
    if (saysTour && session.classroom.settings.allowTour) session.visitType = "tour";
    else if (saysLesson) session.visitType = "lesson";
  }

  /**
   * 学年の言い直し。「2年生」は §7.3 に従い小学2年生と解釈するが、
   * 実際には中学2年生のことがある。訂正されたら学年の時点までさかのぼる。
   */
  const corrected = gradeFrom(read, utterance);
  if (
    session.intent === "trial" &&
    session.grade != null &&
    corrected != null &&
    corrected !== session.grade &&
    GRADE_CORRECTABLE_STATES.has(session.state)
  ) {
    session.unclearCount = 0;
    session.course = null;
    session.slot = null;
    session.offered = [];
    session.needsConsult = false;
    session.requestedTime = "";
    return enterGrade(session, corrected, read.courseHint);
  }

  // コースの言い直し(「やっぱり英検のほうで」)。枠選び以降で受け付ける
  if (
    session.intent === "trial" &&
    session.course != null &&
    read.courseHint &&
    (session.state === STATES.TRIAL_SLOT || session.state === STATES.TRIAL_SLOT_CONFIRM)
  ) {
    const candidates = coursesForGrade(session.classroom, session.grade);
    const hit = candidates.find(
      (x) => x !== session.course && (x.name.includes(read.courseHint) || read.courseHint.includes(x.name))
    );
    if (hit) {
      session.unclearCount = 0;
      session.course = hit;
      session.slot = null;
      return offerSlots(session);
    }
  }

  // 氏名の言い直し(「田中ではなく中田です」)。連絡先の確認中に受け付ける
  if (
    session.name &&
    read.personName &&
    read.personName.trim() !== session.name &&
    (session.state === STATES.CALLER_NUMBER_CONFIRM ||
      session.state === STATES.CONTACT_PHONE ||
      session.state === STATES.CONTACT_CONFIRM)
  ) {
    session.name = read.personName.trim();
    return { say: `失礼いたしました。${session.name}さまですね。${session.lastPrompt}`, done: false };
  }

  switch (session.state) {
    case STATES.INTENT: {
      // 「ほかにご不明な点は」への辞退。新しい質問も体験希望も無ければ、聞き直さず終える
      const declined = read.affirmation === "no" || read.questionTopic === "none";
      if (session.answeredQuestion && read.intent !== "trial" && declined) {
        session.state = STATES.DONE;
        return { say: FIXED_LINES.thanks, done: true };
      }
      if (read.intent === "trial") {
        session.intent = "trial";
        session.unclearCount = 0;
        if (
          (read.visitType === "tour" || /見学/.test(utterance)) &&
          session.classroom.settings.allowTour
        ) {
          session.visitType = "tour";
        }
        // 「個別で体験できますか」のように、申込に質問が乗っていることがある。
        // 案内事項で答えられるなら先に答え、そのまま予約の流れへ入る
        let prefix = "";
        const asksCondition = /(できますか|できるか|可能でしょうか|可能ですか|いいですか|よろしいですか)/.test(utterance);
        if (read.questionTopic !== "none" || asksCondition) {
          const topic = read.questionTopic !== "none" ? read.questionTopic : "other";
          const ans = await answerQuestion(session, topic, utterance);
          if (ans) prefix = `${ans} `;
        }
        // 学年をすでに言っているなら聞き直さない
        const g = gradeFrom(read, utterance);
        if (g != null) {
          const next = await enterGrade(session, g, read.courseHint);
          return { ...next, say: `${prefix}${next.say}` };
        }
        session.state = STATES.TRIAL_GRADE;
        return { say: `${prefix}${FIXED_LINES.askGrade}`, done: false };
      }
      if (read.intent === "question") {
        session.intent = "question";
        session.unclearCount = 0;
        const answer = await answerQuestion(session, read.questionTopic, utterance);
        if (answer) {
          session.answeredQuestion = true;
          session.state = STATES.INTENT;
          return { say: `${answer} ほかにご不明な点はございますか。`, done: false };
        }
        return goContact(session, HANDOFF_LINE);
      }
      if (read.intent === "message") {
        session.intent = "message";
        session.unclearCount = 0;
        // すぐ切らず、言い足りないことが無いか確かめる。内容は録音と要約に残る
        session.state = STATES.MESSAGE_MORE;
        return { say: FIXED_LINES.messageMore, done: false };
      }
      // 在籍生徒の登録番号からの着信は、分類に迷ったら伝言として受ける。
      // 冒頭で「先生にお伝えします」と案内しており、聞き返すと約束と食い違う
      if (session.knownStudent && read.intent === "unclear" && utterance.trim().length >= 8) {
        session.intent = "message";
        session.state = STATES.MESSAGE_MORE;
        return { say: FIXED_LINES.messageMore, done: false };
      }
      return unclear(session, FIXED_LINES.askIntent);
    }

    case STATES.MESSAGE_MORE: {
      // 体験や質問に切り替わったら通常の流れへ戻す
      if (read.intent === "trial" || read.intent === "question") {
        session.state = STATES.INTENT;
        return route(session, utterance, read);
      }
      // 「以上です」「特にないです」などの締めの言葉で終える
      const closing =
        read.affirmation === "no" ||
        /^(以上|特に|大丈夫|ない|無い|結構|いえ|いいえ|ありません|ございません)/.test(utterance.trim()) ||
        (read.intent === "unclear" && utterance.trim().length < 8);
      if (closing) {
        session.state = STATES.DONE;
        return { say: FIXED_LINES.thanks, done: true };
      }
      // まだ話している。受け続ける(内容は録音と要約が持つ)
      return { say: FIXED_LINES.messageMore, done: false };
    }

    case STATES.TRIAL_GRADE: {
      const g = gradeFrom(read, utterance);
      if (g == null) return unclear(session, FIXED_LINES.askGradeAgain);
      session.unclearCount = 0;
      return enterGrade(session, g, read.courseHint);
    }

    case STATES.TRIAL_COURSE: {
      const course = pickCourse(session, read.courseHint || utterance);
      if (!course) return unclear(session, "恐れ入ります、どちらのコースをご希望でしょうか。");
      session.unclearCount = 0;
      session.course = course;
      return offerSlots(session);
    }

    case STATES.TRIAL_SLOT: {
      const slot = matchSlot(session, read.slotChoice || utterance);
      if (!slot) {
        if (read.affirmation === "no") return goConsult(session, "");
        // 提示していない日時を希望された。満席・鮮度切れ・時間割に無い、のいずれか。
        // 空きの有無を憶測で答えず(§3.3[3] / §4.3)、希望として預かる
        const asked = String(read.slotChoice || utterance);
        if (/[日月火水木金土]|時|夕方|午前|午後|朝|昼/.test(asked)) {
          return goConsult(session, asked);
        }
        return unclear(session, "恐れ入ります、ご希望の曜日をもう一度お願いできますでしょうか。");
      }
      session.unclearCount = 0;
      session.slot = slot;
      session.state = STATES.TRIAL_SLOT_CONFIRM;
      return { say: `${slotLabel(slot)}でよろしいでしょうか。`, done: false };
    }

    case STATES.TRIAL_SLOT_CONFIRM: {
      // 確認の途中で別の枠を言い直された場合(「やっぱり金曜日で」)。
      // 同じ枠を繰り返しただけなら肯定として扱う
      const switched = matchSlot(session, read.slotChoice || utterance);
      if (switched && switched !== session.slot) {
        session.unclearCount = 0;
        session.slot = switched;
        return { say: `${slotLabel(switched)}でよろしいでしょうか。`, done: false };
      }
      if (read.affirmation === "no") {
        session.slot = null;
        return offerSlots(session);
      }
      if (read.affirmation !== "yes" && !switched) {
        return unclear(session, `${slotLabel(session.slot)}でよろしいでしょうか。`);
      }
      session.unclearCount = 0;
      return goContact(session, "");
    }

    case STATES.CONTACT_NAME: {
      const name = (read.personName || "").trim();
      if (!name) return unclear(session, FIXED_LINES.askName);
      session.unclearCount = 0;
      session.name = name;
      if (session.callerNumber) {
        session.state = STATES.CALLER_NUMBER_CONFIRM;
        return { say: `${name}さまですね。${FIXED_LINES.confirmCallerNumber}`, done: false };
      }
      session.state = STATES.CONTACT_PHONE;
      return { say: `${name}さまですね。${FIXED_LINES.askPhone}`, done: false };
    }

    case STATES.CALLER_NUMBER_CONFIRM: {
      if (read.affirmation === "yes") {
        session.phone = digitsOnly(session.callerNumber);
        return finish(session, "");
      }
      if (read.affirmation === "no") {
        session.state = STATES.CONTACT_PHONE;
        return { say: FIXED_LINES.askPhone, done: false };
      }
      // 数字を言われたのなら、それを連絡先として受け取る
      const spoken = digitsOnly(read.phone || utterance);
      if (plausiblePhone(spoken)) {
        session.phone = spoken;
        session.state = STATES.CONTACT_CONFIRM;
        return { say: `${spellPhone(spoken)}。こちらでお間違いないでしょうか。`, done: false };
      }
      return unclear(session, FIXED_LINES.confirmCallerNumber);
    }

    case STATES.CONTACT_PHONE: {
      const phone = digitsOnly(read.phone || utterance);
      if (!plausiblePhone(phone)) {
        // §7.3 発信者番号が取れていれば、聞き取れなくても折り返せる
        if (session.unclearCount + 1 >= UNCLEAR_LIMIT && session.callerNumber) {
          session.phone = digitsOnly(session.callerNumber);
          return finish(session, "お電話をいただいた番号へ、先生からご連絡いたします。");
        }
        return unclear(session, FIXED_LINES.askPhoneAgain);
      }
      session.unclearCount = 0;
      session.phone = phone;
      session.state = STATES.CONTACT_CONFIRM;
      // §7.3 電話番号は復唱して確認する
      return { say: `${spellPhone(phone)}。こちらでお間違いないでしょうか。`, done: false };
    }

    case STATES.CONTACT_CONFIRM: {
      if (read.affirmation === "no") {
        session.phone = "";
        session.state = STATES.CONTACT_PHONE;
        return { say: FIXED_LINES.askPhoneAgain, done: false };
      }
      if (read.affirmation !== "yes") {
        return unclear(session, `${spellPhone(session.phone)}。こちらでお間違いないでしょうか。`);
      }
      return finish(session, "");
    }

    default:
      return finish(session, "");
  }
}

function enterGrade(session, grade, courseHint) {
  session.grade = grade;

  // reception モード: 空き枠の案内はせず、用件と連絡先だけ預かる。
  // 案内の仕方を先生が自分で握りたい教室向けの設定
  if (session.classroom.settings.mode === "reception") {
    session.needsConsult = true;
    return goContact(session, FIXED_LINES.receptionLead);
  }

  const candidates = coursesForGrade(session.classroom, grade);

  if (candidates.length === 0) {
    // その学年のコースが無い。憶測で案内せず人へ渡す(§3.4)
    return goContact(session, FIXED_LINES.checkWithTeacher);
  }
  const course = pickCourse(session, courseHint);
  if (course) {
    session.course = course;
    return offerSlots(session);
  }
  session.state = STATES.TRIAL_COURSE;
  const names = candidates.map((c) => c.name).join("と");
  const say = `${gradeLabel(grade)}ですと、${names}がございます。どちらをご希望でしょうか。`;
  return { say, done: false };
}

/** §7.4 意図が取れないときの共通処理。上限に達したら連絡先へ切り替える */
function unclear(session, retryLine) {
  session.unclearCount += 1;
  if (session.unclearCount < UNCLEAR_LIMIT) return { say: retryLine, done: false };

  session.unclearCount = 0;
  // すでにお名前が取れていて発信者番号もあるなら、聞き直しを続けても得るものがない。
  // §7.5 の「最悪でも連絡先を取得して通知する」は満たせているので、ここで畳む
  if (session.name && session.callerNumber) {
    session.phone = digitsOnly(session.callerNumber);
    return finish(session, "お電話をいただいた番号へ、先生からご連絡いたします。");
  }
  return goContact(session, FIXED_LINES.fallback);
}

/** §3.3[6]「仮」であることを明示する。確定は必ず人が行う */
function finish(session, lead) {
  session.state = STATES.DONE;
  const parts = [];
  if (lead) parts.push(lead);
  if (session.slot) {
    const what = session.visitType === "tour" ? "ご見学の仮のお申し込み" : "仮のお申し込み";
    parts.push(
      `${slotLabel(session.slot)}で${what}を承りました。先生から改めてご連絡いたします。`
    );
  } else if (session.needsConsult) {
    // 日時は決まっていないが希望は預かった。§3.3[6] と同じく「仮」であることを明示する
    parts.push("仮のお申し込みとして承りました。日時は先生から改めてご相談させていただきます。");
  } else {
    parts.push("先生から折り返しご連絡いたします。");
  }
  parts.push(FIXED_LINES.thanks);
  return { say: parts.join(" "), done: true };
}

/** 通話の結果を1件のレコードにまとめる(§4.2 書き込むデータ) */
export function summarize(session) {
  return {
    startedAt: new Date(session.startedAt).toISOString(),
    durationMs: Date.now() - session.startedAt,
    intent: session.intent || "unclear",
    grade: session.grade,
    gradeLabel: session.grade == null ? "" : gradeLabel(session.grade),
    courseName: session.course?.name ?? "",
    slot: session.slot ? slotLabel(session.slot) : "",
    slotId: session.slot?.id ?? "",
    visitType: session.visitType,
    knownStudent: session.knownStudent?.name ?? "",
    knownStudentGrade: session.knownStudent?.grade ?? "",
    requestedTime: session.requestedTime,
    needsConsult: session.needsConsult,
    name: session.name,
    phone: session.phone || digitsOnly(session.callerNumber),
    callerNumber: session.callerNumber,
    // 日時が決まっていなくても、希望を預かって連絡先が取れていれば仮予約として扱う
    booked: Boolean(session.name && (session.slot || session.needsConsult)),
    turns: session.turns,
  };
}
