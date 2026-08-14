import { describe, expect, it } from 'vitest'
import { describeToolAction, isBuiltinWriteTool, isDangerousTool, isWriteTool } from './dangerous-tools.js'

describe('isDangerousTool（工具调用 HITL 规则：仅删除类确认）', () => {
  it('Bash 只读命令自动放行', () => {
    expect(isDangerousTool('Bash', { command: 'ls -la' })).toBe(false)
    expect(isDangerousTool('Bash', { command: 'cat package.json' })).toBe(false)
    expect(isDangerousTool('Bash', { command: 'git status' })).toBe(false)
    expect(isDangerousTool('Bash', { command: 'git diff --stat' })).toBe(false)
    expect(isDangerousTool('Bash', { command: 'grep -r foo src' })).toBe(false)
  })

  it('Bash 破坏性命令（rm/mv/rmdir/unlink/git rm/find -delete）需要确认', () => {
    expect(isDangerousTool('Bash', { command: 'rm -rf node_modules' })).toBe(true)
    expect(isDangerousTool('Bash', { command: 'rm file.txt' })).toBe(true)
    expect(isDangerousTool('Bash', { command: 'mv a.ts b.ts' })).toBe(true)
    expect(isDangerousTool('Bash', { command: 'rmdir dist' })).toBe(true)
    expect(isDangerousTool('Bash', { command: 'unlink /tmp/a' })).toBe(true)
    expect(isDangerousTool('Bash', { command: 'git rm old.ts' })).toBe(true)
    expect(isDangerousTool('Bash', { command: 'cd src && rm -rf build' })).toBe(true)
  })

  it('Bash 删除命令带前缀/包裹时不绕过确认', () => {
    expect(isDangerousTool('Bash', { command: 'sudo rm -rf /' })).toBe(true)
    expect(isDangerousTool('Bash', { command: 'cd x && sudo rm -rf y' })).toBe(true)
    expect(isDangerousTool('Bash', { command: 'xargs rm -rf x' })).toBe(true)
    expect(isDangerousTool('Bash', { command: "sh -c 'rm -rf x'" })).toBe(true)
    expect(isDangerousTool('Bash', { command: 'find . -delete' })).toBe(true)
    expect(isDangerousTool('Bash', { command: 'git rm -r old/' })).toBe(true)
    // 多行命令第二行的删除
    expect(isDangerousTool('Bash', { command: 'npm run build\nrm -rf dist' })).toBe(true)
  })

  it('Bash 写命令默认放行（常规可行，不频繁打断）', () => {
    expect(isDangerousTool('Bash', { command: 'npm install' })).toBe(false)
    expect(isDangerousTool('Bash', { command: 'git push origin main' })).toBe(false)
    expect(isDangerousTool('Bash', { command: 'git checkout -f main' })).toBe(false)
    expect(isDangerousTool('Bash', { command: 'echo hi > file.txt' })).toBe(false)
    expect(isDangerousTool('Bash', { command: 'python build.py' })).toBe(false)
    // --rm 是 docker 等命令的 flag，不是删除操作，不应拦截
    expect(isDangerousTool('Bash', { command: 'docker run --rm -it node:20 bash' })).toBe(false)
  })

  it('Bash 无法解析命令文本时默认放行（不打断执行）', () => {
    expect(isDangerousTool('Bash', {})).toBe(false)
    expect(isDangerousTool('Bash', undefined)).toBe(false)
  })

  it('Git 工具（含写操作）默认放行', () => {
    expect(isDangerousTool('Git', { command: 'status' })).toBe(false)
    expect(isDangerousTool('Git', { command: 'push' })).toBe(false)
    expect(isDangerousTool('Git', { command: 'reset --hard HEAD' })).toBe(false)
    expect(isDangerousTool('GitPush', { branch: 'main' })).toBe(false)
    expect(isDangerousTool('GitCommit', { message: 'x' })).toBe(false)
  })

  it('删除 / 重命名 / 移动类工具确认', () => {
    expect(isDangerousTool('DeleteFile', { path: '/tmp/a.ts' })).toBe(true)
    expect(isDangerousTool('RemoveFile', { path: '/tmp/a.ts' })).toBe(true)
    expect(isDangerousTool('Unlink', { path: '/tmp/a.ts' })).toBe(true)
    expect(isDangerousTool('Rename', { from: '/tmp/a.ts', to: '/tmp/b.ts' })).toBe(true)
    expect(isDangerousTool('Move', { path: '/tmp/a.ts' })).toBe(true)
    expect(isDangerousTool('MoveFile', { path: '/tmp/a.ts' })).toBe(true)
    expect(isDangerousTool('MoveFileTo', { path: '/tmp/a.ts' })).toBe(true)
    expect(isDangerousTool('Rmdir', { path: '/tmp/dist' })).toBe(true)
  })

  it('普通编辑 / 只读工具自动放行（不打断 agent 节奏）', () => {
    expect(isDangerousTool('Write', { file_path: '/tmp/a.ts', content: 'x' })).toBe(false)
    expect(isDangerousTool('Edit', { file_path: '/tmp/a.ts' })).toBe(false)
    expect(isDangerousTool('Read', { file_path: '/tmp/a.ts' })).toBe(false)
    expect(isDangerousTool('Glob', { pattern: '**/*.ts' })).toBe(false)
    expect(isDangerousTool('Grep', { pattern: 'foo' })).toBe(false)
    expect(isDangerousTool('WebFetch', { url: 'https://example.com' })).toBe(false)
  })
})

