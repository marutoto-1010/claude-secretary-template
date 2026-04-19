# Claude Secretary Template

Claude Code を Slack 経由で非同期に操作する「秘書セッション」のテンプレートリポジトリです。

Slack の `#claude-inbox` チャンネルに指示を投稿すると、バックグラウンドで Claude Code が自動で計画作成 → 承認 → 実行 → 追加対応まで行います。

## 主な特徴

- **Slack から非同期にタスク実行**: 投げるだけで計画〜実行まで自動
- **承認フロー付き**: 勝手に重い処理が走らない
- **同一セッションに集約**: 計画・実行・追加指示がすべて1つの Claude Code セッションで処理される（コンテキスト引き継ぎ）
- **npm 依存ゼロ**: Node.js 標準モジュールのみ
- **JSON ファイルベースの状態管理**: DB や外部サービス不要
- **追加指示も同じスレッドで**: 完了後もスレッドに返信すれば追加対応可能

## セットアップ

詳細な手順は [docs/secretary-session-setup-guide.md](docs/secretary-session-setup-guide.md) を参照してください。

### クイックスタート

1. このリポジトリを clone
   ```bash
   git clone https://github.com/marutoto-1010/claude-secretary-template.git
   cd claude-secretary-template
   ```
2. Slack Bot を作成し、Bot Token とチャンネル ID を取得
3. `~/.claude/settings.local.json` に認証情報を設定
4. ポーリングを起動
   ```bash
   # Windows
   scripts\secretary-session.bat
   # macOS/Linux
   node scripts/secretary-loop.js
   ```

## ディレクトリ構成

```
claude-secretary-template/
├── tools/
│   ├── slack-dispatcher.js    # メイン処理（検知→分類→実行）
│   ├── slack-secretary.js     # inbox 読み取り＋メッセージ分類
│   ├── slack-notify.js        # Slack 投稿
│   └── slack-inbox.js         # 処理済みマーク・メッセージ取得
├── scripts/
│   ├── secretary-session.bat  # Windows 用ポーリング起動スクリプト
│   └── secretary-loop.js      # ポーリングループ本体
└── docs/
    └── secretary-session-setup-guide.md  # セットアップガイド
```

## 前提条件

| 項目 | 要件 |
|------|------|
| OS | Windows 10/11（macOS/Linux も対応可） |
| Node.js | v18 以上 |
| Claude Code | CLI 版がインストール済み（`claude -p` が使えること） |
| Slack | ワークスペースの管理権限または Bot 作成権限 |

## ライセンス

MIT
