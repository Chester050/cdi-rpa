import { chromium } from 'playwright';
import { openAsBlob } from 'node:fs';
import path from 'node:path';

/**
 * 步骤解释器：按配置(steps)依次驱动 Playwright 执行。
 * 新增目标站点时只需写配置，无需改动本文件。
 *
 * 支持的 action：
 *   goto            { url }                        打开页面（url 可省略，默认用配置根 url）
 *   fill            { selector, valueRef | value } 填入文本（valueRef 从 vars 取值）
 *   click           { selector }                   点击
 *   waitForSelector { selector, timeout? }         等待元素出现
 *   waitForUrl      { url, timeout? }              等待 URL 匹配（支持 glob）
 *   waitSmsCode     { selector, submitSelector, successSelector?, errorSelector?, maxRetries?, timeout? }
 *                                                  ★挂起，等待前端输入验证码，支持错误重试
 *   waitEmail       { input, submit?, timeout? }   ★挂起，等待前端输入登录邮箱，填入 input 并点击 submit
 *   upload          { url, timeout? }              把上一个 download 保存的文件 POST 到 url（multipart 字段 file）
 *   sleep           { ms }                         等待固定时间
 *   screenshot      { path? }                      截图（调试用）
 */

/**
 * @param {import('./RpaSession.js').RpaSession} session
 * @param {object} config  目标站点配置：{ url, steps, headless? }
 * @param {object} vars    运行时变量：{ username, password, ... }
 */
export async function runRpa(session, config, vars = {}) {
  const runtimeVars = { ...vars };
  let browser;

  try {
    session.setStatus('running');
    session.log('启动浏览器...');
    browser = await chromium.launch({ channel: 'chrome', headless: config.headless ?? false });
    // 每个任务独立上下文，隔离 Cookie
    const context = await browser.newContext(
      config.httpAuth && runtimeVars.password
        ? { httpCredentials: { username: runtimeVars.username, password: runtimeVars.password } }
        : {}
    );
    const page = await context.newPage();

    for (const [index, step] of config.steps.entries()) {
      if (session.cancelled) throw new Error('任务已取消');
      const label = `步骤 ${index + 1}/${config.steps.length} [${step.action}]`;
      session.log(`${label} ${step.selector || step.url || ''}`);
      await execStep(page, step, session, runtimeVars, config);
      if (step.milestone) session.milestone(step.milestone);
    }

    session.setStatus('done');
    session.log('任务完成 ✅');
    return { ok: true };
  } catch (err) {
    session.setStatus('error', { message: err.message });
    session.log(`任务失败 ❌: ${err.message}`);
    return { ok: false, error: err.message };
  } finally {
    if (browser) {
      // 稍等便于观察，然后回收浏览器实例
      await browser.close().catch(() => {});
      session.log('浏览器已关闭');
    }
  }
}

async function execStep(page, step, session, vars, config) {
  const value = resolveValue(step, vars);
  const timeout = step.timeout ?? 30_000;

  switch (step.action) {
    case 'goto':
      await page.goto(step.url ?? config.url, { waitUntil: step.waitUntil ?? 'load' });
      break;

    case 'fill':
      await getLocator(page, step).fill(value ?? '', { timeout });
      break;

    case 'click':
      await getLocator(page, step).click({ timeout });
      break;

    case 'waitForSelector':
      await getLocator(page, step).waitFor({ state: 'visible', timeout });
      break;

    case 'waitForUrl':
      await page.waitForURL(step.url, { timeout });
      break;

    case 'waitSmsCode': {
      // ★ 关键：挂起流程，等待用户输入验证码，并支持错误重试
      await handleSmsCode(page, step, session, vars);
      break;
    }

    case 'waitEmail': {
      // 挂起流程，等待 CDI / 前端提供登录邮箱，填入后提交
      const email = await session.waitForEmail(step.timeout ?? 180_000);
      session.setStatus('running');
      vars.username = email;
      await getLocator(page, step.input).fill(email, { timeout: 30_000 });
      if (step.submit) await getLocator(page, step.submit).click({ timeout: 30_000 });
      break;
    }

    case 'download': {
      // 点击某元素触发下载，并保存到指定路径
      const downloadPromise = page.waitForEvent('download', { timeout });
      await getLocator(page, step).click({ timeout });
      const download = await downloadPromise;
      const savePath = step.path ?? `download-${download.suggestedFilename()}`;
      await download.saveAs(savePath);
      vars.downloadPath = savePath;
      session.log(`已下载文件: ${savePath}`);
      break;
    }

    case 'upload': {
      // 把上一个 download 步骤保存的文件以 multipart 字段 file 上传
      if (!vars.downloadPath) throw new Error('upload 前没有已下载的文件');
      const form = new FormData();
      form.append('file', await openAsBlob(vars.downloadPath), path.basename(vars.downloadPath));
      const res = await fetch(step.url, { method: 'POST', body: form, signal: AbortSignal.timeout(timeout) });
      if (!res.ok) throw new Error(`上传失败: HTTP ${res.status} ${await res.text().catch(() => '')}`);
      session.log(`已上传文件: ${vars.downloadPath} -> ${step.url}`);
      break;
    }

    case 'sleep':
      await page.waitForTimeout(step.ms ?? 1000);
      break;

    case 'screenshot':
      await page.screenshot({ path: step.path ?? `shot-${Date.now()}.png` });
      break;

    default:
      throw new Error(`未知的 action: ${step.action}`);
  }
}

