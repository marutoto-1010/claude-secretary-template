#!/usr/bin/env node
/**
 * Slack 通知スクリプト
 *
 * Incoming Webhook または Bot Token 経由で Slack にメッセージを送信する。
 * notion-transfer.js と同じ Node.js https パターンを使用。
 *
 * Usage:
 *   # Webhook 経由（シンプル通知）
 *   node tools/slack-notify.js --text "テストメッセージ"
 *
 *   # チャンネル指定（Bot Token 使用）
 *   node tools/slack-notify.js --channel "#claude-alerts" --text "アラート通知"
 *
 *   # Block Kit 形式（リッチメッセージ）
 *   node tools/slack-notify.js --text "fallback" --blocks '[{"type":"section","text":{"type":"mrkdwn","text":"*Bold*"}}]'
 *
 *   # ファイル内容を送信
 *   node tools/slack-notify.js --file "projects/google-alerts/weekly-review.md" --title "Google Alerts Daily"
 *
 * 環境変数（settings.local.json の env から自動取得）:
 *   SLACK_WEBHOOK_URL  - Incoming Webhook URL
 *   SLACK_BOT_TOKEN    - Bot User OAuth Token
 *   SLACK_CHANNEL_ALERTS  - #claude-alerts のチャンネルID
 *   SLACK_CHANNEL_INBOX   - #claude-inbox のチャンネルID
 *   SLACK_CHANNEL_STATUS  - #claude-status のチャンネルID
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Config from settings.local.json
// ---------------------------------------------------------------------------

let _config = null;
function getConfig() {
  if (_config) return _config;
  const settingsPath = path.join(
    process.env.USERPROFILE || process.env.HOME,
    '.claude', 'settings.local.json'
  );
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  // Build channel map dynamically from all SLACK_CHANNEL_* env vars
  const channels = {};
  for (const [key, value] of Object.entries(settings.env || {})) {
    if (key.startsWith('SLACK_CHANNEL_') && value) {
      // SLACK_CHANNEL_ALERTS -> "alerts", SLACK_CHANNEL_IDEAS -> "ideas"
      const shortName = key.replace('SLACK_CHANNEL_', '').toLowerCase();
      channels[shortName] = value;
    }
  }
  _config = {
    webhookUrl: settings.env.SLACK_WEBHOOK_URL || '',
    botToken: settings.env.SLACK_BOT_TOKEN || '',
    channels,
  };
  return _config;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function postWebhook(webhookUrl, payload) {
  const url = new URL(webhookUrl);
  const bodyBuf = Buffer.from(JSON.stringify(payload), 'utf8');

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': bodyBuf.length,
      }
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(body);
        } else {
          reject(new Error(`Webhook error ${res.statusCode}: ${body}`));
        }
      });
    });
    req.on('error', reject);
    req.write(bodyBuf);
    req.end();
  });
}

function postSlackApi(apiPath, token, payload) {
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
// Message formatting
// ---------------------------------------------------------------------------

function truncate(text, maxLen) {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + '...';
}

function fileToBlocks(filePath, title) {
  const content = fs.readFileSync(filePath, 'utf8');
  const blocks = [];

  if (title) {
    blocks.push({
      type: 'header',
      text: { type: 'plain_text', text: truncate(title, 150) }
    });
  }

  // Split content into chunks (Slack block text limit: 3000 chars)
  const MAX_BLOCK_TEXT = 2900;
  const lines = content.split('\n');
  let chunk = '';

  for (const line of lines) {
    if (chunk.length + line.length + 1 > MAX_BLOCK_TEXT) {
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: chunk }
      });
      chunk = '';
    }
    chunk += (chunk ? '\n' : '') + line;
  }
  if (chunk) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: chunk }
    });
  }

  // Slack block limit: 50 blocks
  if (blocks.length > 50) {
    const truncated = blocks.slice(0, 49);
    truncated.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `_... ${blocks.length - 49} blocks truncated_` }]
    });
    return truncated;
  }

  return blocks;
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
  const text = opts.text || '';
  const channel = opts.channel || '';
  const blocksJson = opts.blocks || '';
  const filePath = opts.file || '';
  const title = opts.title || '';
  const webhookOverride = opts.webhook || '';

  // Build payload
  let blocks = [];
  if (blocksJson) {
    blocks = JSON.parse(blocksJson);
  } else if (filePath) {
    const absPath = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(process.cwd(), filePath);
    blocks = fileToBlocks(absPath, title);
  }

  const payload = {};
  if (text) payload.text = text;
  if (blocks.length > 0) payload.blocks = blocks;

  if (!payload.text && !payload.blocks) {
    console.error('Error: --text or --blocks or --file is required');
    process.exit(1);
  }

  // Determine send method
  const webhookUrl = webhookOverride || config.webhookUrl;

  if (channel) {
    // Use Bot Token + chat.postMessage (channel explicitly specified)
    if (!config.botToken) {
      console.error('Error: SLACK_BOT_TOKEN required for channel posting');
      process.exit(1);
    }

    // Resolve channel name to ID from config
    // Accepts: "alerts", "#claude-alerts", "ideas", "#アイデア爆増", or raw channel ID "C0XXXXX"
    let channelId = channel;
    if (/^C[A-Z0-9]+$/.test(channel)) {
      // Already a channel ID - use as-is
      channelId = channel;
    } else {
      // Strip # prefix and common prefixes for lookup
      const normalized = channel.replace(/^#/, '').replace(/^claude-/, '');
      // Try direct short name match (e.g., "alerts", "ideas", "info", "yukai")
      if (config.channels[normalized]) {
        channelId = config.channels[normalized];
      } else {
        // Try matching against all channel short names
        const match = Object.entries(config.channels).find(([key]) =>
          channel === `#claude-${key}` || channel === `#${key}`
        );
        if (match) channelId = match[1];
      }
    }

    if (!channelId) {
      console.error('Error: Channel ID not resolved. Set SLACK_CHANNEL_* in settings.local.json');
      process.exit(1);
    }

    payload.channel = channelId;
    if (opts.thread) {
      payload.thread_ts = opts.thread;
    }
    const result = await postSlackApi('chat.postMessage', config.botToken, payload);
    console.log(`Sent to channel ${channelId} (ts: ${result.ts})`);
  } else if (webhookUrl) {
    // Use Incoming Webhook
    await postWebhook(webhookUrl, payload);
    console.log('Sent via webhook');
  } else {
    console.error('Error: No SLACK_WEBHOOK_URL or SLACK_BOT_TOKEN configured');
    console.error('Set them in ~/.claude/settings.local.json env section');
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
