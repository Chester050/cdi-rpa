import express from 'express';
import { timingSafeEqual } from 'node:crypto';

import { RpaSession } from './RpaSession.js';
import { runRpa } from './rpaRunner.js';
import { siteConfigs } from './siteConfigs.js';

/**
 * RPA Agent API —— 被动服务，只响应 CDI（csd-ai-service）的调用：
 * 启动任务 / 查询状态（CDI 在任务进行中轮询）/ 提交验证码 / 取消。
 * Agent 不主动调用 CDI。server.js（本地调试 UI + WS）保持不变。
 */

// 该端口对 CDI 开放；固定令牌须与 csd-ai-service 的 RPA_AGENT_TOKEN 一致，环境变量可覆盖（本地联调用）
const AGENT_TOKEN = process.env.RPA_AGENT_TOKEN || '47dfec45493677836284849a978d14c64b57694bdaae47baacaeef810ab67776';
const AGENT_ID = process.env.RPA_AGENT_ID ?? 'rpa-agent-local';
const PORT = process.env.RPA_AGENT_PORT ?? 3100;
// 任务结束后保留记录的时间，让 CDI 能读到最终状态
const RETENTION_MS = Number(process.env.RPA_RUN_RETENTION_MINUTES ?? 60) * 60_000;

/** 恒定时间比较，避免时序侧信道 */
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function requireAgentAuth(req, res, next) {
  const header = req.get('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token || !safeEqual(token, AGENT_TOKEN)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

/** 任务表：run_id -> { session, record }。record 是 CDI 轮询读取的状态快照，不含密码/验证码 */
const runs = new Map();

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

function createRecord(runId, siteKey) {
  const now = new Date().toISOString();
  return {
    run_id: runId,
    site_key: siteKey,
    status: 'running',
    error: null,
    mfa: null,
    email_request: null,
    timeline: [],
    started_at: now,
    updated_at: now,
    finished_at: null,
  };
}

function addMilestone(record, milestone, detail) {
  const at = new Date().toISOString();
  record.timeline.push(detail ? { milestone, at, detail } : { milestone, at });
  record.updated_at = at;
}

function finish(record, status, error = null) {
  record.status = status;
  record.error = error;
  record.mfa = null;
  record.email_request = null;
  addMilestone(record, status, error ?? undefined);
  record.finished_at = record.updated_at;
}

/** 把 RpaSession 推送的消息记录到 record（LOG 只打印，不入时间线） */
function createRecorder(session, record) {
  return (payload) => {
    switch (payload.type) {
      case 'MILESTONE':
        addMilestone(record, payload.name, payload.detail);
        break;
      case 'NEED_SMS_CODE':
        record.status = 'waiting_mfa';
        record.mfa = {
          attempt: payload.attempt,
          max_attempts: payload.maxRetries,
          invalid: payload.invalid,
          expires_at: new Date(payload.expiresAt).toISOString(),
        };
        addMilestone(record, 'mfa_required', `${payload.attempt}/${payload.maxRetries}`);
        break;
      case 'NEED_EMAIL':
        record.status = 'waiting_email';
        record.email_request = { expires_at: new Date(payload.expiresAt).toISOString() };
        addMilestone(record, 'email_required');
        break;
      case 'SMS_CODE_INVALID':
        addMilestone(record, 'mfa_invalid', `${payload.attempt}/${payload.maxRetries}`);
        break;
      case 'STATUS':
        if (payload.status === 'running') {
          record.status = 'running';
          record.mfa = null;
          record.email_request = null;
          record.updated_at = new Date().toISOString();
        } else if (payload.status === 'done') {
          finish(record, 'completed');
        } else if (payload.status === 'error') {
          if (session.cancelled) finish(record, 'cancelled');
          else finish(record, 'failed', payload.message);
        }
        break;
    }
  };
}

const app = express();
app.use(express.json());
app.use('/agent', requireAgentAuth);

/**
 * 启动任务。body: { run_id, taskName, userName?, password?, ingestion? }
 * 字段与 server.js /api/tasks 一致：taskName 为 siteConfigs 的键，站点 requiredFields 缺失则 400。
 * userName 缺省时回退到站点配置里的 credentials（本地联调用）。ingestion 暂未使用（上传待实现）。
 */
app.post('/agent/runs', (req, res) => {
  const { run_id: runId, taskName, userName, password } = req.body ?? {};
  if (typeof runId !== 'string' || !runId) {
    return res.status(400).json({ error: 'run_id is required' });
  }
  const config = siteConfigs[taskName];
  if (!config) {
    return res.status(400).json({ error: `unknown taskName: ${taskName}` });
  }
  const requiredFields = config.requiredFields ?? [];
  const missing = requiredFields.filter((field) => typeof req.body?.[field] !== 'string' || !req.body[field]);
  if (missing.length) {
    return res.status(400).json({ error: `missing fields: ${missing.join(', ')}` });
  }
  if (runs.has(runId)) {
    return res.status(409).json({ error: 'run already exists' });
  }

  const record = createRecord(runId, taskName);
  const session = new RpaSession(runId, () => {});
  session.send = createRecorder(session, record);
  runs.set(runId, { session, record });
  addMilestone(record, 'initiated');

  const vars = { ...config.credentials };
  if (typeof userName === 'string' && userName) vars.username = userName;
  if (requiredFields.includes('password')) vars.password = password;

  res.status(202).json({ run_id: runId, agent_id: AGENT_ID });

  runRpa(session, config, vars).finally(() => {
    setTimeout(() => runs.delete(runId), RETENTION_MS).unref();
  });
});

/** 查询任务状态（CDI 在任务进行中轮询） */
app.get('/agent/runs/:runId', (req, res) => {
  const run = runs.get(req.params.runId);
  if (!run) return res.status(404).json({ error: 'run not found' });
  res.json(run.record);
});

/** 提交短信验证码。body: { code } */
app.post('/agent/runs/:runId/mfa-code', (req, res) => {
  const run = runs.get(req.params.runId);
  if (!run) return res.status(404).json({ error: 'run not found' });

  const code = typeof req.body?.code === 'string' ? req.body.code.trim() : '';
  if (!/^\d{4,10}$/.test(code)) {
    return res.status(400).json({ error: 'code must be 4-10 digits' });
  }
  if (!run.session.submitSmsCode(code)) {
    return res.status(409).json({ error: 'run is not waiting for a code' });
  }
  addMilestone(run.record, 'mfa_code_received');
  res.status(202).end();
});

/** 提交登录邮箱（站点含 waitEmail 步骤时）。body: { email } */
app.post('/agent/runs/:runId/email', (req, res) => {
  const run = runs.get(req.params.runId);
  if (!run) return res.status(404).json({ error: 'run not found' });

  const email = typeof req.body?.email === 'string' ? req.body.email.trim() : '';
  if (!/^[^\s@]+@[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'email is invalid' });
  }
  if (!run.session.submitEmail(email)) {
    return res.status(409).json({ error: 'run is not waiting for an email' });
  }
  addMilestone(run.record, 'email_received');
  res.status(202).end();
});

/** 取消任务：当前步骤结束后终止，状态变为 cancelled */
app.post('/agent/runs/:runId/cancel', (req, res) => {
  const run = runs.get(req.params.runId);
  if (!run) return res.status(404).json({ error: 'run not found' });
  if (TERMINAL.has(run.record.status)) {
    return res.status(409).json({ error: 'run already finished' });
  }
  run.session.cancel('CDI 已取消任务');
  res.status(202).end();
});

app.get('/agent/health', (_req, res) => {
  const activeRuns = [...runs.values()].filter((run) => !TERMINAL.has(run.record.status)).length;
  res.json({ agent_id: AGENT_ID, sites: Object.keys(siteConfigs), active_runs: activeRuns });
});

app.listen(PORT, () => {
  console.log(`RPA Agent 已启动: http://localhost:${PORT} (agent_id=${AGENT_ID})`);
});
