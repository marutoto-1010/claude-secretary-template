#!/usr/bin/env node
/**
 * Slack Dispatcher
 *
 * 1. トップレベル新着メッセージを検知・分類
 * 2. 過去にL2/L3返信したスレッドの新着返信も検知
 * 3. L1/APPROVAL → claude -p でバックグラウンドセッション起動
 * 4. L2 → スレッドに承認依頼
 * 5. L3 → スレッドに確認質問
 */

const { execFile, spawn } = require('child_process');
const https = require('https');
const path = require('path');
const fs = require('fs');

const TOOLS_DIR = __dirname;
const AGENT_ROOT = path.resolve(TOOLS_DIR, '..');
const PENDING_PATH = path.join(AGENT_ROOT, 'projects/claude-code-ops/.slack-pending-threads.json');
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
  };
}

// ---------------------------------------------------------------------------
// Slack API
// ---------------------------------------------------------------------------

function slackPost(apiPath, token, payload) {
  const body = JSON.stringify(payload);
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'slack.com',
      path: '/api/' + apiPath,
      method: 'POST',
      timeout: 30_000, // 30s timeout
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
      }
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (!json.ok) {
            console.error(`[Slack API] ${apiPath} failed: ${json.error || 'unknown'}`);
          }
          resolve(json);
        }
        catch { resolve({ ok: false, error: 'json_parse_error' }); }
      });
    });
    req.on('timeout', () => {
      console.error(`[Slack API] ${apiPath} timed out after 30s`);
      req.destroy();
      resolve({ ok: false, error: 'timeout' });
    });
    req.on('error', (err) => {
      console.error(`[Slack API] ${apiPath} error: ${err.message}`);
      resolve({ ok: false, error: err.message });
    });
    req.write(body);
    req.end();
  });
}

// Reaction-based lifecycle markers (minimal set)
const REACTIONS = {
  detected: 'eyes',            // 👀 検知・処理中
  awaiting: 'thinking_face',   // 🤔 承認待ち / 質問中
  followup: 'speech_balloon',  // 💬 追加指示受付中
  done: 'white_check_mark',    // ✅ 完了
  error: 'x',                  // ❌ エラー
};

async function addReaction(token, channel, ts, name) {
  return slackPost('reactions.add', token, { channel, timestamp: ts, name });
}

async function removeReaction(token, channel, ts, name) {
  return slackPost('reactions.remove', token, { channel, timestamp: ts, name });
}

