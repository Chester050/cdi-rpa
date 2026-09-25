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

// 访问令牌：通过环境变量配置，未设置时用开发默认值（仅限本地）
const API_TOKEN = process.env.API_TOKEN ?? 'dev-token';
if (API_TOKEN === 'dev-token') {
  console.warn('[警告] 正在使用默认令牌 dev-token，生产环境请设置环境变量 API_TOKEN');
}

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
  });

  ws.on('close', () => {
    session.log('前端连接断开');
  });
});

/** 鉴权中间件：校验 Authorization: Bearer <token> */
function requireAuth(req, res, next) {
  const header = req.get('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token || !safeEqual(token, API_TOKEN)) {
    return res.status(401).json({ error: '鉴权失败：令牌无效' });
  }
  next();
}

/**
 * 创建任务：返回 sessionId 与会话专属 wsToken，前端据此建立 WebSocket。
 * 需鉴权。body: { site: 'demo' } —— 凭据由站点配置提供，不由前端传入。
 */
app.post('/api/tasks', requireAuth, (req, res) => {
  const { site } = req.body ?? {};
  const config = siteConfigs[site];
  if (!config) {
    return res.status(400).json({ error: `未知站点: ${site}` });
  }

  const id = randomUUID();
  // send 先用占位，等 WebSocket 连上后再替换
  const session = new RpaSession(id, () => {});
  session.wsToken = randomUUID(); // 会话专属令牌，保护 WebSocket 连接
  sessions.set(id, session);

  res.json({ sessionId: id, wsToken: session.wsToken });

  // 给前端一点时间建立 WS，再启动流程（凭据取自站点配置）
  setTimeout(() => {
    runRpa(session, config, config.credentials ?? {}).finally(() => {
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
