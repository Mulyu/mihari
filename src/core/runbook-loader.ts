// 互換 shim。実体は ./loader/ 配下に分割済み。
// テストや他モジュールは既存の import パスを使い続けられる。
export { loadRunbooks, loadRunbookFile, RunbookValidationError } from "./loader/index.js";
