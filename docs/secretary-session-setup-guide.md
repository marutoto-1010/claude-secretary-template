# 秘書セッション セットアップガイド

Slack経由でClaude Codeに非同期で指示を出し、自動実行させる仕組みのセットアップ手順です。

---

## 概要

```
あなた → Slack #claude-inbox に指示を投稿
        ↓（15分以内に自動検知）
秘書  → 実行計画をスレッドに投稿
        ↓
あなた → 「OK」とスレッドに返信
        ↓
Claude → 自動実行 → 完了通知をスレッドに投稿
        ↓（追加指示があればスレッドに返信）
Claude → 追加対応 → 完了通知
```

**特徴:**
- Slackに投げるだけで非同期にタスク実行
- 承認フロー付き（勝手に重い処理は走らない）
- 完了後もスレッドで追加指示が可能（双方向）
- **追加指示は同一セッションに集約**（コンテキストを引き継いで効率的に処理）
- npm依存ゼロ、Node.js標準モジュールのみ
- JSONファイルベースの状態管理（DBや外部サービス不要）

---

## 前提条件

| 項目 | 要件 |
|------|------|
| OS | Windows 10/11（macOS/Linuxも対応可） |
| Node.js | v18以上 |
| Claude Code | CLI版がインストール済み（`claude -p` が使えること） |
| Slack | ワークスペースの管理権限またはBot作成権限 |

---

## Step 1: Slack Botの作成

### 1.1 Slack Appを作成

1. https://api.slack.com/apps にアクセス
2. 「Create New App」→「From scratch」を選択
3. App名: `Claude Secretary`（任意）
4. ワークスペースを選択して作成

### 1.2 Bot Token Scopesの設定

「OAuth & Permissions」→「Scopes」→「Bot Token Scopes」に以下を追加:

| Scope | 用途 |
|-------|------|
| `channels:history` | チャンネルのメッセージ読み取り |
| `channels:read` | チャンネル情報の取得 |
| `chat:write` | メッセージの投稿 |
| `reactions:read` | リアクションの読み取り（重複検知） |
| `reactions:write` | リアクションの追加（ステータス表示） |

### 1.3 Botをインストール

1. 「OAuth & Permissions」→「Install to Workspace」
2. 権限を承認
3. 表示される **Bot User OAuth Token**（`xoxb-...`）をコピーして控える

---

## Step 2: Slackチャンネルの準備

以下のチャンネルを作成（名前は任意、IDが必要）:

| チャンネル | 用途 | 必須 |
|-----------|------|------|
| `#claude-inbox` | 指示の投稿先（タスク指示・承認・追加指示をここに投稿） | **必須** |
| `#claude-status` | 秘書セッションの稼働状態を通知するチャンネル | 任意 |

#### `#claude-status` の役割

秘書セッションが正常に動いているかを確認するためのチャンネルです。以下のような通知が自動投稿されます:

- **起動通知**: 秘書セッション開始時に「ポーリング開始」が投稿される
- **エラー通知**: タスク実行中にエラーが発生した場合の通知
- **ハートビート**: 秘書が稼働中であることの定期的な確認

`#claude-inbox` はタスクの指示・やり取り用、`#claude-status` は運用監視用と使い分けます。設定しなくても秘書セッションは動作しますが、設定しておくと「今ちゃんと動いてる？」がSlackで確認できて便利です。

### チャンネルIDの取得方法

1. Slackでチャンネルを開く
2. チャンネル名をクリック → 詳細画面の最下部にIDが表示される（`C0XXXXXXX` 形式）
3. 各チャンネルのIDをコピーして控える

### BotをチャンネルにInvite

各チャンネルで `/invite @Claude Secretary` を実行して、Botをメンバーに追加する。

---

## Step 3: ファイルの配置

### 3.1 ディレクトリ構成

Claude Codeのプロジェクトルート（`claude -p` を実行するディレクトリ）に以下のファイルを配置:

```
your-project/
├── scripts/
│   └── secretary-session.bat    # ポーリング起動スクリプト
│   └── secretary-loop.js        # ポーリングループ本体
├── tools/
│   ├── slack-dispatcher.js      # メイン処理（検知→分類→実行）
│   ├── slack-secretary.js       # inbox読み取り＋メッセージ分類
│   ├── slack-notify.js          # Slack投稿
│   └── slack-inbox.js           # 処理済みマーク・メッセージ取得
├── workflows/
│   └── secretary-dispatch.md    # ディスパッチ手順書（参考）
└── projects/
    └── claude-code-ops/         # 状態ファイル格納先（自動作成）
```