// Check if message already has any of our lifecycle reactions
async function hasOurReaction(token, channel, ts) {
  const res = await slackPost('reactions.get', token, { channel, timestamp: ts });
  if (!res.ok || !res.message || !res.message.reactions) return false;
  const ourNames = Object.values(REACTIONS);
  return res.message.reactions.some(r => ourNames.includes(r.name));
}

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd: AGENT_ROOT, timeout: opts.timeout || 60_000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd} failed: ${err.message}\n${stderr}`));
      else resolve(stdout.trim());
    });
  });
}

function notify(channel, text, threadTs) {
  const args = [path.join(TOOLS_DIR, 'slack-notify.js'), '--channel', channel, '--text', text];
  if (threadTs) args.push('--thread', threadTs);
  return run('node', args);
}

function markDone(ts) {
  return run('node', [path.join(TOOLS_DIR, 'slack-inbox.js'), '--mark-done', ts]);
}

const PLANS_DIR = path.join(AGENT_ROOT, 'projects/claude-code-ops/.slack-plans');
const PROMPTS_DIR = path.join(AGENT_ROOT, 'projects/claude-code-ops/.slack-prompts');

const TASK_LOG_DIR = path.join(AGENT_ROOT, 'projects/claude-code-ops/.slack-task-logs');

function spawnClaude(prompt, label, options = {}) {
  fs.mkdirSync(TASK_LOG_DIR, { recursive: true });
  const ts = Date.now();
  const logFile = path.join(TASK_LOG_DIR, `${ts}.log`);

  // Write prompt to task file and pipe it directly to claude -p via stdin
  const taskFile = path.join(TASK_LOG_DIR, `${ts}.task.md`);
  fs.writeFileSync(taskFile, prompt, 'utf8');
  // Run claude -p synchronously, reading prompt from stdin via Node
  // This avoids shell-specific path issues (bash /c/ vs cmd c:\)
  const { execFileSync: execFileSyncLocal } = require('child_process');

  // Build CLI args with optional session management
  const args = ['-p', '--allowedTools', 'Bash,Read,Write,Edit,Glob,Grep,WebFetch,WebSearch'];
  if (options.resumeSessionId) {
    // Resume an existing session (followup)
    args.push('--resume', options.resumeSessionId);
  } else if (options.sessionId) {
    // Start a new session with a fixed ID (initial execution)
    args.push('--session-id', options.sessionId);
  }

  try {
    // Use shell: true for Windows .cmd file compatibility
    const output = execFileSyncLocal('claude', args, {
      cwd: AGENT_ROOT,
      input: prompt, // pass prompt directly via stdin
      encoding: 'utf8',
      timeout: 600_000, // 10 min
      shell: true,
    });
    fs.writeFileSync(logFile, output, 'utf8');
  } catch (err) {
    fs.writeFileSync(logFile, 'Error: ' + (err.stdout || err.message), 'utf8');
  }
  console.log(`  → Log: ${logFile}`);
  return logFile;
}

function titleFrom(text) {
  return text.replace(/\n/g, ' ').slice(0, 40).trim();
}

function launchTask(text, ts) {
  const prompt = [
    `# [Slack] ${titleFrom(text)}`,
    '',
    '## 自律実行モード（最優先で従うこと）',
    'このセッションは非対話で自律実行されています。以下を厳守すること：',
    '- 確認フロー（レビュー要否・Notion転記・Remote Control）は全てスキップ',
    '- AskUserQuestion, EnterPlanMode, ExitPlanMode ツールは絶対に使用禁止（非対話セッションのため停止する）',
    '- 判断が必要な場合は最も安全な選択肢を選んで続行',
    '- CLAUDE.mdのスキルやファイル構成は参照してよい',
    '- 外部ファイルから指示を探しに行かないこと。指示は以下に記載済み',
    '',
    '## まるさんからの指示内容',
    text,
    '',
    '## 完了報告（必須）',
    'タスク完了後、必ず以下を両方実行すること：',
    `1. node tools/slack-notify.js --channel inbox --thread ${ts} --text "完了: {結果の要約}"`,
    `2. node tools/slack-inbox.js --mark-done ${ts}`,
  ].join('\n');

  return spawnClaude(prompt);
}

function launchPlan(text, ts, existingSessionId) {
  fs.mkdirSync(PLANS_DIR, { recursive: true });
  const planFile = path.join(PLANS_DIR, `${ts}.md`);

  // Reuse existing session ID if available (re-plan), otherwise generate new
  const sessionId = existingSessionId || require('crypto').randomUUID();
  const resuming = !!existingSessionId;

  const prompt = [
    `# [Slack/計画] ${titleFrom(text)}`,
    '',
    '## 計画作成モード（実行しないこと・最優先で従うこと）',
    'このセッションでは計画の作成のみを行い、実際の実行はしないでください。',
    '- 確認フロー（レビュー要否・Notion転記・Remote Control）は全てスキップ',
    '- AskUserQuestion, EnterPlanMode, ExitPlanMode ツールは絶対に使用禁止（非対話セッションのため停止する）',
    '- CLAUDE.mdのスキルやファイル構成を参照し、最適な実行計画を立てる',
    '- 外部ファイルから指示を探しに行かないこと。指示は以下に記載済み',
    '',
    '## まるさんからの指示内容',
    text,
    '',
    '## 出力（必須・この順番で実行）',
    `1. 実行計画を ${planFile} に保存する（Markdown形式、ステップ・使用スキル・推定時間を含む）`,
    `2. 計画の要約（300字以内）を以下のコマンドでSlackスレッドに投稿する：`,
    `   node tools/slack-notify.js --channel inbox --thread ${ts} --text "【実行計画】\\n{計画の要約}\\n\\n承認する場合はこのスレッドに「OK」と返信してください。"`,
  ].join('\n');

  const logFile = spawnClaude(prompt, null, resuming ? { resumeSessionId: sessionId } : { sessionId });
  return { logFile, sessionId };
}

