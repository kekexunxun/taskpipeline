/**
 * 轻量级 web_fetch 工具 — 为 OpenAI driver 链路提供网页内容抓取能力。
 *
 * - 使用 Node.js 原生 fetch（Electron 环境内置）
 * - 使用 turndown 将 HTML 转为 markdown
 * - 内容超 50KB 自动截断并附提示
 *
 * 与 Qoder CLI 内置 WebFetch 的区别：
 * - 不支持 JS 渲染（无 Puppeteer）
 * - 不做 trafilatura 级去噪（turndown 基础转换）
 * - 适合文档页、博客等静态内容提取；复杂 SPA 仍应走 Qoder 链路
 */

import { tool as aiTool } from 'ai'
import { z } from 'zod'
import TurndownService from 'turndown'

/** 输出内容最大字符数，超出后截断。 */
const MAX_OUTPUT_CHARS = 50_000

/** fetch 超时（毫秒）。 */
const FETCH_TIMEOUT_MS = 30_000

/**
 * 创建 ai-sdk 格式的 web_fetch 工具。
 *
 * 输入：
 * - `url`（必填）：要抓取的网页地址
 * - `prompt`（可选）：提取意图描述，当前仅透传到输出供 LLM 参考
 *
 * 输出：markdown 格式的网页内容字符串
 */
export function createWebFetchAiTool() {
  return aiTool({
    description:
      'Fetch a web page and extract its main content as markdown. Use this to read documentation, blog posts, or any public web page. For JavaScript-rendered SPAs, the content may be incomplete — prefer the Qoder WebFetch tool for complex pages when available.',
    inputSchema: z.object({
      url: z.string().url().describe('The URL of the web page to fetch'),
      prompt: z.string().optional().describe('Optional: what specific information to extract from the page')
    }),
    execute: async ({ url, prompt }) => {
      try {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

        const response = await fetch(url, {
          signal: controller.signal,
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Qoder/1.0'
          },
          redirect: 'follow'
        })

        clearTimeout(timeout)

        if (!response.ok) {
          return `Error: HTTP ${response.status} ${response.statusText}`
        }

        const contentType = response.headers.get('content-type') ?? ''
        if (
          !contentType.includes('text/html') &&
          !contentType.includes('text/plain') &&
          !contentType.includes('application/xhtml')
        ) {
          return `Error: Unsupported content type "${contentType}". This tool only handles HTML pages.`
        }

        const html = await response.text()
        const markdown = htmlToMarkdown(html)

        let result = markdown
        let truncated = false
        if (result.length > MAX_OUTPUT_CHARS) {
          result = result.slice(0, MAX_OUTPUT_CHARS)
          truncated = true
        }

        const parts: string[] = []
        if (prompt) {
          parts.push(`Query: ${prompt}\n`)
        }
        parts.push(`Source: ${url}\n`)
        parts.push('---\n')
        parts.push(result)
        if (truncated) {
          parts.push('\n\n---\n[Content truncated due to length. The page content exceeded 50KB.]')
        }

        return parts.join('\n')
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          return `Error: Request timed out after ${FETCH_TIMEOUT_MS / 1000}s`
        }
        return `Error: ${error instanceof Error ? error.message : String(error)}`
      }
    }
  })
}

/**
 * 将 HTML 转为 markdown。
 *
 * 先尝试提取 <main> / <article> / [role="main"] 内的主体内容，
 * 找不到则对整个 body 做转换。
 */
function htmlToMarkdown(html: string): string {
  // 尝试提取主体内容，避免 nav/footer/sidebar 等噪音
  const bodyContent = extractMainContent(html)

  const turndown = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
    emDelimiter: '*'
  })

  // 去除 script / style / nav / footer / aside 等无关元素
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  turndown.remove(['script', 'style', 'nav', 'footer', 'aside', 'noscript', 'iframe'] as any)

  return turndown.turndown(bodyContent).trim()
}

/**
 * 从 HTML 中提取主体内容。
 *
 * 优先级：<main> > <article> > [role="main"] > <body>
 */
function extractMainContent(html: string): string {
  // 轻量正则提取，不引入完整 DOM 解析器
  const selectors = [
    /<main[^>]*>([\s\S]*?)<\/main>/i,
    /<article[^>]*>([\s\S]*?)<\/article>/i,
    /<div[^>]*role=["']main["'][^>]*>([\s\S]*?)<\/div>/i,
    /<body[^>]*>([\s\S]*?)<\/body>/i
  ]

  for (const pattern of selectors) {
    const match = html.match(pattern)
    if (match?.[1]?.trim()) {
      return match[1]
    }
  }

  return html
}
