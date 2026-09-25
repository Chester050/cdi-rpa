/**
 * RpaSession —— 单个 RPA 任务的会话。
 * 核心职责：管理 Playwright 流程与前端之间的"暂停 / 恢复"交互。
 *
 * 暂停/恢复原理：
 *   自动化流程跑到需要验证码时调用 waitForSmsCode()，返回一个 Promise 并挂起。
 *   该 Promise 的 resolve 函数被保存起来；当用户从前端提交验证码时，
 *   submitSmsCode() 调用 resolve，从而唤醒被挂起的 await，流程继续。
 */
export class RpaSession {
  /**
   * @param {string} id 会话 id
   * @param {(payload: object) => void} send 向对应前端推送消息的函数
   */
  constructor(id, send) {
    this.id = id;
    this.send = send;
    this.status = 'created'; // created | running | waiting_code | done | error
    this._codeResolver = null;
    this._codeRejecter = null;
    this._codeTimer = null;
  }

  /** 推送日志到前端并打印 */
  log(message) {
    console.log(`[${this.id}] ${message}`);
    this.send({ type: 'LOG', message, ts: Date.now() });
  }

  setStatus(status, extra = {}) {
    this.status = status;
    this.send({ type: 'STATUS', status, ...extra });
  }

  /**
   * 挂起流程，等待用户输入短信验证码。
   * @param {number} timeoutMs 超时时间，超时则 reject 以便清理浏览器
   * @param {object} meta 附加信息，如 { attempt, maxRetries, invalid }
   * @returns {Promise<string>} 用户提交的验证码
   */
  waitForSmsCode(timeoutMs = 180_000, meta = {}) {
    this.setStatus('waiting_code');
    this.send({ type: 'NEED_SMS_CODE', ...meta });

    return new Promise((resolve, reject) => {
      this._codeResolver = resolve;
      this._codeRejecter = reject;
      this._codeTimer = setTimeout(() => {
        this._clearWaiters();
        reject(new Error('等待验证码超时'));
      }, timeoutMs);
    });
  }

  /** 用户提交验证码时调用，唤醒 waitForSmsCode */
  submitSmsCode(code) {
    if (this._codeResolver) {
      this._codeResolver(code);
      this._clearWaiters();
      return true;
    }
    return false;
  }

  _clearWaiters() {
    if (this._codeTimer) clearTimeout(this._codeTimer);
    this._codeTimer = null;
    this._codeResolver = null;
    this._codeRejecter = null;
  }

  /** 会话被销毁时，拒绝掉仍在等待的 Promise，避免流程悬挂 */
  cancel(reason = '会话已取消') {
    if (this._codeRejecter) {
      this._codeRejecter(new Error(reason));
    }
    this._clearWaiters();
  }
}