describe('isBuiltinWriteTool（对话板块内置写工具判定：Bash/Edit/Write 一律确认）', () => {
  it('写类内置工具命中（大小写不敏感）', () => {
    expect(isBuiltinWriteTool('Bash')).toBe(true)
    expect(isBuiltinWriteTool('Edit')).toBe(true)
    expect(isBuiltinWriteTool('Write')).toBe(true)
    expect(isBuiltinWriteTool('NotebookEdit')).toBe(true)
    expect(isBuiltinWriteTool('bash')).toBe(true)
    expect(isBuiltinWriteTool('write')).toBe(true)
  })

  it('只读 / 低风险内置工具不命中', () => {
    expect(isBuiltinWriteTool('Read')).toBe(false)
    expect(isBuiltinWriteTool('Glob')).toBe(false)
    expect(isBuiltinWriteTool('Grep')).toBe(false)
    expect(isBuiltinWriteTool('WebFetch')).toBe(false)
    expect(isBuiltinWriteTool('WebSearch')).toBe(false)
    expect(isBuiltinWriteTool('Agent')).toBe(false)
    expect(isBuiltinWriteTool('AskUserQuestion')).toBe(false)
    expect(isBuiltinWriteTool('TodoWrite')).toBe(false)
    expect(isBuiltinWriteTool('Skill')).toBe(false)
  })

  it('MCP 工具名不命中（走 isWriteTool 规则）', () => {
    expect(isBuiltinWriteTool('mcp__jira__create_issue')).toBe(false)
  })
})

describe('isWriteTool（MCP 工具写操作判定：仅写操作弹窗）', () => {
  it('写动词工具名需要确认', () => {
    expect(isWriteTool('mcp__jira__create_issue')).toBe(true)
    expect(isWriteTool('mcp__jira__update_issue')).toBe(true)
    expect(isWriteTool('mcp__jira__delete_issue')).toBe(true)
    expect(isWriteTool('mcp__jira__add_comment')).toBe(true)
    expect(isWriteTool('mcp__jira__transition_issue')).toBe(true)
    expect(isWriteTool('mcp__gitlab__create_merge_request')).toBe(true)
    expect(isWriteTool('mcp__confluence__update_page')).toBe(true)
    expect(isWriteTool('mcp__gitlab__move_issue')).toBe(true)
  })

  it('读动词工具名直接放行', () => {
    expect(isWriteTool('mcp__jira__get_issue')).toBe(false)
    expect(isWriteTool('mcp__jira__search_issues')).toBe(false)
    expect(isWriteTool('mcp__jira__list_projects')).toBe(false)
    expect(isWriteTool('mcp__gitlab__get_project')).toBe(false)
    expect(isWriteTool('mcp__confluence__get_page')).toBe(false)
    expect(isWriteTool('mcp__confluence__search_pages')).toBe(false)
    expect(isWriteTool('mcp__gitlab__list_merge_requests')).toBe(false)
    expect(isWriteTool('mcp__jira__get_issue_comments')).toBe(false)
    expect(isWriteTool('mcp__jira__jira_get_issue_metadata')).toBe(false)
  })

  it('无读动词(写动词或特征不明)保守弹窗（不确定时宁可确认）', () => {
    expect(isWriteTool('mcp__jira__create_issue')).toBe(true)
    expect(isWriteTool('mcp__gitlab__custom_action')).toBe(true)
    expect(isWriteTool('mcp__jira__some_tool')).toBe(true)
  })
})

describe('describeToolAction', () => {
  it('优先输出命令文本', () => {
    expect(describeToolAction('Bash', { command: 'rm -rf build' })).toBe('Bash: rm -rf build')
  })
  it('无命令时输出 JSON', () => {
    expect(describeToolAction('DeleteFile', { path: '/tmp/a.ts' })).toContain('/tmp/a.ts')
  })
})
