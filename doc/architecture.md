# Architecture

mihari の実行アーキテクチャ。ローカルログのポーリングと cron スケジュールから bash ランブックを起動する。

## 全体像

```
┌─────────────────────────────────────────────────────┐
│                       CLI                            │
│        mihari daemon | poll | run | list             │
└──────────────────────┬──────────────────────────────┘
                       │
        ┌──────────────┴──────────────┐
        ▼                             ▼
┌──────────────┐             ┌──────────────┐
│ RunbookLoader│             │   StateStore │
│ runbooks/*.yml│             │ ~/.mihari/   │
└──────┬───────┘             └──────┬───────┘
       │ Runbook[]                  │
       ▼                            │
┌──────────────┐                    │
│  FilePoller  │◄───────────────────┤  offset/inode/size
│ tail / offset│                    │
└──────┬───────┘                    │
       │ LogLine[]                  │
       ▼                            │
┌──────────────┐                    │
│   Matcher    │                    │
│  regex eval  │                    │
└──────┬───────┘                    │
       │ Match[]                    │
       ▼                            │
┌──────────────┐                    │
│   Executor   │◄───────────────────┤
│  step loop   │                    │
└──────┬───────┘                    │
       ▲                            │
       │ Match (synth)              │
┌──────┴───────┐                    │
│CronScheduler │◄───────────────────┤  last_fired_at
│ croner / tick│                    │
└──────────────┘                    │
                                    ▼
                             ┌──────────────┐
                             │   BashStep   │
                             │ child_process│
                             └──────────────┘
```

## コンポーネント

### `cli.ts`

`commander` でサブコマンド分岐。各コマンドは下のコンポーネントを組み立てるだけで、ロジックはコアに置く。

| サブコマンド | 動作 |
|-------------|------|
| `daemon` | ループで `tick()` を `--interval` 秒ごとに呼ぶ |
| `poll` | `tick()` を1回だけ呼ぶ |
| `run <id>` | 指定ランブックの steps だけを実行（FilePoller/Matcher 経由しない） |
| `list` | RunbookLoader が読んだメタを表示 |
| `validate <path>` | YAMLパース + スキーマ検証のみ |

### `core/runbook-loader.ts`

`runbooks/*.yaml` を読み、内部表現の `Runbook[]` を返す。

```ts
interface Runbook {
  id: string;
  description?: string;
  trigger: { source: 'file'; path: string; pattern: RegExp };
  steps: BashStep[];
}

interface BashStep {
  id: string;
  bash: string;
  timeout_sec: number;        // default 60
  on_error: 'stop' | 'continue';
  env?: Record<string, string>;
}
```

YAMLパース失敗・スキーマ違反は **起動時に投げる**（fail-closed）。実行時に壊れたランブックを引きずらない。

### `core/matcher.ts`

`LogLine` と `Runbook[]` を受け、マッチしたペア `Match[]` を返す純粋関数。

```ts
function match(line: LogLine, runbooks: Runbook[]): Match[] {
  return runbooks
    .filter(r => r.trigger.path === line.path && r.trigger.pattern.test(line.content))
    .map(r => ({ runbook: r, line }));
}
```

複数ランブックがマッチしたら **すべて順次実行**（並列にしない、シンプルさ優先）。

### `pollers/cron.ts`

時刻ベースのトリガー。`croner` で cron 式を解釈し、`tick(now)` で発火判定する。

#### 状態

`~/.mihari/state/triggers/<sha1(runbook_id)>.json`：

```json
{
  "runbook_id": "api-health",
  "last_fired_at": "2026-04-26T01:23:45Z"
}
```

#### 発火ロジック

```ts
function decideCronFire(schedule: Cron, prev: TriggerState | null, now: Date): CronDecision {
  if (prev === null) {
    // 初回観測は発火しない（next スロットを待つ）。state だけシードする。
    return { fire: false, newLastFiredAt: now.toISOString() };
  }
  const next = schedule.nextRun(new Date(prev.last_fired_at));
  if (next && next.getTime() <= now.getTime()) {
    // 1ティックで複数スロット過ぎていても発火は1回だけ（catch-up しない）
    return { fire: true, newLastFiredAt: now.toISOString() };
  }
  return { fire: false, newLastFiredAt: null };
}
```

cron トリガーは Matcher を経由しない。発火したら直接 Executor に渡す。`event.line` `event.path` は空文字、`event.timestamp` だけが意味を持つ。

### `pollers/file.ts`

ログファイルを tail する。重要な判断はここに集約。

#### オフセット管理

ファイルごとに `~/.mihari/state/pollers/<sha1(path)>.json` に保存：

```json
{
  "path": "/var/log/myapp.log",
  "inode": 12345,
  "size": 4096,
  "offset": 4000,
  "updated_at": "2026-04-26T01:23:45Z"
}
```

#### 1ティックの動作

1. `fs.stat(path)` で `inode` と `size` を取得
2. state と突き合わせて以下を判定：

| 状態 | 判定 | 対応 |
|-----|------|------|
| stateなし | 初回 | **末尾から**スタート（過去ログを巻き戻さない）。`offset = size` |
| `inode` 変化 | ローテーション（`mv` + 新規作成） | `offset = 0` で新ファイルを最初から |
| `size < offset` | truncate（`>` リダイレクト等） | `offset = 0` |
| `size > offset` | 通常追記 | `offset` から `size` まで読む |
| `size == offset` | 変化なし | 何もしない |

