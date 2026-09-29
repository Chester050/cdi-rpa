import express from 'express';
import { WebSocketServer } from 'ws';
import http from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { RpaSession } from './RpaSession.js';
import { runRpa } from './rpaRunner.js';
import { siteConfigs } from './siteConfigs.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 未指定 site 时默认执行 CDI UAT
const DEFAULT_SITE = 'cdiUat';

/** 恒定时间比较，避免时序侧信道 */
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

/** 活跃会话表：sessionId -> RpaSession */
const sessions = new Map();

/**
 * WebSocket：前端与后端的实时通道。
 * 前端连接时带上 ?sessionId=xxx，后端把消息推送函数绑定到对应会话。
 */
wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const sessionId = url.searchParams.get('sessionId');
  const wsToken = url.searchParams.get('wsToken');

  const session = sessionId ? sessions.get(sessionId) : null;
  if (!session) {
    ws.send(JSON.stringify({ type: 'ERROR', message: '无效的 sessionId' }));
    ws.close();
    return;
  }

  // 校验会话专属令牌，防止会话被他人劫持
  if (!wsToken || !safeEqual(wsToken, session.wsToken)) {
    ws.send(JSON.stringify({ type: 'ERROR', message: '鉴权失败' }));
    ws.close();
    return;
  }

  // 绑定推送函数
  session.send = (payload) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
  };
  session.log('前端已连接');

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.type === 'SMS_CODE' && typeof msg.code === 'string') {
      const ok = session.submitSmsCode(msg.code.trim());
      session.send({
        type: 'LOG',
        message: ok ? '验证码已接收' : '当前不在等待验证码状态',
      });
    }

    if (msg.type === 'EMAIL' && typeof msg.email === 'string') {
      const ok = session.submitEmail(msg.email.trim());
      session.send({
        type: 'LOG',
        message: ok ? '邮箱已接收' : '当前不在等待邮箱状态',
      });
    }
  });

  ws.on('close', () => {
    session.log('前端连接断开');
  });
});

/**
 * 创建任务：返回 sessionId 与会话专属 wsToken，前端据此建立 WebSocket。
 * 无需鉴权（测试用）。body: { taskName?, userName?, password? } —— taskName 缺省为 cdiUat。
 * userName 覆盖站点默认用户名；password 仅在站点 requiredFields 含 password 时使用，否则忽略。
 */
app.post('/api/tasks', (req, res) => {
  // 非 JSON 请求体不会被 express.json 解析，taskName 会静默回退到 cdiUat，故显式拒绝
  if (Number(req.get('content-length') ?? 0) > 0 && !req.is('application/json')) {
    return res.status(415).json({ error: 'Content-Type 必须为 application/json' });
  }

  const { taskName = DEFAULT_SITE, userName, password } = req.body ?? {};
  const config = siteConfigs[taskName];
  if (!config) {
    return res.status(400).json({ error: `未知任务: ${taskName}` });
  }

  const requiredFields = config.requiredFields ?? [];
  const missing = requiredFields.filter((field) => typeof req.body?.[field] !== 'string' || !req.body[field]);
  if (missing.length) {
    return res.status(400).json({ error: `缺少字段: ${missing.join(', ')}` });
  }

  const vars = { ...config.credentials };
  if (typeof userName === 'string' && userName) vars.username = userName;
  if (requiredFields.includes('password')) vars.password = password;

  const id = randomUUID();
  // send 先用占位，等 WebSocket 连上后再替换
  const session = new RpaSession(id, () => {});
  session.wsToken = randomUUID(); // 会话专属令牌，保护 WebSocket 连接
  sessions.set(id, session);

  res.json({ sessionId: id, wsToken: session.wsToken });

  // 给前端一点时间建立 WS，再启动流程
  setTimeout(() => {
    runRpa(session, config, vars).finally(() => {
      // 完成后延时清理会话
      setTimeout(() => sessions.delete(id), 60_000);
    });
  }, 800);
});

/** 可选：列出支持的站点 */
app.get('/api/sites', (_req, res) => {
  res.json(Object.keys(siteConfigs));
});

const PORT = process.env.PORT ?? 3000;
server.listen(PORT, () => {
  console.log(`RPA 服务已启动: http://localhost:${PORT}`);
});