function launchFromPlan(ts, originalText, planSessionId) {
  const planFile = path.join(PLANS_DIR, `${ts}.md`);
  let planContent = '';
  try { planContent = fs.readFileSync(planFile, 'utf8'); } catch { }

  // Resume the plan session (same context: CLAUDE.md, skills already loaded)
  const sessionId = planSessionId || require('crypto').randomUUID();
  const resuming = !!planSessionId;

  const prompt = [
    `# [Slack/実行] ${titleFrom(originalText || '')}`,
    '',
    '## 自律実行モード（最優先で従うこと）',
    'まるさんから承認されたタスクです。即座に実行してください。',
    resuming
      ? '前回の計画セッションのコンテキストが引き継がれています。計画に沿って実行してください。'
      : '',
    '- 確認フロー（レビュー要否・Notion転記・Remote Control）は全てスキップ',
    '- AskUserQuestion, EnterPlanMode, ExitPlanMode ツールは絶対に使用禁止（非対話セッションのため停止する）',
    '- CLAUDE.mdのスキルやファイル構成は参照してよい',
    '- 「承認待ち」などと返答せず、直ちに作業を開始すること',
    '',
    '## まるさんからの指示内容',
    originalText || '(指示内容なし)',
    '',
    planContent ? '## 実行計画\n' + planContent : '',
    '',
    '## 完了報告（必須）',
    'タスク完了後、以下を実行すること：',
    `1. node tools/slack-notify.js --channel inbox --thread ${ts} --text "完了: {結果の要約}"`,
  ].join('\n');

  const logFile = spawnClaude(prompt, null, resuming ? { resumeSessionId: sessionId } : { sessionId });
  try { fs.unlinkSync(planFile); } catch { }
  return { logFile, sessionId };
}

function launchFollowup(threadTs, pendingInfo, newInstruction) {
  // If we have a sessionId from the initial execution, resume that session
  if (pendingInfo.sessionId) {
    const prompt = [
      `# [Slack/追加指示] ${titleFrom(pendingInfo.text)}`,
      '',
      '## 追加指示（前回のセッションを継続中）',
      'まるさんから追加指示です。前回の作業コンテキストはこのセッションに残っています。',
      '- 確認フロー（レビュー要否・Notion転記・Remote Control）は全てスキップ',
      '- AskUserQuestion, EnterPlanMode, ExitPlanMode ツールは絶対に使用禁止（非対話セッションのため停止する）',
      '- 直ちに追加作業を開始すること',
      '',
      '## 追加指示',
      newInstruction,
      '',
      '## 完了報告（必須）',
      `1. node tools/slack-notify.js --channel inbox --thread ${threadTs} --text "追加対応完了: {結果の要約}"`,
    ].join('\n');

    const logFile = spawnClaude(prompt, null, { resumeSessionId: pendingInfo.sessionId });
    return { logFile, sessionId: pendingInfo.sessionId };
  }

  // Fallback: no sessionId (legacy pending entry) → new session with log context
  let prevLog = '';
  if (pendingInfo.logFile) {
    try { prevLog = fs.readFileSync(pendingInfo.logFile, 'utf8'); } catch {}
  }
  if (prevLog.length > 2000) {
    prevLog = '...(省略)...\n' + prevLog.slice(-2000);
  }

  const sessionId = require('crypto').randomUUID();

  const prompt = [
    `# [Slack/追加指示] ${titleFrom(pendingInfo.text)}`,
    '',
    '## 自律実行モード（最優先で従うこと）',
    'まるさんから追加指示を受けたタスクです。前回の実行結果を踏まえて追加作業を行ってください。',
    '- 確認フロー（レビュー要否・Notion転記・Remote Control）は全てスキップ',
    '- AskUserQuestion, EnterPlanMode, ExitPlanMode ツールは絶対に使用禁止（非対話セッションのため停止する）',
    '- CLAUDE.mdのスキルやファイル構成は参照してよい',
    '- 「承認待ち」などと返答せず、直ちに作業を開始すること',
    '',
    '## 元の指示内容',
    pendingInfo.text,
    '',
    '## 前回の実行結果',
    prevLog || '(ログなし)',
    '',
    '## 追加指示',
    newInstruction,
    '',
    '## 完了報告（必須）',
    `1. node tools/slack-notify.js --channel inbox --thread ${threadTs} --text "追加対応完了: {結果の要約}"`,
  ].join('\n');

  const logFile = spawnClaude(prompt, null, { sessionId });
  return { logFile, sessionId };
}

