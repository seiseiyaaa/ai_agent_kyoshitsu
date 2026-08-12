/**
 * LLM の担当範囲(要件書 §7.4)。
 *
 * ここがやるのは2つだけ。
 *   1. 発話の要件分類とスロット抽出(interpret)
 *   2. 定型で返せない場合の応答文生成(composeReply)
 *
 * 会話の進行制御は dialog.mjs のステートマシンが持つ。LLM には渡さない。
 * 事実(料金・空き枠・住所)も生成させない。渡した事実の外に出たら定型文へ落とす(§3.4)。
 */

import Anthropic from "@anthropic-ai/sdk";

const MODEL = process.env.PHONE_AGENT_MODEL ?? "claude-haiku-4-5";

let client = null;
function getClient() {
  if (!client) client = new Anthropic();
  return client;
}

export function isConfigured() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

// ---- 1. 要件分類とスロット抽出 ----

/**
 * 空文字 = 聞き取れなかった、を意味する。null を使わないのは
 * 構造化出力のスキーマを単純に保つため。
 */
const INTERPRET_SCHEMA = {
  type: "object",
  properties: {
    intent: {
      type: "string",
      enum: ["trial", "question", "message", "sales", "unclear"],
      description:
        "trial=体験・見学・入会の申込 / question=料金や場所などの質問 / message=在籍生徒の欠席・遅刻などの連絡 / sales=業者からの営業 / unclear=判断できない",
    },
    visitType: {
      type: "string",
      enum: ["lesson", "tour", "none"],
      description:
        "体験レッスン(授業に参加)の話なら lesson、教室見学(見るだけ)の話なら tour。" +
        "intent が何であっても、見学の希望や言い直しが出たら tour を入れる。どちらでもなければ none",
    },
    feeling: {
      type: "string",
      enum: ["hesitation", "concern", "none"],
      description:
        "発話ににじむ気持ち。hesitation=迷い・検討中(「迷ってる」「どうしようかな」) / " +
        "concern=不安・心配(「初心者だけど大丈夫か」「ついていけるか」) / none=特になし",
    },
    grade: { type: "string", description: "子どもの学年。発話のまま。なければ空文字" },
    siblingGrade: {
      type: "string",
      description:
        "同じ通話で、もう一人のお子さまの学年が出たらその学年。" +
        "「下の子も」「小2の子もいるので一緒に」など。なければ空文字",
    },
    courseHint: { type: "string", description: "希望コースを示す語。なければ空文字" },
    slotChoice: { type: "string", description: "選ばれた曜日・時刻。なければ空文字" },
    personName: { type: "string", description: "名乗られた氏名。なければ空文字" },
    phone: { type: "string", description: "伝えられた電話番号(数字のみ)。なければ空文字" },
    affirmation: {
      type: "string",
      enum: ["yes", "no", "none"],
      description:
        "直前の確認に対する肯定・否定。no には否定だけでなく辞退も含む" +
        "(「いえ」「大丈夫です」「結構です」「もう平気です」など)",
    },
    questionTopic: {
      type: "string",
      enum: [
        "fee",
        "location",
        "parking",
        "schedule",
        "course",
        "material",
        "comparison",
        "policy",
        "discount",
        "student_info",
        "suitability",
        "other",
        "none",
      ],
      description:
        "質問の対象。material=教材の詳細 / comparison=他教室との比較 / policy=指導方針 / " +
        "discount=割引の可否 / student_info=在籍生徒の情報 / " +
        "suitability=その子に合うか・ついていけるか・レベルや上達の相談。" +
        "これらは教室が答える領域なので、取り違えずに選ぶこと",
    },
  },
  required: [
    "intent",
    "visitType",
    "feeling",
    "grade",
    "siblingGrade",
    "courseHint",
    "slotChoice",
    "personName",
    "phone",
    "affirmation",
    "questionTopic",
  ],
  additionalProperties: false,
};

