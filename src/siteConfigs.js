/**
 * 目标站点配置。
 * 每个站点一份配置：定义登录 + MFA + 后续操作的步骤。
 *
 * 步骤的定位方式与 `playwright codegen` 输出一一对应，可几乎照抄：
 *   codegen: page.getByRole('button', { name: 'Sign in', exact: true }).click();
 *   配置:    { action: 'click', role: 'button', name: 'Sign in', exact: true }
 *
 *   codegen: page.getByRole('textbox', { name: 'Password' }).fill('...');
 *   配置:    { action: 'fill', role: 'textbox', name: 'Password', valueRef: 'password' }
 *
 *   codegen: page.getByTestId('side-nav-menu-item-...').click();
 *   配置:    { action: 'click', testId: 'side-nav-menu-item-...' }
 *
 * 定位键：role(+name,exact) | testId | label | text | placeholder | selector(CSS)
 * 凭据请用 valueRef 从运行时变量取（username/password），不要写死在文件里。
 */
export const siteConfigs = {
  /*
  // === GitHub 登录 + 验证码 + 下载仓库 ZIP ===
  github: {
    url: 'https://github.com/',
    headless: false,
    // 凭据直接由配置提供（从环境变量读取，避免明文写入文件）。
    // 运行前设置：$env:GITHUB_USERNAME / $env:GITHUB_PASSWORD
    credentials: {
      username: process.env.GITHUB_USERNAME ?? '',
      password: process.env.GITHUB_PASSWORD ?? '',
    },
    steps: [
      { action: 'goto' },
      { action: 'click', role: 'link', name: 'Sign in' },
      { action: 'fill', role: 'textbox', name: 'Username or email address', valueRef: 'username' },
      { action: 'fill', role: 'textbox', name: 'Password', valueRef: 'password' },
      { action: 'click', role: 'button', name: 'Sign in', exact: true },

      // 等待验证码输入框出现
      { action: 'waitForSelector', role: 'textbox', name: 'Enter the verification code', timeout: 20000 },

      // ★ 挂起，等待用户在前端输入验证码（替换 codegen 里写死的 fill('727894')）
      {
        action: 'waitSmsCode',
        // 验证码输入框：用语义定位器描述对象
        input: { role: 'textbox', name: 'Enter the verification code' },
        // GitHub 输入满 6 位通常自动提交，无独立提交按钮，故不配 submit
        // 成功标志：登录后出现的元素（右上角菜单）
        success: { role: 'button', name: 'Open menu' },
        // 错误标志：GitHub 验证码错误提示（如不确定可先删掉此项）
        error: { text: 'The code you entered' },
        maxRetries: 3,
        timeout: 180000,
      },

      // 登录成功后：仪表盘上直接点仓库链接
      { action: 'click', role: 'link', name: 'KeithLi2020/test' },
      { action: 'click', role: 'button', name: 'Code' },

      // 触发下载并保存
      { action: 'download', role: 'link', name: 'Download ZIP', path: 'test-repo.zip' },
    ],
  },
  */

  // === CDI UAT 后台：Lenovo AAD 单点登录 ===
  cdiUat: {
    url: "https://cdi-uat.lenovo.com/admin",
    headless: false,
    // 运行前设置：$env:CDI_USERNAME
    credentials: {
      username: process.env.CDI_USERNAME ?? "kchet@lenovo.com",
    },
    steps: [
      // 该站点有资源长时间挂起，load 事件 30s 内不触发，只等 DOM 就绪
      { action: "goto", waitUntil: "domcontentloaded" },
      { action: "click", role: "button", name: "Sign in with Lenovo AAD" },

      // codegen 录到的 microsoftonline / stscn 跳转链接含一次性 state/nonce，不能写死，改为等待页面
      { action: "waitForUrl", url: "**/login.microsoftonline.com/**" },
      { action: "fill", role: "textbox", name: "someone@example.com", valueRef: "username" },
      { action: "click", role: "button", name: "Next" },

      // ADFS 集成 Windows 认证后回跳后台
      { action: "waitForUrl", url: "https://cdi-uat.lenovo.com/admin**", timeout: 60000 },
      { action: "click", role: "button", name: "I Understand" },
    ],
  },

  /*
  // === 通用示例（CSS 选择器风格） ===
  demo: {
    url: 'https://example.com/login',
    headless: false,
    steps: [
      { action: 'goto' },
      { action: 'fill', selector: '#username', valueRef: 'username' },
      { action: 'fill', selector: '#password', valueRef: 'password' },
      { action: 'click', selector: 'button[type="submit"]' },

      // 等待短信验证码输入框出现
      { action: 'waitForSelector', selector: '#otp-input', timeout: 20000 },

      // ★ 挂起，等待用户输入验证码；支持错误重试
      {
        action: 'waitSmsCode',
        selector: '#otp-input',          // 验证码输入框
        submitSelector: '#otp-submit',   // 提交按钮
        successSelector: '#dashboard',   // 出现则判定成功
        errorSelector: '.otp-error',     // 出现则判定验证码错误并重试
        maxRetries: 3,
        timeout: 180000,
      },

      // 登录成功后的后续自动化操作（按需扩展）
      { action: 'waitForSelector', selector: '#dashboard', timeout: 20000 },
      { action: 'screenshot', path: 'done.png' },
    ],
  },
  */
};
