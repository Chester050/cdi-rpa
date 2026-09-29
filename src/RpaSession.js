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
    this.status = 'created'; // created | running | waiting_code | waiting_email | done | error
    this.cancelled = false;
    this._waitingFor = null; // 'sms' | 'email'
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

  /** 记录业务里程碑（如 portal_opened / logged_in），供 CDI 轮询展示 */
  milestone(name, detail) {
    this.log(`里程碑: ${name}${detail ? ` (${detail})` : ''}`);
    this.send({ type: 'MILESTONE', name, detail });
  }

  /**
   * 挂起流程，等待用户输入短信验证码。
   * @param {number} timeoutMs 超时时间，超时则 reject 以便清理浏览器
   * @param {object} meta 附加信息，如 { attempt, maxRetries, invalid }
   * @returns {Promise<string>} 用户提交的验证码
   */
  waitForSmsCode(timeoutMs = 180_000, meta = {}) {
    this.setStatus('waiting_code');
    this.send({ type: 'NEED_SMS_CODE', ...meta, expiresAt: Date.now() + timeoutMs });
    return this._suspend('sms', timeoutMs, '等待验证码超时');
  }

  /** 用户提交验证码时调用，唤醒 waitForSmsCode */
  submitSmsCode(code) {
    return this._resume('sms', code);
  }

  /**
   * 挂起流程，等待用户输入登录邮箱。
   * @param {number} timeoutMs 超时时间，超时则 reject 以便清理浏览器
   * @returns {Promise<string>} 用户提交的邮箱
   */
  waitForEmail(timeoutMs = 180_000) {
    this.setStatus('waiting_email');
    this.send({ type: 'NEED_EMAIL', expiresAt: Date.now() + timeoutMs });
    return this._suspend('email', timeoutMs, '等待邮箱超时');
  }

  /** 用户提交邮箱时调用，唤醒 waitForEmail */
  submitEmail(email) {
    return this._resume('email', email);
  }

  // 同一时刻只挂起一种输入；kind 防止验证码被当成邮箱填入（反之亦然）
  _suspend(kind, timeoutMs, timeoutMessage) {
    return new Promise((resolve, reject) => {
      this._waitingFor = kind;
      this._codeResolver = resolve;
      this._codeRejecter = reject;
      this._codeTimer = setTimeout(() => {
        this._clearWaiters();
        reject(new Error(timeoutMessage));
      }, timeoutMs);
    });
  }

  _resume(kind, value) {
    if (this._codeResolver && this._waitingFor === kind) {
      this._codeResolver(value);
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
    this._waitingFor = null;
  }

  /** 会话被销毁时，拒绝掉仍在等待的 Promise，避免流程悬挂 */
  cancel(reason = '会话已取消') {
    this.cancelled = true;
    if (this._codeRejecter) {
      this._codeRejecter(new Error(reason));
    }
    this._clearWaiters();
  }
}
