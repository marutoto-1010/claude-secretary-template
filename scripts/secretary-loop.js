#!/usr/bin/env node
/**
 * Secretary Loop - Node.js版ポーリングループ
 * .batの待機コマンド問題を回避するため、全てNode.jsで管理する
 */

const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const AGENT_ROOT = path.resolve(__dirname, '..');
const LOG_FILE = path.join(AGENT_ROOT, 'projects/claude-code-ops/secretary-session.log');
const PENDING_FILE = path.join(AGENT_ROOT, 'projects/claude-code-ops/.slack-pending-threads.json');
const INTERVAL_NORMAL = 900_000;  // 15 min
const INTERVAL_ACTIVE = 180_000;  // 3 min (followup active)
const WEEKEND_SKIP = true; // 土日はポーリングをスキップ

function log(msg) {
  const ts = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
  const line = `[${ts}] ${msg}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_FILE, line + '\n', 'utf8');
  } catch {}
}

function isWeekend() {
  const day = new Date().toLocaleDateString('en-US', { timeZone: 'Asia/Tokyo', weekday: 'short' });
  return day === 'Sat' || day === 'Sun';
}

function checkInbox() {
  if (WEEKEND_SKIP && isWeekend()) {
    log('Weekend — skipping inbox check.');
    return;
  }
  try {
    log('Checking inbox...');
    const output = execFileSync('node', [path.join(AGENT_ROOT, 'tools/slack-dispatcher.js')], {
      cwd: AGENT_ROOT,
      timeout: 11 * 60 * 1000, // 11 min (execution can take up to 10 min)
      encoding: 'utf8',
    });
    if (output.trim()) log(output.trim());
    log('Check complete.');
  } catch (err) {
    log(`Dispatcher error: ${err.message.slice(0, 200)}`);
  }
}

function hasActiveFollowups() {
  try {
    const pending = JSON.parse(fs.readFileSync(PENDING_FILE, 'utf8'));
    return Object.values(pending).some(p => p.type === 'followup');
  } catch { return false; }
}

function scheduleNext() {
  const active = hasActiveFollowups();
  const interval = active ? INTERVAL_ACTIVE : INTERVAL_NORMAL;
  log(`Next check in ${interval / 1000}s (${active ? 'followup active' : 'idle'})`);
  setTimeout(() => {
    checkInbox();
    scheduleNext();
  }, interval);
}

// Initial run
log('Secretary loop started (Node.js)');
checkInbox();
scheduleNext();