### 3.2 ファイルのコピー

元リポジトリから上記5つのスクリプトファイルをコピーしてください:

```bash
# tools/ 配下の4ファイル
cp tools/slack-dispatcher.js   <your-project>/tools/
cp tools/slack-secretary.js    <your-project>/tools/
cp tools/slack-notify.js       <your-project>/tools/
cp tools/slack-inbox.js        <your-project>/tools/

# scripts/ 配下の2ファイル
cp scripts/secretary-session.bat <your-project>/scripts/
cp scripts/secretary-loop.js     <your-project>/scripts/
```

---

## Step 4: 認証情報の設定

`~/.claude/settings.local.json` に以下の `env` セクションを追加:

```json
{
  "env": {
    "SLACK_BOT_TOKEN": "xoxb-xxxx-xxxx-xxxx",
    "SLACK_CHANNEL_INBOX": "C0XXXXXXX",
    "SLACK_CHANNEL_STATUS": "C0XXXXXXX"
  }
}
```

| キー | 値 |
|------|-----|
| `SLACK_BOT_TOKEN` | Step 1.3で取得したBot Token |
| `SLACK_CHANNEL_INBOX` | `#claude-inbox` のチャンネルID（**必須**） |
| `SLACK_CHANNEL_STATUS` | `#claude-status` のチャンネルID（任意。設定すると稼働状況をSlackで確認可能） |

#### `#claude-status` チャンネルのセットアップ

1. Slackでチャンネルを作成（例: `#claude-status`）
2. チャンネルIDを取得（チャンネル名クリック → 詳細画面の最下部に `C0XXXXXXX` 形式で表示）
3. `/invite @Claude Secretary` でBotをチャンネルに追加
4. `settings.local.json` の `SLACK_CHANNEL_STATUS` にIDを設定
5. 秘書セッションを再起動すれば、以降このチャンネルにステータスが投稿される

> **Tip**: `#claude-status` は通知専用チャンネルとして、メンバーのミュート設定を推奨します。普段は見る必要がなく、秘書が動いてないかも？と思ったときに覗くチャンネルです。

> **注意**: `settings.local.json` はgit管理外にすること。トークンは秘密情報です。

---

## Step 5: 動作確認

### 5.1 個別スクリプトのテスト

```bash
# 1. inbox読み取りテスト（#claude-inboxにテストメッセージを投稿してから実行）
node tools/slack-secretary.js

# 2. 通知テスト（#claude-inboxにメッセージが投稿されれば成功）
node tools/slack-notify.js --channel inbox --text "テスト通知"
```

### 5.2 ディスパッチャーの単発テスト

```bash
# #claude-inbox にテスト指示を投稿してから実行
node tools/slack-dispatcher.js
```

期待される動作:
1. メッセージに 👀 リアクションが付く
2. スレッドに実行計画が投稿される
3. スレッドに「OK」と返信すると、次回巡回時に実行される

### 5.3 ポーリング起動

```bash
# Windows
scripts\secretary-session.bat

# macOS/Linux（同等のシェルスクリプトを作成するか、直接実行）
node scripts/secretary-loop.js
```

---

## Step 6: 常駐化（任意）

### Windows: スタートアップ登録

1. `Win + R` → `shell:startup` でスタートアップフォルダを開く
2. `secretary-session.bat` のショートカットを配置

### macOS: launchd

```xml
<!-- ~/Library/LaunchAgents/com.claude.secretary.plist -->
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.claude.secretary</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/node</string>
        <string>/path/to/your-project/scripts/secretary-loop.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>/path/to/your-project</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
</dict>
</plist>
```

```bash
launchctl load ~/Library/LaunchAgents/com.claude.secretary.plist
```

### Linux: systemd

```ini
# ~/.config/systemd/user/claude-secretary.service
[Unit]
Description=Claude Secretary Session

[Service]
WorkingDirectory=/path/to/your-project
ExecStart=/usr/bin/node scripts/secretary-loop.js
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
```

```bash
systemctl --user enable claude-secretary
systemctl --user start claude-secretary
```

---

## カスタマイズ

### ポーリング間隔の変更

`scripts/secretary-loop.js` の定数を変更:

```javascript
const INTERVAL_NORMAL = 900_000;  // 通常時: 15分（ミリ秒）
const INTERVAL_ACTIVE = 180_000;  // フォローアップ中: 3分
```

