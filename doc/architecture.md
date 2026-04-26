# Architecture

mihari の実行アーキテクチャ。ローカルログのポーリングと cron スケジュールから bash ランブックを起動する。

## 全体像

```
┌─────────────────────────────────────────────────────┐
│                       CLI                            │
│   mihari daemon | poll | run | list | validate       │
│                       history                        │
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
┌──────────────────────────────┐    │
│           Dispatcher          │    │
│  tick(input, opts):           │    │
│    file pollers → matcher     │    │
│    cron schedulers → executor │    │
└──┬─────────────────┬──────────┘    │
   │ FileEvent[]     │ CronEvent     │
   ▼                 ▼               │
┌──────────────┐  ┌──────────────┐   │
│  FilePoller  │  │CronScheduler │◄──┤  state I/O
│ tail / offset│  │ croner / tick│   │
└──────┬───────┘  └──────┬───────┘   │
       └────┬────────────┘           │
            ▼                        │
      ┌──────────┐                   │
      │ Matcher  │ (file 専用)        │
      │ regex eval│                  │
      └─────┬────┘                   │
            ▼                        │
      ┌──────────┐                   │
      │ Executor │◄──────────────────┤  appendRunResult
      │ step loop│                   │
      └─────┬────┘                   │
            ▼                        │
      ┌──────────┐                   │
      │ BashStep │                   │
      │child_proc│                   │
      └──────────┘                   ▼
                              ┌──────────────┐
                              │  Logger (root)│
                              │ pino w/ child │
                              └──────────────┘
```

## コンポーネント

### `cli.ts`

`commander` でサブコマンド分岐。`bootstrap()` で各コンポーネントを組み立て、`dispatcher.tick()` を呼ぶ薄い層。

| サブコマンド | 動作 |
|-------------|------|
| `daemon` | ループで `tick()` を `--interval` 秒ごとに呼ぶ |
| `poll` | `tick()` を1回だけ呼ぶ（`--dry-run` 対応） |
| `run <id>` | 指定ランブックを `{type: "manual"}` イベントで直接 Executor へ |
| `list` | RunbookLoader が読んだランブックのトリガーサマリを表示 |
| `validate <path>` | YAMLパース + スキーマ検証のみ |
| `history [run_id]` | StateStore.listRuns / getRun の薄いラッパ |

`preAction` フックで `setLogLevel()` を呼ぶことで全モジュールにログレベルを伝播する。

### `core/logger.ts`

`pino` の root インスタンスを保持し、各モジュールに child を配る。

```ts
const root = pino({ name: "mihari" });
export function logger(component: string) {
  return root.child({ component });
}
export function setLogLevel(level: string) {
  root.level = level;
}
```

子は親 level を継承するので、`setLogLevel("debug")` で全モジュールの出力が増える。

### `core/runbook-loader.ts`

`runbooks/*.yaml` を読み、内部表現の `Runbook[]` を返す。

```ts
type Trigger = FileTrigger | CronTrigger;

interface Runbook {
  id: string;
  description?: string;
  trigger: Trigger;
  steps: BashStep[];
  sourcePath: string;
}

interface BashStep {
  id: string;
  bash: string;
  timeout_sec: number;
  on_error: "stop" | "continue";
  env: Record<string, string>;
}
```

YAMLパース失敗・スキーマ違反は **起動時に投げる**（fail-closed）。実行時に壊れたランブックを引きずらない。

### `core/matcher.ts`

`FileEvent` と `Runbook[]` を受け、マッチした `Match[]` を返す純粋関数。`isFileRunbook` 型ガードで cron ランブックを排除する。

```ts
function match(event: FileEvent, runbooks: Runbook[]): Match[] {
  const eventPath = resolve(event.path);
  return runbooks
    .filter(isFileRunbook)
    .filter((r) => resolve(r.trigger.path) === eventPath && r.trigger.pattern.test(event.content))
    .map((r) => ({ runbook: r, event }));
}
```

複数ランブックがマッチしたら **すべて順次実行**（並列にしない、シンプルさ優先）。

### `core/dispatcher.ts`

`runOneTick` 相当のドメインロジック。テスト容易性のため CLI から切り出してある。

```ts
async function tick(input, opts): Promise<{ ok: boolean; fired: number }> {
  for (const poller of input.pollers) {
    const events = await poller.tick();
    for (const event of events) {
      for (const m of match(event, input.runbooks)) {
        await input.executor.execute(m.runbook, m.event);
      }
    }
  }
  for (const scheduler of input.cronSchedulers) {
    const event = await scheduler.tick();
    if (event) await input.executor.execute(scheduler.runbook, event);
  }
}
```

