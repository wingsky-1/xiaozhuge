/**
 * 客户端 fetch 超时封装（ADR 0021；对齐 dsh-plugin-hub #287 / mcp-manager #111）。
 *
 * 两层超时分工（勿混淆）：
 * - 宿主端 handler 内取数：管「服务端 → 远端/文件」，与浏览器无关；
 * - 本封装（默认 10s）：管「浏览器 → dsh web」这一跳——移动端切后台 TCP 被
 *   静默掐断形成半开连接时，死连接上的请求可能挂到 TCP 重传超时（可达 15
 *   分钟），占满浏览器同源连接池致其余请求全部 pending。10s 兜底保证有界等待。
 *
 * init.signal 存在时不注入兜底信号（调用方信号优先，避免双取消竞争；
 * 与 mcp-manager api() #111 同款语义）。timeoutMs 仅供测试注入，生产走默认。
 */
export const CLIENT_FETCH_TIMEOUT_MS = 10_000;

/**
 * 兼容兜底：AbortSignal.timeout 为 Chrome 103+/Firefox 100+/Safari 15.4+
 * （iOS 15.4+）。更旧环境回退 setTimeout + AbortController，且 timer 随请求
 * 结束清理（防泄漏）。
 */
function withTimeoutAbort(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException("signal timed out", "TimeoutError")), timeoutMs);
  return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
}

export function fetchTimeout(
  url: string,
  init?: RequestInit,
  timeoutMs: number = CLIENT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  if (init?.signal !== undefined) return fetch(url, init);
  if (typeof AbortSignal.timeout === "function") {
    return fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  }
  return withTimeoutAbort(url, init ?? {}, timeoutMs);
}