const INTERPRET_SYSTEM = `あなたは学習塾の電話一次応答システムの、聞き取り担当です。
保護者の発話を読み、要件の分類と項目の抽出だけを行います。返答文は作りません。

判断の指針:
- 業者名を名乗る、サービスの提案、料金プランの案内といった文言があれば sales とする。
- 体験・見学・入会の希望は trial。授業に参加するなら visitType=lesson、見るだけなら tour。
- 料金・場所・時間割などを「聞いているだけ」で申込の意思が無いものは question。
  申込の意思(「お願いしたい」「申し込みたい」「受けたい」)が無ければ trial にしない。
- すでに通っている子の欠席・遅刻・振替の連絡は message。
- 判断がつかないときは無理に決めず unclear を選ぶ。
- 電話番号は数字だけを取り出す。聞き取れない桁があるなら空文字にする。
- 推測で埋めない。発話に無い情報は空文字のままにする。
- 質問の対象は、聞かれた内容そのもので選ぶ。「教材について教えてください」は material であって
  course や schedule ではない。近い項目に寄せず、当てはまるものが無ければ other を選ぶ。`;

/**
 * 発話を解釈する。API未設定・失敗時は unclear を返し、
 * ステートマシン側のフォールバック(§7.5)に処理を渡す。
 */
export async function interpret({ utterance, state, lastPrompt }) {
  const empty = {
    intent: "unclear",
    visitType: "none",
    feeling: "none",
    grade: "",
    siblingGrade: "",
    courseHint: "",
    slotChoice: "",
    personName: "",
    phone: "",
    affirmation: "none",
    questionTopic: "none",
  };
  if (!isConfigured() || !utterance?.trim()) return empty;

  try {
    const res = await getClient().messages.create({
      model: MODEL,
      max_tokens: 512,
      system: INTERPRET_SYSTEM,
      output_config: { format: { type: "json_schema", schema: INTERPRET_SCHEMA } },
      messages: [
        {
          role: "user",
          content:
            `いまの会話の段階: ${state}\n` +
            `直前にこちらが言ったこと: ${lastPrompt || "(なし)"}\n` +
            `保護者の発話: ${utterance}`,
        },
      ],
    });
    const text = res.content.find((b) => b.type === "text")?.text ?? "";
    return { ...empty, ...JSON.parse(text) };
  } catch (err) {
    console.error("[claude] interpret 失敗:", err.message);
    return empty;
  }
}

// ---- 2. 応答文の生成 ----

/**
 * 半角化した上で、文字列に含まれる数値を列挙する(src/lib/chat-ai.ts と同じ考え方)。
 *
 * 桁区切りのカンマは落としてから数える。これをやらないと、こちらが「8250」と
 * 渡した月謝を Claude が「8,250円」と書いただけで「8」と「250」の2つに割れ、
 * 事実に無い数値を作ったと誤判定して正しい回答を捨ててしまう。
 */
function extractNumbers(s) {
  const half = s
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/(?<=\d)[,，](?=\d)/g, "");
  return new Set(half.match(/\d+/g) ?? []);
}

/**
 * 事実に書かれていない否定を作っていないか調べる。
 *
 * 数値のチェックだけでは足りない。「駐車場は近隣にコインパーキングあり」という事実から
 * 「教室に駐車場はございません」と断定してしまう例が実際に出た。もっともらしいが、
 * こちらが渡していない情報であり §3.4 の「憶測で答えない」に反する。
 * プロンプトで戒めるだけでは確率的に漏れるので、ここで機械的に落とす。
 */
function hasInventedNegation(facts, output) {
  // 「申し訳ございません」は詫びの定型句であって、事実の否定ではない
  const body = output.replace(/申し訳(ございません|ありません)/g, "");
  const NEGATION =
    /(ございません|ありません|おりません|できません|不可|承っておりません|はなく|がなく|はない|がない)/;
  if (!NEGATION.test(body)) return false;
  return !/(ない|なし|不可|ございません|ありません|できません|未対応|満席)/.test(facts.join("\n"));
}

