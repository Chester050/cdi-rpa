const $ = (id) => document.getElementById(id);

const startBtn = $('startBtn');
const submitCodeBtn = $('submitCodeBtn');
const mfaCard = $('mfaCard');
const statusEl = $('status');
const logEl = $('log');

let ws = null;

// 初始化站点下拉列表
fetch('/api/sites')
  .then((r) => r.json())
  .then((sites) => {
    $('site').innerHTML = sites.map((s) => `<option value="${s}">${s}</option>`).join('');
  })
  .catch(() => appendLog('无法加载站点列表'));

function appendLog(msg) {
  const time = new Date().toLocaleTimeString();
  logEl.textContent += `[${time}] ${msg}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

function setStatus(status) {
  statusEl.className = `status ${status}`;
  statusEl.textContent = {
    running: '执行中',
    waiting_code: '等待验证码',
    done: '已完成',
    error: '出错',
  }[status] || status;
  statusEl.classList.remove('hidden');
}

// 1. 点击开始 → 创建任务，拿到 sessionId 后建立 WebSocket
startBtn.addEventListener('click', async () => {
  startBtn.disabled = true;
  logEl.textContent = '';
  mfaCard.classList.add('hidden');

  try {
    const res = await fetch('/api/tasks', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + $('token').value.trim(),
      },
      body: JSON.stringify({
        site: $('site').value,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '创建任务失败');

    connectWs(data.sessionId, data.wsToken);
  } catch (err) {
    appendLog('错误: ' + err.message);
    startBtn.disabled = false;
  }
});

function connectWs(sessionId, wsToken) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(
    `${proto}://${location.host}/?sessionId=${sessionId}&wsToken=${wsToken}`
  );

  ws.onopen = () => appendLog('已连接到服务端');

  ws.onmessage = (evt) => {
    const msg = JSON.parse(evt.data);
    switch (msg.type) {
      case 'LOG':
        appendLog(msg.message);
        break;
      case 'STATUS':
        setStatus(msg.status);
        if (msg.status === 'done' || msg.status === 'error') {
          startBtn.disabled = false;
          mfaCard.classList.add('hidden');
        }
        break;
      case 'NEED_SMS_CODE':
        // 2. 后端流程挂起，显示验证码输入框
        mfaCard.classList.remove('hidden');
        $('smsCode').value = '';
        $('smsCode').focus();
        if (msg.invalid) {
          appendLog(`>>> 验证码错误，请重新输入（第 ${msg.attempt}/${msg.maxRetries} 次）<<<`);
          $('mfaHint').textContent = `验证码错误，请重试（${msg.attempt}/${msg.maxRetries}）`;
          $('mfaHint').classList.remove('hidden');
        } else {
          appendLog('>>> 需要短信验证码，请输入 <<<');
          $('mfaHint').classList.add('hidden');
        }
        break;
      case 'SMS_CODE_INVALID':
        appendLog(`验证码错误（第 ${msg.attempt}/${msg.maxRetries} 次）`);
        break;
      case 'ERROR':
        appendLog('服务端错误: ' + msg.message);
        startBtn.disabled = false;
        break;
    }
  };

  ws.onclose = () => appendLog('连接已关闭');
  ws.onerror = () => appendLog('WebSocket 连接错误');
}

// 3. 提交验证码 → 通过 WebSocket 发回后端，唤醒挂起的流程
submitCodeBtn.addEventListener('click', () => {
  const code = $('smsCode').value.trim();
  if (!code) return;
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'SMS_CODE', code }));
    mfaCard.classList.add('hidden');
    appendLog('已提交验证码，等待继续...');
  }
});

$('smsCode').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') submitCodeBtn.click();
});
