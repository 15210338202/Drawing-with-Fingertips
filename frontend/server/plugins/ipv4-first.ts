/**
 * 让本地 Node 在解析域名时优先返回 IPv4。
 *
 * 背景：Cloudflare 的 api.cloudflare.com 同时有 A / AAAA 记录；部分网络（尤其是
 * 国内宽带/校园网）IPv6 到 Cloudflare 不通，但 DNS 会先返回 AAAA。Node 的 undici
 * 连接超时后不会像浏览器那样自动回退到 IPv4，于是 /api/generate、/api/analyze-sketch
 * 这些上游请求会随机报 ConnectTimeoutError —— 表现就是“时好时坏”。
 *
 * 注意：Cloudflare Workers/Pages 运行时没有 `node:dns`，所以这里用动态 import，
 * 并且只在非 Cloudflare 环境执行；否则构建产物里会留下不支持的顶层 import。
 */
export default defineNitroPlugin(async () => {
  if (process.env.CF_PAGES || process.env.CLOUDFLARE_WORKERS) return

  try {
    const { setDefaultResultOrder } = await import('node:dns')
    setDefaultResultOrder('ipv4first')
  }
  catch {
    // 非 Node 环境或该 API 不可用时静默跳过，不影响业务请求。
  }
})