/**
 * 渡した事実の外に出ていないか検証する。
 * 出ていれば false = 憶測で答えている(§3.4)。
 */
export function passesFactGuard(facts, output) {
  const allowed = extractNumbers(facts.join("\n"));
  for (const n of extractNumbers(output)) {
    if (!allowed.has(n)) return false;
  }
  return !hasInventedNegation(facts, output);
}

// ---- 3. 通話の要約(§5.3) ----

const SUMMARY_SYSTEM = `あなたは学習塾の電話一次応答システムの、要約担当です。
通話の記録を読み、教室の先生が折り返す前に目を通す短い要約を作ります。

守ること:
- 3行以内。1行は30文字程度まで。
- 通話に出てきたことだけを書く。推測や補足を足さない。
- 先生が次に何をすればよいか分かる書き方にする。
- 聞き取れていない項目があれば、その旨を明記する。
- 見出しや箇条書きの記号は使わない。行を分けるだけにする。`;

/**
 * 通話記録から要約を作る。
 * 失敗しても通知は出したいので、作れなければ null を返して呼び出し側に任せる。
 */
export async function summarizeCall(turns) {
  if (!isConfigured() || turns.length === 0) return null;

  const transcript = turns
    .map((t) => `保護者: ${t.utterance}\n教室(AI): ${t.reply}`)
    .join("\n");

  try {
    const res = await getClient().messages.create({
      model: MODEL,
      max_tokens: 300,
      system: SUMMARY_SYSTEM,
      messages: [{ role: "user", content: `通話の記録:\n${transcript}\n\n要約だけを出力してください。` }],
    });
    const text = (res.content.find((b) => b.type === "text")?.text ?? "").trim();
    if (!text) return null;
    // 通話に出ていない数値を作っていないか(§3.4 と同じ考え方)
    if (!passesFactGuard([transcript], text)) {
      console.warn("[claude] 要約が通話に無い内容を含むため破棄:", text);
      return null;
    }
    return text;
  } catch (err) {
    console.error("[claude] summarizeCall 失敗:", err.message);
    return null;
  }
}

// ---- 4. 言い方を整える(内容は変えない) ----

const REPHRASE_SYSTEM = `あなたは学習塾の電話応対です。
これから「伝えるべき内容」を渡します。内容はそのままに、いまの会話の流れに合った
自然な話し言葉にし直してください。

守ること:
- 伝えるべき内容に書かれていない事実(料金・日時・空き状況・可否)を足さない。数値は書かれたものだけ。
- 内容を削らない。質問が含まれていれば必ず質問で終える。
- 電話なので短く。2文まで、合わせて70文字程度。
- 相手が不安や迷いを見せているときは、必ず短く受け止めてから本題に入る。
  「添えてよい事実」が渡されていれば、その不安に関係するものを1つ選んで使う。
  関係するものが無ければ、事実を足さずに受け止めるだけにする。
- それ以外の場面では相づちを付けない。言われていないことへの共感は最悪。
- 「かしこまりました」「承知いたしました」を毎回付けない。会話が硬くなる。
- 過剰にへりくだらない。教室の受付が普通に話す調子で。`;

/**
 * 伝える内容は変えずに、言い方だけ会話の流れに合わせる。
 *
 * ステートマシンが決めた文をそのまま読むと、定型の連結になって不自然になる。
 * かといって内容の決定をLLMに渡すと会話が壊れる(§7.4)。
 * そこで「何を言うか」はステートマシン、「どう言うか」だけここ、と分ける。
 * 失敗したら元の文をそのまま使う。
 */