### 土日スキップの無効化

```javascript
const WEEKEND_SKIP = false; // true → false に変更
```

### CLAUDE.mdとの連携

秘書セッションが起動する `claude -p` は、プロジェクトルートの `CLAUDE.md` を自動で読み込みます。チーム共通のルール・スキルがある場合は `CLAUDE.md` に記載すれば、秘書セッション経由のタスクにも適用されます。

---

## セッション集約（追加指示の同一セッション継続）

追加指示を出すたびに新しいセッションが立ち上がると、前回の作業コンテキストが失われて非効率です。秘書セッションでは **`--resume` によるセッション集約** を実装しており、追加指示は元のセッションを再開して処理します。

### 仕組み

計画・実行・追加指示の全フェーズが **1つのClaude Codeセッション** で処理されます:

```
計画: claude -p --session-id <UUID> で起動（UUIDを自動生成）
    ↓ （承認「OK」）
実行: claude -p --resume <同じUUID> で計画セッションを再開
    ↓ （完了 → followup状態）
追加指示: claude -p --resume <同じUUID> で同一セッションを再開
    ↓
何回でも追加指示を繰り返し可能（すべて同一セッション）
```

計画フェーズで読み込んだCLAUDE.md・スキル構成・コード理解がそのまま実行・追加指示に引き継がれるため、効率的に処理されます。

### 関連コード（`tools/slack-dispatcher.js`）

| 関数 | 役割 |
|------|------|
| `spawnClaude(prompt, label, options)` | `options.sessionId` → `--session-id` で新規セッション作成、`options.resumeSessionId` → `--resume` で既存セッション再開 |
| `launchPlan(text, ts, existingSessionId?)` | 計画作成。初回は `--session-id` で新セッション、re-plan時は `--resume` で既存セッション再開 |
| `launchFromPlan(ts, originalText, planSessionId?)` | 承認後の実行。`planSessionId` があれば `--resume` で計画セッションを再開 |
| `launchFollowup(threadTs, pendingInfo, newInstruction)` | 追加指示。`pendingInfo.sessionId` で `--resume`。レガシーエントリはフォールバック |

### pendingデータの構造

`sessionId` は計画段階から保存され、全フェーズで一貫して引き継がれます:

```json
{
  "1776502075.839829": {
    "text": "元の指示内容",
    "type": "plan",
    "time": 1713424800000,
    "sessionId": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
  }
}
```

承認後に `type: "followup"` に遷移し、`logFile`, `executionCount`, `followupTimeout` が追加されますが、`sessionId` は変わりません。

### 注意点

- `sessionId` が存在しない古いpendingエントリ（実装前のもの）は、後方互換でログ引用+新セッション方式にフォールバックします
- セッションの最大実行時間は1回あたり10分（`spawnClaude` の `timeout: 600_000`）
- followupは4時間無応答で自動クローズ、または「完了」と返信で明示的にクローズ

---

## メッセージ分類のルール

| 分類 | 判定基準 | 動作 |
|------|---------|------|
| **TASK** | 通常の指示文 | 計画作成 → 承認待ち → 実行 |
| **QUESTION** | `？`/`?`で終わる、「どうす」「相談」等 | 確認質問をスレッドに投稿 |
| **APPROVAL** | 「OK」「承認」「やって」「進めて」等 | 直前の計画を実行 |

---

## リアクションによるステータス表示

秘書はメッセージにリアクションを付けて処理状態を表示します。状態遷移を最小限に抑え、5種類のみ使用します:

| リアクション | 意味 | 遷移タイミング |
|-------------|------|---------------|
| 👀 `eyes` | 検知済み・処理中 | メッセージ検知時に付与（重複防止マーカーも兼ねる） |
| 🤔 `thinking_face` | 承認待ち / 質問中 | 計画作成完了後、ユーザーの応答を待つ間 |
| 💬 `speech_balloon` | 追加指示受付中 | タスク実行完了後、追加指示を受け付ける間 |
| ✅ `white_check_mark` | 完了 | 明示的クローズ or 4時間タイムアウト時 |
| ❌ `x` | エラー | 実行中にエラーが発生した場合 |

**状態遷移フロー:**

```
👀 検知 → 🤔 承認待ち → 💬 追加指示受付中 → ✅ 完了
                                              └→ ❌ エラー
```

---

## トラブルシューティング

### メッセージが検知されない

1. BotがチャンネルにInviteされているか確認
2. `SLACK_CHANNEL_INBOX` のIDが正しいか確認
3. `node tools/slack-secretary.js` を手動実行してエラーを確認

