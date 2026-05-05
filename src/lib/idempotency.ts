import { createHash } from "node:crypto";
import type { TriggerEvent } from "../types/index.js";

// 1ティック1イベントごとに決定的に算出する識別子。
// 同じトリガーイベントが再観測されたとき同じ値になり、ランブック著者がこれをキーに
// branch 名 / PR タイトルなどを組み立てることで「すでに対応中か」を後段から検知できる。
//
// 設計メモ:
// - file: パスとマッチ行内容に依存。同じ行が再度マッチしたら同じキー
// - cron: スケジュール上の発火スロット（minute 単位の timestamp 切り捨て）に依存
// - manual: runbook id + timestamp に依存（手動実行ごとに別キーになる）
// - 12 文字 hex に切り詰める。branch 名やタイトルに混ぜても見やすい長さに保つため
export function computeIdempotencyKey(runbookId: string, event: TriggerEvent): string {
  const hash = createHash("sha1");
  hash.update(runbookId);
  hash.update("\0");
  if (event.type === "file") {
    hash.update("file\0");
    hash.update(event.path);
    hash.update("\0");
    hash.update(event.content);
  } else if (event.type === "cron") {
    hash.update("cron\0");
    // 分単位に切り捨てて、1分以内の重複観測でも同じキーが出るようにする
    hash.update(event.timestamp.slice(0, 16));
  } else {
    hash.update("manual\0");
    hash.update(event.timestamp);
  }
  return hash.digest("hex").slice(0, 12);
}