export async function rephrase({ text, history, facts = [] }) {
  if (!isConfigured() || !text) return null;

  try {
    const res = await getClient().messages.create({
      model: MODEL,
      max_tokens: 300,
      system: REPHRASE_SYSTEM,
      messages: [
        {
          role: "user",
          content:
            `直近のやりとり:\n${history || "(なし)"}\n\n` +
            `伝えるべき内容:\n${text}\n\n` +
            (facts.length > 0
              ? `添えてよい事実(必要なときだけ1つ):\n${facts.map((f) => `- ${f}`).join("\n")}\n\n`
              : "") +
            `言い直した文だけを出力してください。`,
        },
      ],
    });
    const out = (res.content.find((b) => b.type === "text")?.text ?? "").trim();
    if (!out) return null;
    // 元の文と、添えてよい事実の外に出ていないか(§3.4)
    if (!passesFactGuard([text, ...facts], out)) {
      console.warn("[claude] 言い直しが内容を超えたため破棄:", out);
      return null;
    }
    return out;
  } catch (err) {
    console.error("[claude] rephrase 失敗:", err.message);
    return null;
  }
}

/** §3.4 回答範囲外へ逃がす定型文。ここが最後の砦なので生成に頼らない */
export const HANDOFF_LINE =
  "そちらは先生からご説明させていただきます。折り返しご連絡いたしますので、お名前とお電話番号をお願いできますでしょうか。";

const COMPOSE_SYSTEM = `あなたは学習塾の電話一次応答システムの、応答文担当です。
与えられた事実だけを使って、電話で読み上げる短い日本語の文を1つ作ります。

守ること:
- 事実として与えられていないことは一切言わない。数値は与えられたものだけを使う。
- 1文か2文。長くても60文字程度。電話なので聞いて分かる言い回しにする。
- 敬体。過度にへりくだらない。
- 相槌や前置き(「かしこまりました」等)だけで終わらせず、必ず用件に答える。
- 事実に書かれていないことは、教材・他教室との比較・指導方針・割引を含め一切触れない。
  逆に、事実として与えられていれば答えてよい(先生が承認した案内事項のため)。
- 聞かれたことにだけ答える。事実を全部並べない。
  「土曜日のクラスはありますか」に対して全曜日の時間割を読み上げるのは誤り。
  関係する事実だけを選んで答える。
- 与えられた事実から推測した断定を足さない。とくに「〜はございません」といった
  否定は、そう書かれていない限り言わない。書かれていることだけを述べる。`;

/**
 * 定型で返せない場面の応答文を作る。
 *
 * 作れなかったときは null を返す。逃がし文をここで返してしまうと、
 * 呼び出し側が「答えられた」と誤解して後ろに別の文をつなげ、
 * 意味の通らない応答になる。どう逃がすかは呼び出し側が決める。
 */
export async function composeReply({ situation, facts, question = "", allowNoAnswer = false }) {
  if (!isConfigured()) return null;

  try {
    const res = await getClient().messages.create({
      model: MODEL,
      max_tokens: 256,
      system: COMPOSE_SYSTEM,
      messages: [
        {
          role: "user",
          content:
            `場面: ${situation}\n` +
            (question ? `保護者の発話: ${question}\n` : "") +
            `\n使ってよい事実:\n${facts.map((f) => `- ${f}`).join("\n")}\n\n` +
            (allowNoAnswer
              ? `事実の中に質問への答えが無い場合は、他の何も書かず NOANSWER とだけ出力してください。\n`
              : "") +
            `読み上げる文だけを出力してください。`,
        },
      ],
    });
    const text = (res.content.find((b) => b.type === "text")?.text ?? "").trim();
    if (!text || text.includes("NOANSWER")) return null;
    if (!passesFactGuard(facts, text)) {
      console.warn("[claude] 事実ガードに抵触したため破棄:", text);
      return null;
    }
    return text;
  } catch (err) {
    console.error("[claude] composeReply 失敗:", err.message);
    return null;
  }
}
