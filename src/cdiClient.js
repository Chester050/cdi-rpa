/**
 * cdiClient —— RPA 回调 CDI（csd-ai-service）的 HTTP 客户端。
 * 只发状态事件；事件体不含验证码或密码。
 */
const CDI_BASE_URL = process.env.CDI_BASE_URL;
const CDI_API_TOKEN = process.env.CDI_API_TOKEN ?? '';
const MAX_ATTEMPTS = 3;

/**
 * 上报运行事件。重试 3 次（网络错误 / 5xx），永不抛错，避免中断 RPA 流程。
 * @returns {Promise<{ cancelRequested: boolean }>}
 */
export async function postEvent(runId, event) {
  // CDI 端点未就绪时（本地联调），只打印事件
  if (!CDI_BASE_URL) {
    console.log(`[${runId}] 事件(未配置 CDI_BASE_URL): ${JSON.stringify(event)}`);
    return { cancelRequested: false };
  }

  const url = `${CDI_BASE_URL}/api/v1/reporting-rpa/agent/runs/${encodeURIComponent(runId)}/events`;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${CDI_API_TOKEN}` },
        body: JSON.stringify(event),
      });
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        return { cancelRequested: data.cancel_requested === true };
      }
      if (res.status < 500) {
        console.error(`[${runId}] 事件上报被拒绝: HTTP ${res.status}`);
        return { cancelRequested: false };
      }
      console.error(`[${runId}] 事件上报失败: HTTP ${res.status}（第 ${attempt}/${MAX_ATTEMPTS} 次）`);
    } catch (err) {
      console.error(`[${runId}] 事件上报失败: ${err.message}（第 ${attempt}/${MAX_ATTEMPTS} 次）`);
    }
    if (attempt < MAX_ATTEMPTS) await new Promise((r) => setTimeout(r, 1000 * attempt));
  }
  return { cancelRequested: false };
}