### 二重実行される

- リアクション（👀）による重複防止が機能しています。通常は発生しません
- `projects/claude-code-ops/.slack-secretary-processed.json` に処理済みtsが記録されています

### claude -p がエラーになる

1. `claude -p "hello"` が単体で動作するか確認
2. Claude Codeのログイン状態を確認
3. `--allowedTools` のツール名が正しいか確認

### ログの確認

```bash
# ポーリングログ
cat projects/claude-code-ops/secretary-session.log

# 個別タスクのログ
ls projects/claude-code-ops/.slack-task-logs/
```

---

## セキュリティ上の注意

- `SLACK_BOT_TOKEN` は `.claude/settings.local.json` に保存し、gitリポジトリにはコミットしない
- Bot Tokenのスコープは最小限にする（上記のスコープのみで動作可能）
- `#claude-inbox` チャンネルは信頼できるメンバーのみがアクセスできるようにする
- 秘書セッションはローカルPCで動作するため、PCの電源が入っている間のみ有効

---

## 備考: GitRepoViewerとの併用

秘書セッションは [GitRepoViewer](https://github.com/marutoto-1010/agent-viewer) と併用することで、**Slackだけで指示から成果物確認・修正まで完結するワークフロー**が実現できます。

### 仕組み

```
Slackで指示 → Claude Codeが実行 → 成果物をgitにコミット
    ↓                                      ↓
追加指示・修正依頼              GitRepoViewerでブラウザ確認
（Slackスレッドに返信）          （Markdown/HTML/コードをプレビュー）
```

GitRepoViewerはgitリポジトリの内容をWebブラウザで閲覧できるツールです。秘書セッションが生成した成果物（レポート・スライド・コード等）がコミットされると、ViewerのURLにアクセスするだけで最新の内容を確認できます。

### ユースケース

| シナリオ | Slackでの操作 | GitRepoViewerでの確認 |
|---------|-------------|---------------------|
| **市場調査レポートの作成** | 「〇〇の市場規模を調べて」と投稿 | 生成されたMarkdownレポートをブラウザで閲覧 |
| **提案書スライドの作成** | 「△△の提案スライドを作って」と投稿 | HTMLスライドをブラウザでプレビュー |
| **レポートの修正** | スレッドに「競合分析のセクションをもう少し深掘りして」と返信 | 更新後のレポートを再読み込みで確認 |
| **複数回のイテレーション** | スレッドで「グラフを追加」「結論を修正」等を繰り返し投稿 | 各コミット後にViewerで最新版を確認 |

### 推奨: StopHookによる自動コミット&プッシュ

GitRepoViewerで成果物をリアルタイムに確認するには、Claude Codeのセッション終了時に変更を自動でcommit & pushする設定が便利です。`~/.claude/settings.json` の `hooks` セクションに以下を追加してください:

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "cd /path/to/your-project && git add -A && git commit -m \"auto-save: $(date +%Y%m%d-%H%M%S)\" --allow-empty && git push origin HEAD"
          }
        ]
      }
    ]
  }
}
```

**Windows（Git Bash）の場合:**

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "cd /c/Users/yourname/your-project && git add -A && git commit -m \"auto-save: $(date +%Y%m%d-%H%M%S)\" --allow-empty && git push origin HEAD"
          }
        ]
      }
    ]
  }
}
```

| 項目 | 説明 |
|------|------|
| `Stop` | Claude Codeのセッション（`-p` 含む）終了時に発火するフック |
| `git add -A` | 全変更をステージング |
| `--allow-empty` | 変更がない場合もエラーにしない |
| `git push origin HEAD` | リモートに自動プッシュ |

> **注意**: このフックを設定すると、秘書セッションの各タスク完了時にも自動コミットされます。コミットメッセージをカスタマイズしたい場合は、`tools/` にスクリプトを作成して `command` から呼び出す形にしてください。

### メリット

- **スマホだけで完結**: 外出先からSlackで指示→Viewerで確認→追加指示、がすべてモバイルで可能
- **非エンジニアでも利用可能**: gitコマンドやターミナル操作が不要。Slackとブラウザだけで成果物にアクセスできる
- **レビューサイクルの高速化**: 成果物を共有リンクでチームメンバーに展開し、フィードバックを即座にSlackで反映できる
- **自動コミット&プッシュ**: StopHookを設定すれば、タスク完了→コミット→Viewer反映が完全自動化
