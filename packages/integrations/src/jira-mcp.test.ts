import { describe, expect, it, vi } from 'vitest'
import { testAtlassianConnection, testAtlassianConnectionRest } from './jira-mcp.js'
import type { McpClient } from './mcp.js'

/** 构造只含 listTools / callTool / close 的 McpClient 桩。 */
function stubClient(
  toolResult: unknown,
  options?: { tools?: unknown[]; throwOnCall?: Error; closed?: { value: boolean } }
): McpClient {
  const client = {
    listTools: async () => options?.tools ?? [{ name: 'jira_get_issue' }, { name: 'confluence_get_page' }],
    callTool: async () => {
      if (options?.throwOnCall) throw options.throwOnCall
      return toolResult
    },
    close: () => {
      if (options?.closed) options.closed.value = true
    }
  }
  return client as unknown as McpClient
}

describe('testAtlassianConnection', () => {
  it('fails when the probe returns error text without isError flag (expired token)', async () => {
    const closed = { value: false }
    const client = stubClient(
      {
        content: [
          {
            type: 'text',
            text: "Error calling tool 'get_issue': Authentication failed for Jira API (401). Token may be expired or invalid."
          }
        ]
      },
      { closed }
    )
    const result = await testAtlassianConnection(client, 'jira')
    expect(result.ok).toBe(false)
    expect(result.message).toContain('Token 已失效或过期')
    expect(closed.value).toBe(true)
  })

  it('fails when the probe payload lacks the expected issues shape', async () => {
    const client = stubClient({ content: [{ type: 'text', text: 'Something unexpected happened' }] })
    const result = await testAtlassianConnection(client, 'jira')
    expect(result.ok).toBe(false)
    expect(result.message).toContain('Something unexpected happened')
  })

  it('fails when isError is set', async () => {
    const client = stubClient({
      isError: true,
      content: [{ type: 'text', text: '403 Forbidden: token expired' }]
    })
    const result = await testAtlassianConnection(client, 'jira')
    expect(result.ok).toBe(false)
    expect(result.message).toContain('Token 已失效或过期')
  })

  it('passes when the probe hits 404 (credentials accepted, object absent)', async () => {
    const client = stubClient({
      content: [{ type: 'text', text: "Error calling tool 'get_issue': Jira API returned 404. Issue Does Not Exist." }]
    })
    const result = await testAtlassianConnection(client, 'jira')
    expect(result.ok).toBe(true)
  })

  it('passes when jira_get_issue returns an issue shape', async () => {
    const client = stubClient({
      content: [{ type: 'text', text: JSON.stringify({ key: 'PROBE-0', fields: { summary: 'x' } }) }]
    })
    const result = await testAtlassianConnection(client, 'jira')
    expect(result.ok).toBe(true)
    expect(result.message).toContain('jira_get_issue')
  })

  it('passes when confluence_get_page returns a page shape', async () => {
    const client = stubClient({
      content: [{ type: 'text', text: JSON.stringify({ id: '0', title: 'probe' }) }]
    })
    const result = await testAtlassianConnection(client, 'confluence')
    expect(result.ok).toBe(true)
  })

  it('falls back to handshake result without kind', async () => {
    const client = stubClient({ content: [] })
    const result = await testAtlassianConnection(client)
    expect(result.ok).toBe(true)
    expect(result.message).toContain('可用工具')
  })

  it('reports auth-flavored thrown errors as token failure', async () => {
    const client = stubClient(undefined, { throwOnCall: new Error('HTTP 401 Unauthorized') })
    const result = await testAtlassianConnection(client, 'jira')
    expect(result.ok).toBe(false)
    expect(result.message).toContain('Token 已失效或过期')
  })
})

describe('testAtlassianConnectionRest', () => {
  const config = { url: 'https://example.atlassian.net', email: 'dev@example.com', token: 'tok' }

  function stubFetch(status: number) {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ accountId: 'x' }), { status }))
    vi.stubGlobal('fetch', fetchMock)
    return {
      firstCall: (): [string, { headers: Record<string, string> }] =>
        (fetchMock.mock.calls[0] ?? []) as unknown as [string, { headers: Record<string, string> }]
    }
  }

  it('passes on 200 and hits /rest/api/2/myself with basic auth', async () => {
    const fetchStub = stubFetch(200)
    const result = await testAtlassianConnectionRest('jira', config)
    expect(result.ok).toBe(true)
    const [url, init] = fetchStub.firstCall()
    expect(url).toBe('https://example.atlassian.net/rest/api/2/myself')
    expect(init.headers.Authorization).toBe(`Basic ${Buffer.from('dev@example.com:tok').toString('base64')}`)
    vi.unstubAllGlobals()
  })

  it('fails on 401 with expired-token message', async () => {
    stubFetch(401)
    const result = await testAtlassianConnectionRest('jira', config)
    expect(result.ok).toBe(false)
    expect(result.message).toContain('Token 无效或已过期')
    vi.unstubAllGlobals()
  })

  it('uses bearer auth and /wiki prefix for confluence cloud without email', async () => {
    const fetchStub = stubFetch(200)
    const result = await testAtlassianConnectionRest('confluence', {
      url: 'https://example.atlassian.net',
      token: 'tok'
    })
    expect(result.ok).toBe(true)
    const [url, init] = fetchStub.firstCall()
    expect(url).toBe('https://example.atlassian.net/wiki/rest/api/user/current')
    expect(init.headers.Authorization).toBe('Bearer tok')
    vi.unstubAllGlobals()
  })

  it('keeps server/dc confluence url without /wiki', async () => {
    const fetchStub = stubFetch(200)
    const result = await testAtlassianConnectionRest('confluence', {
      url: 'https://confluence.example.com',
      token: 'tok'
    })
    expect(result.ok).toBe(true)
    expect(fetchStub.firstCall()[0]).toBe('https://confluence.example.com/rest/api/user/current')
    vi.unstubAllGlobals()
  })

  it('reports network errors as failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('getaddrinfo ENOTFOUND example.atlassian.net')
      })
    )
    const result = await testAtlassianConnectionRest('jira', config)
    expect(result.ok).toBe(false)
    expect(result.message).toContain('ENOTFOUND')
    vi.unstubAllGlobals()
  })
})