3. 範囲を `read` で取得し、改行で `LogLine[]` に分解
4. 末尾の改行未確定行はバッファに残し、次回ティックで連結（v1では未実装、行末改行が来てから処理）
5. 1行ごとに Matcher → Executor を呼ぶ
6. 全行処理完了後に新しい `offset/inode/size` を state に書く

#### マルチファイル

`runbooks/` 内に複数ファイルが trigger.path で指定されていたら、**ファイル単位は逐次**でポーリング。並列にすると state ロック競合が増えるため。

### `core/state.ts`

`~/.mihari/state/` 配下の I/O を集約。

```
~/.mihari/state/
├── pollers/
│   └── <sha1(path)>.json         # FilePoller オフセット
├── triggers/
│   └── <sha1(runbook_id)>.json   # CronScheduler last_fired_at
└── runs/
    └── <YYYY-MM-DD>/
        └── <run_id>.jsonl        # 実行履歴
```

書き込みは `proper-lockfile` でファイルロック → tmp file に書く → `rename()` で atomic に置換。

#### fail-open

state 書き込み失敗は `pino.warn` でログだけ残し、処理は続行する。state破損で全ポーリングが止まるほうが運用上のリスクが大きい。

例外: 起動時のディレクトリ作成失敗（権限ミスなど）は **投げる**。普通の運用で起きる失敗じゃないため。

### `steps/bash-step.ts`

`child_process.spawn('bash', ['-c', step.bash], { env, timeout })` で実行。

- stdout / stderr は `pino` に流して `runs/<date>/<run_id>.jsonl` にも記録
- exit 0 以外は失敗
- timeout は `AbortController` か `spawn`の`timeout`オプション
- `on_error: stop` なら以降のステップを実行しない、`continue` なら次へ

#### テンプレ展開

`{{ event.line }}` `{{ event.path }}` `{{ event.timestamp }}` を **実行直前**に文字列置換。シェル注入を避けるため、置換値は `bash` の **環境変数経由**で渡す：

```ts
spawn('bash', ['-c', step.bash], {
  env: { ...process.env, ...step.env, MIHARI_EVENT_LINE: line.content, MIHARI_EVENT_PATH: line.path, MIHARI_EVENT_TIMESTAMP: ts }
});
```

ユーザーが書く YAML 側で `{{ event.line }}` を見たら **`"$MIHARI_EVENT_LINE"`** に変換してスクリプトに渡す。これでログ行に `;rm -rf` が混ざっても安全。

### `core/executor.ts`

Match を受けてステップを順次実行する：

```ts
async function execute(match: Match): Promise<RunResult> {
  const runId = newRunId();
  const ctx = makeContext(match);                    // {event: {...}, env: ...}
  for (const step of match.runbook.steps) {
    const result = await runBashStep(step, ctx);
    recordStepResult(runId, step.id, result);
    if (!result.ok && step.on_error === 'stop') break;
  }
  return summarize(runId);
}
```

ランブック単位でロックは取らない。複数Pollerティックで同じイベントを2回拾う可能性はあるが、**重複実行は許容**するMVP方針。

## ライフサイクル

### `daemon` モード

```
load runbooks
  └→ build FilePoller list (unique file.path)
  └→ build CronScheduler list (one per cron runbook)
load state
loop:
  for poller in file_pollers:             # 逐次
    lines = poller.tick()
    for line in lines:
      matches = matcher.match(line, runbooks)
      for m in matches:
        await executor.execute(m)
  for scheduler in cron_schedulers:       # 逐次
    fired = scheduler.tick()
    if fired:
      await executor.execute({ runbook: scheduler.runbook, line: fired })
  sleep(--interval)
on SIGINT:
  finish current step
  flush state
  exit 0
```

### `poll` モード

`daemon` の loop body を1回だけ呼ぶ。終了コードは「実行したランブックの中に1つでも失敗があれば 1」。

### `run <id>` モード

トリガー無し。`event` 変数はダミー（または `--input` で渡された値）。state にも書かない（手動オペ／テスト想定）。

## 並列性まとめ

- 複数Poller: **逐次**
- 同一行へのマッチ複数ランブック: **逐次**
- ランブック内ステップ: **逐次**

すべて逐次。並列が必要になったら v2 で `--concurrency` フラグを足す。

## 失敗モードと対応

| 失敗 | 対応 |
|------|------|
| ランブックYAML不正 | 起動時に投げる（fail-closed） |
| stateディレクトリ作成失敗 | 起動時に投げる |
| state読み込み破損 | 該当 state を破棄して新規扱い、warn ログ |
| state書き込み失敗 | warn ログのみ、処理続行（fail-open） |
| ログファイル消失 | warn ログのみ、次ティックで再試行 |
| ログファイル inode変化 | ローテーション扱い、`offset=0` で再開 |
| ログファイル truncate | `offset=0` で再開 |
| bash 非0終了 | `on_error` に従う |
| bash timeout | 失敗扱い、`on_error` に従う |
| プロセス強制終了 | `markProcessed` 前なら次回重複実行（許容） |

## Non-Goals（再掲）

- 行ベースの厳密な exactly-once（重複は許容）
- マルチライン集約（スタックトレース等）
- リモートステート同期
- 並列実行
- inotify によるイベント駆動
