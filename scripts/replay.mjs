/**
 * 台本を流して会話ロジックを採点する(要件書 §1.3「要件の聞き取り成功率 80%以上」)。
 *
 * 音声を通さずテキストだけで回すので、マイクなしで何度でも実行できる。
 * 会話設計を直したあと、壊れていないかをここで確認してから実機に移る。
 *
 *   node phone-agent/scripts/replay.mjs            全件
 *   node phone-agent/scripts/replay.mjs trial-basic 1件だけ
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadClassroom } from "../lib/classroom.mjs";
import { isConfigured } from "../lib/claude.mjs";
import { begin, createSession, step, summarize } from "../lib/dialog.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const only = process.argv[2];

if (!isConfigured()) {
  console.error("ANTHROPIC_API_KEY が未設定です。要件分類が働かないため採点できません。");
  process.exit(1);
}

const classroom = await loadClassroom();
const scenarios = JSON.parse(
  await readFile(path.join(HERE, "..", "data", "scenarios.json"), "utf8")
);

/**
 * 期待値と実際を突き合わせる。合致しなかった項目名を返す。
 * said は冒頭アナウンスを含む発話の配列。said[1] が最初の応答。
 */
/** 桁区切りのカンマは無視して比べる。「8250」と「8,250円」を別物にしないため */
const norm = (s) => String(s ?? "").replace(/(?<=\d)[,，](?=\d)/g, "");

function check(expect, summary, said, state) {
  const saidAll = norm(said.join("\n"));
  const failures = [];

  if (expect.ends && state !== "DONE") {
    failures.push(`台本を流し終えても通話が終わっていない(段階=${state})`);
  }

  if (expect.firstReplyIncludes && !norm(said[1]).includes(norm(expect.firstReplyIncludes))) {
    failures.push(`1手目の応答に「${expect.firstReplyIncludes}」が無い: ${said[1] ?? "(応答なし)"}`);
  }
  if (expect.intent && summary.intent !== expect.intent) {
    failures.push(`要件=${summary.intent}(期待 ${expect.intent})`);
  }
  if (expect.grade != null && summary.grade !== expect.grade) {
    failures.push(`学年=${summary.grade}(期待 ${expect.grade})`);
  }
  if (expect.visitType && summary.visitType !== expect.visitType) {
    failures.push(`種別=${summary.visitType}(期待 ${expect.visitType})`);
  }
  if (expect.knownStudent && summary.knownStudent !== expect.knownStudent) {
    failures.push(`在籍判定=${summary.knownStudent || "なし"}(期待 ${expect.knownStudent})`);
  }
  if (expect.siblings && JSON.stringify(summary.siblingGrades) !== JSON.stringify(expect.siblings)) {
    failures.push(`ごきょうだい=${JSON.stringify(summary.siblingGrades)}(期待 ${JSON.stringify(expect.siblings)})`);
  }
  if (expect.nameIs && summary.name !== expect.nameIs) {
    failures.push(`氏名=${summary.name}(期待 ${expect.nameIs})`);
  }
  if (expect.needsConsult != null && summary.needsConsult !== expect.needsConsult) {
    failures.push(`要相談=${summary.needsConsult}(期待 ${expect.needsConsult})`);
  }
  if (expect.booked != null && summary.booked !== expect.booked) {
    failures.push(`仮予約=${summary.booked}(期待 ${expect.booked})`);
  }
  if (expect.slotIncludes && !summary.slot.includes(expect.slotIncludes)) {
    failures.push(`枠=${summary.slot || "なし"}(期待 ${expect.slotIncludes}を含む)`);
  }
  if (expect.phone && summary.phone !== expect.phone) {
    failures.push(`連絡先=${summary.phone || "未取得"}(期待 ${expect.phone})`);
  }
  if (expect.handedOff && !saidAll.includes("お名前")) {
    failures.push("連絡先の聴取に移っていない");
  }
  if (expect.saidIncludes && !saidAll.includes(norm(expect.saidIncludes))) {
    failures.push(`通話全体に「${expect.saidIncludes}」が無い`);
  }
  if (expect.neverSays && saidAll.includes(norm(expect.neverSays))) {
    failures.push(`言ってはいけない案内をした: ${expect.neverSays}`);
  }
  return failures;
}

let passed = 0;
const targets = only ? scenarios.filter((s) => s.id === only) : scenarios;
if (targets.length === 0) {
  console.error(`台本 "${only}" が見つかりません。`);
  process.exit(1);
}

for (const scenario of targets) {
  const session = createSession({ classroom, callerNumber: scenario.callerNumber });
  const said = [];

  const opening = begin(session);
  said.push(opening.say);

  console.log(`\n──── ${scenario.id} ────`);
  console.log(`  ${scenario.note}`);
  console.log(`  AI: ${opening.say}`);

  for (const utterance of scenario.utterances) {
    if (session.state === "DONE") break;
    const result = await step(session, utterance);
    said.push(result.say);
    console.log(`  保護者: ${utterance}`);
    console.log(`  AI: ${result.say}`);
    if (result.done) break;
  }

  const summary = summarize(session);
  const failures = check(scenario.expect, summary, said, session.state);
  if (failures.length === 0) {
    passed += 1;
    console.log("  → 合格");
  } else {
    console.log(`  → 不合格: ${failures.join(" / ")}`);
  }
}

const rate = Math.round((passed / targets.length) * 100);
console.log(`\n合計 ${passed}/${targets.length} 件合格(${rate}%)`);
console.log(rate >= 80 ? "§1.3 の目標 80% を満たしています。" : "§1.3 の目標 80% に届いていません。");
process.exit(passed === targets.length ? 0 : 1);