// ---------------------------------------------------------------------------
// Pending threads (L2/L3 awaiting reply)
// ---------------------------------------------------------------------------

function loadPending() {
  try { return JSON.parse(fs.readFileSync(PENDING_PATH, 'utf8')); } catch { return {}; }
}

function savePending(data) {
  fs.mkdirSync(path.dirname(PENDING_PATH), { recursive: true });
  fs.writeFileSync(PENDING_PATH, JSON.stringify(data), 'utf8');
}

function loadProcessed() {
  try { return JSON.parse(fs.readFileSync(PROCESSED_PATH, 'utf8')); } catch { return {}; }
}

function saveProcessed(ts) {
  const processed = loadProcessed();
  processed[ts] = Date.now();
  const entries = Object.entries(processed).sort((a, b) => b[1] - a[1]).slice(0, 200);
  fs.mkdirSync(path.dirname(PROCESSED_PATH), { recursive: true });
  fs.writeFileSync(PROCESSED_PATH, JSON.stringify(Object.fromEntries(entries)), 'utf8');
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

const APPROVAL_PATTERNS = /^(ok|OK|承認|やって|進めて|お願い|はい|yes|go|実行して|よろしく)$/i;
const QUESTION_PATTERNS = /？$|\?$|どうす|どちら|どっち|どれに|どの方向|相談したい/;

function stripSlackAnnotations(text) {
  // Remove Slack MCP annotation like "*使用して送信されました* Claude" or "使用して送信されました Claude"
  return text.replace(/\s*\*?使用して送信されました\*?\s*Claude\s*/g, '').trim();
}

function classify(text) {
  const trimmed = stripSlackAnnotations(text.trim());
  if (APPROVAL_PATTERNS.test(trimmed)) return 'APPROVAL';
  if (QUESTION_PATTERNS.test(trimmed)) return 'QUESTION';
  return 'TASK';
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const config = getConfig();
  if (!config.botToken || !config.channelInbox) return;

  const processed = loadProcessed();
  const pending = loadPending();
  let acted = false;

  // --- Part 1: Check top-level new messages ---
  let output;
  try {
    output = await run('node', [path.join(TOOLS_DIR, 'slack-secretary.js')]);
  } catch (err) {
    const errMsg = err.message || String(err);
    console.error('Secretary check failed:', errMsg);
    // Log full error to session log for debugging
    const ts = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
    try {
      fs.appendFileSync(
        path.join(AGENT_ROOT, 'projects/claude-code-ops/secretary-session.log'),
        `[${ts}] Secretary check error: ${errMsg}\n`,
        'utf8'
      );
    } catch {}
  }

  if (output) {
    let tasks;
    try { tasks = JSON.parse(output); } catch { tasks = []; }

    for (const task of tasks) {
      // Atomic dedup: skip if another dispatcher already claimed this message
      if (await hasOurReaction(config.botToken, config.channelInbox, task.ts)) {
        console.log(`[SKIP] Already being processed: ${task.text.slice(0, 40)}`);
        saveProcessed(task.ts);
        continue;
      }

      console.log(`[${task.level}] ${task.text.slice(0, 60)}`);
      acted = true;

      // Claim the task by adding eyes reaction immediately
      await addReaction(config.botToken, config.channelInbox, task.ts, REACTIONS.detected);
      saveProcessed(task.ts);

      try {
        if (task.level === 'TASK') {
          // Launch plan session (sync) → then await approval
          const planResult = launchPlan(task.text, task.ts);
          pending[task.ts] = { text: task.text, type: 'plan', time: Date.now(), sessionId: planResult.sessionId };
          savePending(pending);
          await addReaction(config.botToken, config.channelInbox, task.ts, REACTIONS.awaiting);
          console.log(`  → Plan session completed, awaiting approval (session: ${planResult.sessionId})`);

        } else if (task.level === 'QUESTION') {
          await addReaction(config.botToken, config.channelInbox, task.ts, REACTIONS.awaiting);
          await notify('inbox', 'ご質問を承りました。もう少し詳しく教えてください。\nこのスレッドに返信をお願いします。', task.ts);
          pending[task.ts] = { text: task.text, type: 'question', time: Date.now() };
          savePending(pending);
          console.log('  → Question, clarification requested');
        }
      } catch (err) {
        console.error(`  → Error: ${err.message}`);
        await addReaction(config.botToken, config.channelInbox, task.ts, REACTIONS.error);
      }
    }
  }

  // --- Part 2: Check pending threads for replies ---
  const pendingThreads = Object.keys(pending);
  if (pendingThreads.length === 0 && !acted) return;

  for (const threadTs of pendingThreads) {
    try {
      const replies = await slackGet('conversations.replies', config.botToken, {
        channel: config.channelInbox,
        ts: threadTs,
        limit: '20',
      });

      const userReplies = (replies.messages || [])
        .filter(m => !m.bot_id && m.ts !== threadTs && !processed[m.ts])
        .sort((a, b) => parseFloat(a.ts) - parseFloat(b.ts));

      if (userReplies.length === 0) continue;

      // Get the latest user reply
      const latest = userReplies[userReplies.length - 1];
      const replyLevel = classify(latest.text || '');
      console.log(`[Thread ${threadTs.slice(0, 8)}] Reply: "${(latest.text || '').slice(0, 50)}" → ${replyLevel}`);
      acted = true;

      // CRITICAL: Mark replies as processed AND update pending BEFORE launching
      // the sync session. This prevents duplicate execution if task scheduler
      // re-triggers during the 10-min sync execution window.
      for (const r of userReplies) saveProcessed(r.ts);

      const pendingInfo = pending[threadTs];

      // --- followup状態のスレッド処理 ---
      if (pendingInfo.type === 'followup') {
        const CLOSE_PATTERNS = /^(完了|done|close|終了|おしまい)$/i;
        const latestText = stripSlackAnnotations((latest.text || '').trim());

        if (CLOSE_PATTERNS.test(latestText)) {
          // 明示的クローズ
          delete pending[threadTs];
          savePending(pending);
          await removeReaction(config.botToken, config.channelInbox, threadTs, REACTIONS.followup);
          await addReaction(config.botToken, config.channelInbox, threadTs, REACTIONS.done);
          await notify('inbox', 'スレッドをクローズしました。お疲れさまでした。', threadTs);
          console.log(`  → Followup closed by user`);
        } else {
          // 追加指示 → 継続セッション起動（followupリアクションは維持）
          const combinedFollowup = userReplies.map(r => r.text).join('\n');

          try {
            const result = launchFollowup(threadTs, pendingInfo, combinedFollowup);
            pending[threadTs] = {
              ...pendingInfo,
              time: Date.now(),
              logFile: result.logFile,
              sessionId: result.sessionId,
              executionCount: (pendingInfo.executionCount || 1) + 1,
              followupTimeout: Date.now() + 4 * 3600_000,
            };
            savePending(pending);
            await notify('inbox',
              `追加指示の実行が完了しました（${pending[threadTs].executionCount}回目）。さらに追加があれば返信してください。\n「完了」と返信するか、4時間後に自動クローズします。`,
              threadTs);
            console.log(`  → Followup executed (count: ${pending[threadTs].executionCount})`);
          } catch (err) {
            await removeReaction(config.botToken, config.channelInbox, threadTs, REACTIONS.followup);
            await addReaction(config.botToken, config.channelInbox, threadTs, REACTIONS.error);
            throw err;
          }
        }
        continue;
      }

      // --- 通常の承認/質問スレッド処理 ---
      if (replyLevel === 'APPROVAL') {
        // Remove from pending immediately (before sync execution starts)
        delete pending[threadTs];
        savePending(pending);
        await removeReaction(config.botToken, config.channelInbox, threadTs, REACTIONS.awaiting);

        if (pendingInfo.type === 'plan') {
          // Plan approved → execute (sync, may take up to 10min)
          try {
            const result = launchFromPlan(threadTs, pendingInfo.text, pendingInfo.sessionId);
            console.log(`  → Plan approved, execution completed (session: ${result.sessionId})`);
            // Execution done → followup状態に遷移
            await addReaction(config.botToken, config.channelInbox, threadTs, REACTIONS.followup);
            pending[threadTs] = {
              text: pendingInfo.text,
              type: 'followup',
              time: Date.now(),
              logFile: result.logFile,
              sessionId: result.sessionId,
              executionCount: 1,
              followupTimeout: Date.now() + 4 * 3600_000,
            };
            savePending(pending);
            await notify('inbox',
              '実行完了しました。追加指示があればこのスレッドに返信してください。\n「完了」と返信するか、4時間後に自動クローズします。',
              threadTs);
          } catch (err) {
            await addReaction(config.botToken, config.channelInbox, threadTs, REACTIONS.error);
            throw err;
          }
        }
      } else {
        // Non-approval reply in thread → treat as clarification, re-plan
        const fullText = pendingInfo.text + '\n\n追加指示: ' + latest.text;
        // awaiting stays while re-planning (sync) — resume existing session
        const planResult = launchPlan(fullText, threadTs, pendingInfo.sessionId);
        pending[threadTs] = { text: fullText, type: 'plan', time: Date.now(), sessionId: planResult.sessionId };
        savePending(pending);
        console.log(`  → Clarification received, plan re-created (session: ${planResult.sessionId})`);
      }

    } catch (err) {
      console.error(`  → Thread check error: ${err.message}`);
    }
  }

  // Clean up old pending threads (>24h) and auto-close followups
  const DAY = 86400_000;
  for (const [ts, info] of Object.entries(pending)) {
    if (Date.now() - info.time > DAY) {
      delete pending[ts];
    } else if (info.type === 'followup' && info.followupTimeout && Date.now() > info.followupTimeout) {
      await removeReaction(config.botToken, config.channelInbox, ts, REACTIONS.followup);
      await addReaction(config.botToken, config.channelInbox, ts, REACTIONS.done);
      await notify('inbox', '一定時間返信がなかったため、スレッドを自動クローズしました。', ts);
      delete pending[ts];
    }
  }
  savePending(pending);
}

main().catch(err => {
  console.error('Dispatcher error:', err.message);
  process.exit(1);
});
