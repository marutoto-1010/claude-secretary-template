#!/usr/bin/env node
/**
 * Slack Secretary - 巡回・指示分類スクリプト
 *
 * slack-inbox.js で取得したメッセージを分類し、
 * 秘書セッションが次に取るべきアクションをJSON形式で返す。
 *
 * Usage:
 *   node tools/slack-secretary.js
 *
 * 出力: JSON配列
 *   [{ "ts": "...", "text": "...", "level": "L1|L2|L3", "action": "..." }]
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const AGENT_ROOT = path.resolve(__dirname, '..');
const LAST_CHECK_PATH = path.join(AGENT_ROOT, 'projects/claude-code-ops/slack-inbox-last-check.txt');
const PROCESSED_PATH = path.join(AGENT_ROOT, 'projects/claude-code-ops/.slack-secretary-processed.json');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function getConfig() {
  const settingsPath = path.join(
    process.env.USERPROFILE || process.env.HOME,
    '.claude', 'settings.local.json'
  );
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  return {
    botToken: settings.env.SLACK_BOT_TOKEN || '',
    channelInbox: settings.env.SLACK_CHANNEL_INBOX || '',
    channelAlerts: settings.env.SLACK_CHANNEL_ALERTS || '',
    channelStatus: settings.env.SLACK_CHANNEL_STATUS || '',
  };
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
      headers: { 'Authorization': 'Bearer ' + token }
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          json.ok ? resolve(json) : reject(new Error(`Slack API: ${json.error}`));
        } catch (e) { reject(e); }
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
        try {
          const json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          json.ok ? resolve(json) : reject(new Error(`Slack API: ${json.error}`));
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(bodyBuf);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Processed message tracking
// ---------------------------------------------------------------------------

function getProcessed() {
  try {
    return JSON.parse(fs.readFileSync(PROCESSED_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function markProcessed(ts) {
  const processed = getProcessed();
  processed[ts] = Date.now();
  // Keep only last 200 entries
  const entries = Object.entries(processed).sort((a, b) => b[1] - a[1]).slice(0, 200);
  fs.mkdirSync(path.dirname(PROCESSED_PATH), { recursive: true });
  fs.writeFileSync(PROCESSED_PATH, JSON.stringify(Object.fromEntries(entries)), 'utf8');
}

// ---------------------------------------------------------------------------
// Message classification
// ---------------------------------------------------------------------------

const APPROVAL_PATTERNS = /^(ok|OK|承認|やって|進めて|お願い|はい|yes|go|実行して|よろしく)$/i;
const QUESTION_PATTERNS = /？$|\?$|どうす|どちら|どっち|どれに|どの方向|相談したい/;

function classifyMessage(text) {
  const trimmed = text.trim();
  if (APPROVAL_PATTERNS.test(trimmed)) {
    return { level: 'APPROVAL', action: '承認' };
  }
  if (QUESTION_PATTERNS.test(trimmed)) {
    return { level: 'QUESTION', action: '質問（確認が必要）' };
  }
  return { level: 'TASK', action: '計画作成→承認→実行' };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const config = getConfig();

  if (!config.botToken || !config.channelInbox) {
    console.error('Error: Slack not configured');
    process.exit(1);
  }

  // Fetch recent messages from last 24 hours, use processed list for dedup
  const oldest24h = String(Date.now() / 1000 - 86400);
  const params = { channel: config.channelInbox, limit: '20', oldest: oldest24h };

  const result = await slackGet('conversations.history', config.botToken, params);
  const processed = getProcessed();

  const newMessages = (result.messages || [])
    .filter(m => !m.bot_id && m.type === 'message' && !m.subtype && !processed[m.ts])
    .reverse();

  if (newMessages.length === 0) {
    // No new messages - silent exit
    process.exit(0);
  }

  // Classify each message
  const tasks = newMessages.map(msg => {
    const classification = classifyMessage(msg.text || '');
    return {
      ts: msg.ts,
      text: msg.text || '',
      time: new Date(parseFloat(msg.ts) * 1000).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }),
      ...classification,
    };
  });

  // Output for the secretary session to act on
  console.log(JSON.stringify(tasks, null, 2));

  // Note: dedup is handled by processed list only, no last-check timestamp
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
