import { setDefaultResultOrder } from 'node:dns'

/**
 * 让 Node 在解析域名时优先返回 IPv4。
 *
 * 背景：Cloudflare 的 api.cloudflare.com 同时有 A / AAAA 记录；部分网络（尤其是
 * 国内宽带/校园网）IPv6 到 Cloudflare 不通，但 DNS 会先返回 AAAA。Node 的 undici
 * 连接超时后不会像浏览器那样自动回退到 IPv4，于是 /api/generate、/api/analyze-sketch
 * 这些上游请求会随机报 ConnectTimeoutError —— 表现就是“时好时坏”。
 *
 * 这里只调整本进程的 DNS 排序，不写死 IP、也不改全局代理；IPv4 不通时仍会拿到
 * IPv6 地址，只是排序靠后。浏览器侧不受影响。
 */
export default defineNitroPlugin(() => {
  setDefaultResultOrder('ipv4first')
})
