---
name: direction
description: mihari のプロダクト方針（ディレクション）。新機能・新トリガー・新 provider・ランブック YAML スキーマの拡張・ドキュメント構成の決定で発動する。mihari の設計判断や仕様に関する質問・提案・実装を行うときにトリガーする。
---

# mihari ディレクション

このスキルには「考え方」だけを置く。現行の仕様は `README.md` と `doc/` を、内部設計は `CLAUDE.md` を単一のソースとする。判断の経緯は PR 説明に残し、リポジトリ内に decisions ログは持たない（過去の議論は git log で追える前提）。

## 設計原則

CLAUDE.md の 5 原則に対応する。新機能はこれらに照らして篩う。

### 1. ポーリングのみ。Webhook は作らない

- inotify / Webhook / 受信エンドポイント公開は採用しない
- 新トリガーは「mihari 側が能動的に取りに行く」形でのみ設計する（cron, file, aws_cloudwatch_logs, datadog_monitors の延長線）
- HTTP 監視のような「外部から来るイベント」を扱いたい場合は、ランブックの agent から `Bash(curl:*)` で取りに行く構成で表現する
- ポーリング型である限り**新トリガー追加は一級市民として扱う**。観測対象（読み取り元・cursor の単位・SDK 依存）が既存トリガーと異なるなら、既存の拡張に押し込めず新トリガーを正面から足す。SDK は当該トリガーが存在する時だけ動的 import する形（`aws_cloudwatch_logs` パターン）で、本体の依存を増やさない

### 2. 重複実行は許容、冪等性はランブック側責務

- 「絶対に1回だけ実行」を保証する仕組みは追加しない
- 重複検知は state でベストエフォート。最終的な冪等性はランブック著者の責任
- agent には `MIHARI_IDEMPOTENCY_KEY`（runbook id + trigger event の決定的 hash）が env として必ず渡る。重複起票/重複アクションの抑止はランブック著者がこのキーを使って書く
- catch-up や再送リトライのような重複を増やす機能は、原則として入れない

### 3. state 書き込み失敗は fail-open

- state 関連の I/O は失敗時にログだけ残して処理続行
- state 破損で全ポーリングが止まる事態のほうが運用上重い
- SaaS 認証 env 不足は mihari 本体では感知しない。agent が当該 API を叩いた段階で SDK が失敗を返し、ランブックが ok=false になる
- 例外: 起動時のディレクトリ作成失敗など、普通の運用では起きない場面では投げる

### 4. ランブックは agent 単一実行。ステップ列は持たない

- ランブックの実行ロジックは `agent:` ブロック 1 つで表現する。`bash` / `claude` / `claude_agent` のステップ種別はすべて 1.0 で廃止された
- 動的判断（外部 API の探索、結果に応じた次手の選択、起票/クローズの分岐）は agent が担う
- 決定的な curl 1 本で済むケース（health check, 通知のみ）も agent loop に乗る。`max_turns: 1〜3` で十分なときはそう書く（コストとレイテンシは増えるが、表現を統一する利点を取る）
- SaaS の呼び出し作法（認証 env 名・エンドポイント・curl 例・冪等性パターン）は **ランブック著者が `agent.prompt` / `agent.system` に直接書く**。mihari 本体は SaaS 知識を持たない。「provider preamble の自動注入」は 1.0 で廃止された（`agent.providers` キーは loader が拒否する）

### 5. ローカル前提

- リモートステート同期（S3 等）、複数マシン間の調整、マルチテナントは追加しない
- すべて `~/.mihari/state/` で完結する形に保つ
- マシンを跨いだ運用は「複数マシンで個別に動かす」前提で十分

## SaaS 連携の扱い

外部 SaaS（Datadog / Jira / Slack 等）の呼び出し作法は、**ランブック著者の `agent.prompt` / `agent.system` の責務**。mihari 本体は SaaS の知識（認証 env 名・エンドポイント・curl 例・冪等性パターン）を一切持たない。

### なぜ本体に持たせないか

- preamble 自動注入（旧 `agent.providers:`）は 1.0 で廃止された。プロダクト境界は「ポーリングと cursor 管理」に閉じ、SaaS 側の作法（仕様変更が頻繁・呼び出しパターンが多様）はランブック著者に任せる
- SaaS 別の知識を本体に貯めると、SaaS 側仕様変更のたびに mihari リリースが必要になる。`agent.prompt` に書く形なら著者が即座に更新できる
- 認証 env は引き続き YAML に書かない（環境変数のみ）

### 新 SaaS をランブックから叩くときの作法

ランブック著者向け：

- 認証 env 名・curl 例・冪等性パターン（`MIHARI_IDEMPOTENCY_KEY` の使い方）を `agent.prompt` に直書きする
- `allowed_tools` に `Bash(curl:*)` を入れる
- `runbooks/examples/dd-monitor-jira.yaml` などのサンプル形式を踏襲する

mihari への新規追加で SaaS 連携を引き受けるべきケースは、**ポーリング目的のとき**だけ。それ以外（書き込み・参照系）はランブック側に閉じる。

### 新トリガー追加の進め方

ポーリング対象を本体に取り込みたい場合（cursor 管理を著者に書かせるのが現実的でないとき）に限り、トリガーを増やす。

