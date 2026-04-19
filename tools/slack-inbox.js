#!/usr/bin/env node
/**
 * Slack Inbox キュー取得スクリプト
 *
 * #claude-inbox チャンネルから未処理メッセージを取得し、
 * 指示一覧を表示 / ファイルに書き出す。
 *
 * Usage:
 *   # 未読メッセージを取得して表示
 *   node tools/slack-inbox.js
 *
 *   # 特定タイムスタンプ以降のメッセージを取得
 *   node tools/slack-inbox.js --since 1711234567.000000
 *
 *   # ファイルに書き出し
 *   node tools/slack-inbox.js --output projects/claude-code-ops/slack-inbox-queue.md
 *
 *   # 処理済みマークを送信（リアクション追加）
 *   node tools/slack-inbox.js --mark-done 1711234567.000000
 *
 * 環境変数（settings.local.json の env から自動取得）:
 *   SLACK_BOT_TOKEN       - Bot User OAuth Token
 *   SLACK_CHANNEL_INBOX   - #claude-inbox のチャンネルID
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const AGENT_ROOT = path.resolve(__dirname, '..');
const LAST_CHECK_PATH = path.join(AGENT_ROOT, 'projects/claude-code-ops/slack-inbox-last-check.txt');
const DEFAULT_OUTPUT = path.join(AGENT_ROOT, 'projects/claude-code-ops/slack-inbox-queue.md');

let _config = null;
function getConfig() {
  if (_config) return _config;
  const settingsPath = path.join(
    process.env.USERPROFILE || process.env.HOME,
    '.claude', 'settings.local.json'
  );
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  _config = {
    botToken: settings.env.SLACK_BOT_TOKEN || '',
    channelId: settings.env.SLACK_CHANNEL_INBOX || '',
  };
  return _config;
}

// ---------------------------------------------------------------------------
// Slack API
// ---------------------------------------------------------------------------

function slackGet(apiPath, token, params) {
  const query = new URLSearchParams(params).toString();
  const fullPath = '/api/' + apiPath + (query ? '?' + query : '');

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'slack.com',
      path: fullPath,
      method: 'GET',
      headers: {
        'Authorization': 'Bearer ' + token,
      }
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        try {
          const json = JSON.parse(body);
          if (json.ok) {
            resolve(json);
          } else {
            reject(new Error(`Slack API error: ${json.error}`));
          }
        } catch (e) {
          reject(new Error(`Slack API parse error: ${body}`));
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function slackPost(apiPath, token, payload) {
  const bodyBuf = Buffer.from(JSON.stringify(payload), 'utf8');

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'slack.com',
      path: '/api/' + apiPath,
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': bodyBuf.length,
      }
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        try {
          const json = JSON.parse(body);
          if (json.ok) {
            resolve(json);
          } else {
            reject(new Error(`Slack API error: ${json.error}`));
          }
        } catch (e) {
          reject(new Error(`Slack API parse error: ${body}`));
        }
      });
    });
    req.on('error', reject);
    req.write(bodyBuf);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Timestamp management
// ---------------------------------------------------------------------------

function getLastCheckTs() {
  try {
    return fs.readFileSync(LAST_CHECK_PATH, 'utf8').trim();
  } catch {
    return '';
  }
}

function saveLastCheckTs(ts) {
  fs.mkdirSync(path.dirname(LAST_CHECK_PATH), { recursive: true });
  fs.writeFileSync(LAST_CHECK_PATH, ts, 'utf8');
}

// ---------------------------------------------------------------------------
// Message formatting
// ---------------------------------------------------------------------------

function formatTimestamp(ts) {
  const date = new Date(parseFloat(ts) * 1000);
  return date.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
}

function messagesToMarkdown(messages) {
  if (messages.length === 0) {
    return '# Slack Inbox\n\n新しい指示はありません。\n';
  }

  let md = '# Slack Inbox Queue\n\n';
  md += `**取得日時:** ${new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}\n`;
  md += `**件数:** ${messages.length}\n\n`;
  md += '---\n\n';

  messages.forEach((msg, i) => {
    const time = formatTimestamp(msg.ts);
    const text = msg.text || '(empty)';
    md += `## ${i + 1}. [${time}]\n\n`;
    md += `${text}\n\n`;
    md += `> ts: \`${msg.ts}\`\n\n`;
    md += '---\n\n';
  });

  return md;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const opts = {};

  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      opts[key] = args[i + 1] || '';
      i++;
    }
  }

  const config = getConfig();

  if (!config.botToken) {
    console.error('Error: SLACK_BOT_TOKEN not configured');
    process.exit(1);
  }
  if (!config.channelId) {
    console.error('Error: SLACK_CHANNEL_INBOX not configured');
    process.exit(1);
  }

  // Mark message as done (add checkmark reaction)
  if (opts['mark-done']) {
    await slackPost('reactions.add', config.botToken, {
      channel: config.channelId,
      timestamp: opts['mark-done'],
      name: 'white_check_mark',
    });
    console.log(`Marked ${opts['mark-done']} as done`);
    return;
  }

  // Fetch messages
  const since = opts.since || getLastCheckTs();
  const params = {
    channel: config.channelId,
    limit: '100',
  };
  if (since) {
    params.oldest = since;
  }

  const result = await slackGet('conversations.history', config.botToken, params);
  // Filter out bot messages, keep only user messages
  const userMessages = (result.messages || [])
    .filter(m => !m.bot_id && m.type === 'message' && !m.subtype)
    .reverse(); // oldest first

  // Output
  const md = messagesToMarkdown(userMessages);
  const outputPath = opts.output || DEFAULT_OUTPUT;

  if (opts.output || !process.stdout.isTTY) {
    const absPath = path.isAbsolute(outputPath) ? outputPath : path.resolve(process.cwd(), outputPath);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, md, 'utf8');
    console.log(`Written to ${absPath} (${userMessages.length} messages)`);
  }

  // Always output to stdout
  console.log(md);

  // Save latest timestamp for next run
  if (userMessages.length > 0) {
    const latestTs = userMessages[userMessages.length - 1].ts;
    saveLastCheckTs(latestTs);
    console.log(`Last check updated: ${latestTs}`);
  }
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