/**
 * 把一个 step 的定位信息解析成 Playwright Locator。
 * 支持两种风格（对应 codegen 输出）：
 *   1) CSS/文本选择器：   { selector: '#otp' }
 *   2) 语义定位器：
 *      role:        { role: 'button', name: 'Sign in', exact: true }
 *      testId:      { testId: 'side-nav-menu-item-CONTRIBUTED_REPOS' }
 *      label:       { label: 'Password' }
 *      text:        { text: 'Download ZIP' }
 *      placeholder: { placeholder: 'Search' }
 */
function getLocator(page, step) {
  if (step.role) {
    return page.getByRole(step.role, {
      name: step.name,
      exact: step.exact ?? false,
    });
  }
  if (step.testId) return page.getByTestId(step.testId);
  if (step.label) return page.getByLabel(step.label, { exact: step.exact ?? false });
  if (step.text) return page.getByText(step.text, { exact: step.exact ?? false });
  if (step.placeholder) return page.getByPlaceholder(step.placeholder);
  if (step.selector) return page.locator(step.selector);
  throw new Error(`step 缺少定位信息（selector/role/testId/label/text/placeholder）: ${JSON.stringify(step)}`);
}

/** 解析 step 的取值：优先 valueRef（从 vars 取），否则用字面 value */
function resolveValue(step, vars) {
  if (step.valueRef !== undefined) return vars[step.valueRef];
  return step.value;
}

/**
 * 处理短信验证码：挂起等待用户输入，填入并提交，判定结果，失败则重试。
 */
async function handleSmsCode(page, step, session, vars) {
  const maxRetries = step.maxRetries ?? 3;
  const waitTimeout = step.timeout ?? 180_000;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const code = await session.waitForSmsCode(waitTimeout, {
      attempt,
      maxRetries,
      invalid: attempt > 1,
    });
    session.setStatus('running');
    vars.smsCode = code;

    // 填入验证码并提交（input/submit 支持 CSS 或语义定位器描述对象）
    const inputLoc = smsLocator(page, step, 'input', 'selector');
    const submitLoc = smsLocator(page, step, 'submit', 'submitSelector');
    if (inputLoc) await inputLoc.fill(code);
    if (submitLoc) await submitLoc.click();

    // 判定结果：优先看成功标志，再看错误标志
    const verdict = await evaluateSmsResult(page, step);

    if (verdict === 'success') {
      session.log(`验证码校验通过（第 ${attempt} 次）`);
      return;
    }
    if (verdict === 'error') {
      session.log(`验证码错误（第 ${attempt}/${maxRetries} 次）`);
      session.send({ type: 'SMS_CODE_INVALID', attempt, maxRetries });
      // 清空输入框以便重填
      if (inputLoc) await inputLoc.fill('').catch(() => {});
      continue;
    }
    // 无法判定（未配置 success/error 选择器）：视为成功放行
    session.log('未配置成功/错误标志，默认放行');
    return;
  }

  throw new Error(`验证码连续 ${maxRetries} 次错误，任务终止`);
}

/**
 * 为 waitSmsCode 的子目标构造 Locator。
 * 优先用对象描述键（如 step.input = { role, name }），
 * 回退到旧的 CSS 字符串键（如 step.selector）。
 * @returns {import('playwright').Locator | null}
 */
function smsLocator(page, step, objKey, cssKey) {
  if (step[objKey]) return getLocator(page, step[objKey]);
  if (step[cssKey]) return page.locator(step[cssKey]);
  return null;
}

/**
 * 判定验证码提交结果。
 * @returns {'success' | 'error' | 'unknown'}
 */
async function evaluateSmsResult(page, step) {
  const probeTimeout = step.probeTimeout ?? 8000;

  // success/error 均支持 CSS 字符串键或对象描述键
  const successLoc = smsLocator(page, step, 'success', 'successSelector');
  const errorLoc = smsLocator(page, step, 'error', 'errorSelector');

  // 若同时配置了成功与错误标志，用竞态等待哪个先出现
  if (successLoc && errorLoc) {
    try {
      return await Promise.race([
        successLoc.waitFor({ state: 'visible', timeout: probeTimeout }).then(() => 'success'),
        errorLoc.waitFor({ state: 'visible', timeout: probeTimeout }).then(() => 'error'),
      ]);
    } catch {
      return 'unknown';
    }
  }

  if (successLoc) {
    try {
      await successLoc.waitFor({ state: 'visible', timeout: probeTimeout });
      return 'success';
    } catch {
      return 'error';
    }
  }

  if (errorLoc) {
    try {
      await errorLoc.waitFor({ state: 'visible', timeout: probeTimeout });
      return 'error';
    } catch {
      return 'success';
    }
  }

  return 'unknown';
}