1. `src/types/index.ts` に `Trigger` / `TriggerEvent` / `<Name>PollerState` を追加
2. `src/loader/trigger.ts` にバリデーション枝を追加（命名規約に従う）
3. `src/triggers/<name>.ts` に Poller クラス + 動的 import 経由の API factory を実装
4. `src/engine/matcher.ts` に match 関数を追加
5. `src/engine/dispatcher.ts` のループに新ポーラーを差す
6. `src/state/store.ts` に state I/O + validator を追加
7. `src/cli/index.ts` の bootstrap に登録
8. `src/agent/template.ts` の置換にイベントフィールドを追加（必要なら）
9. テスト 2 本（loader / poller）を追加
10. `runbooks/examples/` にサンプル 1 本
11. `doc/runbook-spec.{md,ja.md}` の Triggers / Variables / Examples 表に追記
12. `CLAUDE.md` の State 配置 / ライブラリ表 / 失敗モード表に追記

## YAML 命名規約

ランブック YAML のフィールド名・値は、エコシステム全体で語彙を揃える。

### 値はリテラル小文字、別名禁止

- `source: file` / `source: cron` のように、リテラル文字列で識別共用体を切る
- `permission_mode: strict` / `bypass` も同じ
- 同じ意味に別名を与えない（例: `denied` を導入せず `forbidden` に統一する。`stop` の別名 `halt` を増やさない）
- SaaS 由来のリテラル（CloudWatch の `OK` / Datadog の `alert` 等）はサービス側の語彙に揃え、mihari 内部で別名へ変換しない

### 「許可／禁止／必須」の語彙統一

将来的にバリデーションや制約系のフィールドを足すとき、語彙は次の3つに揃える。動詞形（`allow` / `deny` / `forbid` / `require`）は使わない。

| 語彙 | 意味 |
|---|---|
| `required` | なきゃ NG |
| `forbidden` | 一致したら NG |
| `allowed` | リスト外は NG |

ブール値フラグは名詞のみで表現する（`conventions: true`、`enabled: true`）。動詞接頭辞は使わない。

### 識別子の規約

- `id` は kebab-case（`[a-z0-9][a-z0-9-]*`）
- `description` は任意、自由文
- 時間は秒単位の整数で `_sec` サフィックスを付ける（`timeout_sec`）
- パスは絶対パス指定（ホームディレクトリ展開はランブック側責務、エンジンは展開しない）

## 機能追加の進め方

新機能を検討するときは以下の手順で進める。

### 1. ブレスト

候補をなるべく広く列挙する。新トリガー、新 provider、agent オプションの拡張、新サブコマンドなど、形式を問わず書き出す。

### 2. 設計原則で篩う

上の 5 原則に順番に当てて、最も浅い段階で結論が出るならそこで止める。**篩いの強度は対象によって変える**：トリガー / provider は新規追加に寛容、サブコマンドや agent オプションは既存でのカバーを優先。

1. **5 原則のいずれかに正面から反していないか** → 反していれば即不採用、または agent 側で書ける形に振り直す
2. **トリガー追加の場合は、既存トリガーの拡張に固執しない** → 観測対象（読み取り元・cursor の単位・SDK 依存）が既存トリガーのいずれとも異なるなら、新トリガーを正面から検討してよい。SDK は当該トリガーが存在する時だけ動的 import する形に保てば、本体の依存は増えない。「ポーリング型である」ことは譲らない
3. **新 SaaS 連携の場合は、ランブック著者の `agent.prompt` で書けるか先に問う** → 書ける（書き込み・参照系・通知）ならランブック著者に任せる。書けない（cursor 管理が必須＝ポーリング対象として観測したい）場合のみ、新トリガーとして検討する
4. **agent オプションの拡張は、ランブックの prompt で書けないか先に問う** → 書けるならランブック著者に任せる
5. **新規追加が妥当か** → 上を潰した残りで、はじめて新規を採用する

### 3. スコープの一方向性確認

「A のために B を入れる」が片方向に閉じているか確認する。agent が state を書き戻す、ランブックが他のランブックをトリガーする、などの双方向依存は不採用。

### 4. 命名規約の確認

新設するフィールド名・値が上の命名規約（小文字リテラル、別名禁止、`required` / `forbidden` / `allowed` の3語彙、`_sec` サフィックス、kebab-case id）に沿っているかを必ず通す。

### 5. 判断の記録

- 採用 / 不採用の判断とその根拠は、PR 説明に書く
- リポジトリ内に独立した decisions ログは持たない
- 不採用案も「なぜ採らなかったか」を一言入れる。再検討時の踏み台になる

## ドキュメント構成

### ユーザー向け（`doc/`）

- `doc/cli.md` — CLI コマンドリファレンス
- `doc/runbook-spec.md` — ランブック YAML スキーマ
- 新機能を出すときは、ユーザーが触れる仕様だけをここに足す

### 開発者向け（`CLAUDE.md`）

- 設計原則 / データフロー / state 配置 / 失敗モード / コーディング規約
- 内部実装の判断はここに集約。`doc/` に内部詳細を足さない

### サンプル（`runbooks/examples/`）

- 「ランブック著者の `agent.prompt` 側で書けるなら新機能ではなくサンプルで提示する」運用の受け皿
- 新ユースケースは原則ここに 1 ファイル追加して見せる
- 認証 env 名・curl 例・冪等性パターンを各サンプルの prompt に書いておくと、著者がコピペで始められる

### README.md

- 1 画面で全体像が掴めるサイズに保つ
- 詳細は `doc/` `CLAUDE.md` `runbooks/examples/` へリンクで誘導