`opts.dryRun` のときは `executor.execute` を呼ばずに `onDryRun` コールバックでメッセージを返す。

### `pollers/file.ts`

ログファイルを tail する。`FileEvent[]`（`TriggerEvent` の `type: "file"` 部分集合）を返す。

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

3. 範囲を `read` で取得し、改行で行に分解
4. 末尾の改行未確定行はバッファに残し、次回ティックで連結（v1: 行末改行が来てから処理）
5. `FileEvent[]` を返す（`{ type: "file", path, content, timestamp }`）
6. 全行処理後に新しい `offset/inode/size` を state に書く

### `pollers/cron.ts`

時刻ベースのトリガー。`croner` で cron 式を解釈し、`tick(now)` で発火判定する。`CronEvent`（`{ type: "cron", timestamp }`）を返す。

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

cron トリガーは Matcher を経由しない。発火したら直接 Executor に渡す。

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

主要 API:

| メソッド | 用途 |
|---------|------|
| `loadPollerState(path)` / `savePollerState(state)` | FilePoller |
| `loadTriggerState(rbId)` / `saveTriggerState(state)` | CronScheduler |
| `appendRunResult(result)` | Executor |
| `listRuns(opts)` | history コマンド（最新順、limit/since/runbookId 絞り込み） |
| `getRun(runId)` | history `<run_id>` コマンド |

#### fail-open

state 書き込み失敗は warn ログだけ残し、処理は続行する。state破損で全ポーリングが止まるほうが運用上のリスクが大きい。

例外: 起動時のディレクトリ作成失敗（権限ミスなど）は **投げる**。普通の運用で起きる失敗じゃないため。

### `core/executor.ts`

`execute(runbook, event)` でステップを順次実行する。`event` は `TriggerEvent` 識別共用体（file/cron/manual）。

```ts
interface Executor {
  execute(runbook: Runbook, event: TriggerEvent): Promise<RunResult>;
}
```

`on_error: "stop"` なら最初の失敗で打ち切り、`"continue"` なら次のステップへ進む。`RunResult` には `trigger_event` を埋めて `state.appendRunResult` で永続化する。

ランブック単位でロックは取らない。複数Pollerティックで同じイベントを2回拾う可能性はあるが、**重複実行は許容**するMVP方針。

### `steps/bash-step.ts`

`child_process.spawn('bash', ['-c', script])` で実行。

- stdout / stderr は `pino` に流して `runs/<date>/<run_id>.jsonl` にも記録
- exit 0 以外は失敗
- timeout: SIGTERM → 1秒後に SIGKILL
- `on_error` は Executor 側で処理

#### テンプレ展開

`{{ event.line }}` `{{ event.path }}` `{{ event.timestamp }}` `{{ env.NAME }}` を **実行直前**にシェル展開可能な形に置き換える。シェル注入を避けるため、置換値は **環境変数経由**で渡す：

```ts
spawn('bash', ['-c', script], {
  env: {
    ...process.env,
    ...step.env,
    MIHARI_EVENT_LINE: event.type === "file" ? event.content : "",
    MIHARI_EVENT_PATH: event.type === "file" ? event.path : "",
    MIHARI_EVENT_TIMESTAMP: event.timestamp,
  }
});
```

YAML 側で `{{ event.line }}` を見たら **`"$MIHARI_EVENT_LINE"`** に変換してスクリプトに渡す。これでログ行に `;rm -rf` が混ざっても安全。

cron / manual トリガーでは `MIHARI_EVENT_LINE` `MIHARI_EVENT_PATH` は空文字。

## ライフサイクル

### `daemon` モード

```
load runbooks
  └→ build FilePoller list (unique file.path)
  └→ build CronScheduler list (one per cron runbook)
load state
loop:
  await dispatcher.tick({pollers, cronSchedulers, executor, runbooks})
  sleep(--interval)
on SIGINT/SIGTERM:
  set stopping=true; finish current tick; exit 0
```

### `poll` モード

`tick()` を1回だけ呼ぶ。終了コードは「実行したランブックの中に1つでも失敗があれば 1」。

### `run <id>` モード

トリガー無し。`{type: "manual", timestamp: now}` イベントで直接 Executor を呼ぶ。FilePoller / CronScheduler / Matcher を経由しない。

## 並列性まとめ

- 複数Poller / Scheduler: **逐次**
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
| プロセス強制終了 | 永続化前なら次回重複実行（許容） |

## Non-Goals（再掲）

- 行ベースの厳密な exactly-once（重複は許容）
- マルチライン集約（スタックトレース等）
- リモートステート同期
- 並列実行
- inotify によるイベント駆動
