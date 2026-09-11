import { describe, expect, it } from 'vitest'
import { evaluateExecutionPermission, isSensitivePath, taskRoots } from './permissions.js'

const options = { roots: ['/workspace/repo'], cwd: '/workspace/repo' }
const bash = (command: string) => evaluateExecutionPermission('Bash', { command }, options)
const write = (file_path: string) => evaluateExecutionPermission('Write', { file_path }, options)
const edit = (input: Record<string, unknown>) => evaluateExecutionPermission('Edit', input, options)
const read = (file_path: string) => evaluateExecutionPermission('Read', { file_path }, options)

describe('execution permission (L1 / L2 / L3)', () => {
  it('allows in-worktree moves and single-file deletes', () => {
    expect(bash('mv a.ts src/b.ts').action).toBe('allow')
    expect(bash('rm build/out.txt').action).toBe('allow')
    expect(bash('git rm old/file.ts').action).toBe('allow')
  })

  it('blocks moves that reach outside the task worktree', () => {
    expect(bash('mv a.ts /tmp/b.ts').action).toBe('block')
    expect(bash('cp src/a.ts ~/desktop/x').action).toBe('block')
    expect(bash('rm -rf ../sibling').action).toBe('block')
  })

  it('blocks irreversible and privileged commands regardless of cwd', () => {
    expect(bash('rm -rf node_modules').action).toBe('block')
    expect(bash('git reset --hard HEAD~1').action).toBe('block')
    expect(bash('git push --force origin main').action).toBe('block')
    expect(bash('sudo npm i -g pnpm').action).toBe('block')
    expect(bash('docker system prune -f').action).toBe('block')
  })

  it('allows L3 network and dependency installs', () => {
    expect(bash('npm install').action).toBe('allow')
    expect(bash('pip install -r requirements.txt').action).toBe('allow')
    expect(bash('curl -sSL https://example.com/x.tgz -o /workspace/repo/x.tgz').action).toBe('allow')
  })

  it('allows L2 delivery commands without a prompt', () => {
    expect(bash('git commit -m msg').action).toBe('allow')
    expect(bash('git push origin feature/x').action).toBe('allow')
    expect(evaluateExecutionPermission('mcp__gitlab__create_merge_request', { title: 'x' }, options).action).toBe(
      'allow'
    )
  })

  it('blocks credential paths but keeps env templates writable', () => {
    expect(bash('cat ~/.ssh/id_rsa').action).toBe('block')
    expect(bash('echo key >> .env').action).toBe('block')
    expect(bash('echo key > .env.example').action).toBe('allow')
    expect(read('../../.ssh/id_rsa').action).toBe('block')
    expect(isSensitivePath('src/aws-utils.ts')).toBe(false)
    expect(isSensitivePath('.env.production')).toBe(true)
  })

  it('judges file tools by their path argument only', () => {
    expect(write('/workspace/repo/src/a.ts').action).toBe('allow')
    expect(write('/etc/hosts').action).toBe('block')
    expect(write('../outside.ts').action).toBe('block')
    // 正文里出现路径字样不应被当越界
    expect(
      edit({ file_path: '/workspace/repo/a.ts', old_string: "open('/etc/hosts')", new_string: "open('a.txt')" }).action
    ).toBe('allow')
  })

  it('skips the boundary check while a task has no repository', () => {
    const loose = { roots: [] as string[], cwd: '/workspace' }
    expect(evaluateExecutionPermission('Write', { file_path: '/tmp/x' }, loose).action).toBe('allow')
    expect(evaluateExecutionPermission('Bash', { command: 'sudo rm -rf /' }, loose).action).toBe('block')
  })

  it('prefers worktreePath over localPath when collecting roots', () => {
    expect(taskRoots([{ localPath: '/repo', worktreePath: '/wt/repo' }, { localPath: '/repo2' }])).toEqual([
      '/wt/repo',
      '/repo2'
    ])
  })
})
