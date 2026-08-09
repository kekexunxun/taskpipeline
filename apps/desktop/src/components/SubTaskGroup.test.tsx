import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import {
  aggregateSubTaskProgress,
  groupByParentTask,
  interleaveTimeline,
  spawnerToolUseIdOf,
  SubTaskGroup,
  SubTaskHeader,
  SubTaskProgressSummary,
  SubTaskResultBlock,
  subtaskMetaOf,
  subtaskStatusOf,
  ToolCallRow,
  toolInputSummary,
  type ParentedItem
} from './SubTaskGroup'

/** 构造一个测试用条目,字段尽量少,只保留分组需要的。 */
function item(partial: Partial<ParentedItem> & { id: string }): ParentedItem & { id: string } {
  const { id, ...rest } = partial
  return { id, ...rest }
}

describe('groupByParentTask', () => {
  it('主流程条目不分组,子任务按 parentTaskId 聚合,保持原顺序', () => {
    const list = [
      item({ id: '1' }), // main
      item({ id: '2', parentTaskId: 'sub-a', sdkSubtype: 'task_started', taskId: 'sub-a' }),
      item({ id: '3', parentTaskId: 'sub-a' }),
      item({ id: '4' }), // main
      item({ id: '5', parentTaskId: 'sub-a', sdkSubtype: 'task_notification' }),
      item({ id: '6', parentTaskId: 'sub-b', sdkSubtype: 'task_started', taskId: 'sub-b' }),
      item({ id: '7', parentTaskId: 'sub-b' })
    ]
    const { main, groups } = groupByParentTask(list)
    expect(main.map((e) => e.id)).toEqual(['1', '4'])
    expect(groups.map((g) => g.taskId)).toEqual(['sub-a', 'sub-b'])
    expect(groups[0]!.header?.id).toBe('2')
    expect(groups[0]!.children.map((c) => c.id)).toEqual(['3', '5'])
    expect(groups[1]!.header?.id).toBe('6')
    expect(groups[1]!.children.map((c) => c.id)).toEqual(['7'])
  })

  it('子任务里没有 task_started 时,header 留空,children 仍能展示', () => {
    const list = [item({ id: '1' }), item({ id: '2', parentTaskId: 'sub-orphan' })]
    const { main, groups } = groupByParentTask(list)
    expect(main.map((e) => e.id)).toEqual(['1'])
    expect(groups).toHaveLength(1)
    expect(groups[0]!.header).toBeUndefined()
    expect(groups[0]!.children.map((c) => c.id)).toEqual(['2'])
  })

  it('空输入返回空分组', () => {
    expect(groupByParentTask([])).toEqual({ main: [], groups: [] })
  })
})

describe('interleaveTimeline', () => {
  /**
   * Timeline 渲染顺序:子任务 group 卡出现在它实际发生的时间点附近,而不是堆在所有 main 之后。
   * 这条测试保护:
   *   - group header 与 children 按时间穿插
   *   - 同 group 内的子条目合并
   *   - 不同 group 切换时不串
   *   - group 之后的主流程消息能继续渲染
   */
  it('按时间顺序穿插:子任务 group 出现在它实际发生的时间点附近,后续主流程消息继续渲染', () => {
    const list = [
      item({ id: '1' }), // main: 主流程分析
      item({ id: '2', parentTaskId: 'sub-a', sdkSubtype: 'task_started', taskId: 'sub-a' }),
      item({ id: '3', parentTaskId: 'sub-a' }),
      item({ id: '4' }), // main: 主流程的下一条 message
      item({ id: '5', parentTaskId: 'sub-a', sdkSubtype: 'task_notification' }),
      item({ id: '6', parentTaskId: 'sub-b', sdkSubtype: 'task_started', taskId: 'sub-b' }),
      item({ id: '7', parentTaskId: 'sub-b' }),
      item({ id: '8' }) // main: 收尾
    ]
    const blocks = interleaveTimeline(list)
    // 期望顺序:1=main, 2..5=group sub-a, 4=main, 6..7=group sub-b, 8=main
    // (注意 id=4 在 group sub-a 之后才出现)
    const dump = blocks.map((b) =>
      b.kind === 'main'
        ? `main:${b.item.id}`
        : `group:${b.taskId}[${b.header?.id ?? '?'}+${b.children.map((c) => c.id).join(',')}]`
    )
    expect(dump).toEqual([
      'main:1',
      'group:sub-a[2+3,5]', // task_started 是 header,task_notification + 其它进 children
      'main:4',
      'group:sub-b[6+7]',
      'main:8'
    ])
  })

  it('header 重复出现时,第一个为准,后续归入 children', () => {
    const list = [
      item({ id: '1', parentTaskId: 'sub-a', sdkSubtype: 'task_started', taskId: 'sub-a' }),
      item({ id: '2', parentTaskId: 'sub-a' }),
      // 异常:又来一条 task_started
      item({ id: '3', parentTaskId: 'sub-a', sdkSubtype: 'task_started', taskId: 'sub-a' })
    ]
    const blocks = interleaveTimeline(list)
    expect(blocks).toHaveLength(1)
    const group = blocks[0]!.kind === 'group' ? blocks[0] : undefined
    expect(group?.header?.id).toBe('1')
    expect(group?.children.map((c) => c.id)).toEqual(['2', '3'])
  })

  it('子任务孤儿条目降级:只有 children 没有 header 也能成组', () => {
    const list = [item({ id: '1' }), item({ id: '2', parentTaskId: 'sub-orphan' })]
    const blocks = interleaveTimeline(list)
    expect(blocks).toHaveLength(2)
    expect(blocks[0]?.kind).toBe('main')
    expect(blocks[1]?.kind).toBe('group')
    if (blocks[1]?.kind === 'group') {
      expect(blocks[1].header).toBeUndefined()
      expect(blocks[1].children.map((c) => c.id)).toEqual(['2'])
    }
  })

  it('空输入返回空数组', () => {
    expect(interleaveTimeline([])).toEqual([])
  })
})

describe('subtaskMetaOf', () => {
  it('新数据:从 payload 提取 parentTaskId / sdkSubtype / taskType / subagentType / toolUseId 等', () => {
    const meta = subtaskMetaOf({
      title: 'Qoder 子任务启动',
      payload: {
        subtaskId: 'sub-1',
        sdkSubtype: 'task_started',
        taskType: 'local_agent',
        subagentType: 'Explore',
        toolUseId: 'call_1',
        description: '查代码'
      }
    })
    expect(meta).toMatchObject({
      parentTaskId: 'sub-1',
      subtaskId: 'sub-1',
      sdkSubtype: 'task_started',
      taskType: 'local_agent',
      subagentType: 'Explore',
      toolUseId: 'call_1',
      description: '查代码'
    })
  })

  it('历史兑底:title=Qoder task_* 且 payload 空时,从 detail JSON 反解全部元信息', () => {
    const started = subtaskMetaOf({
      title: 'Qoder task_started',
      detail: JSON.stringify({
        subtype: 'task_started',
        task_id: 'sub-h',
        tool_use_id: 'call_h',
        task_type: 'local_agent',
        subagent_type: 'Explore',
        description: '查找发票推送相关代码'
      })
    })
    expect(started).toMatchObject({
      parentTaskId: 'sub-h',
      sdkSubtype: 'task_started',
      taskType: 'local_agent',
      subagentType: 'Explore',
      toolUseId: 'call_h',
      description: '查找发票推送相关代码'
    })
    // task_notification:status 是整体状态的来源
    const notification = subtaskMetaOf({
      title: 'Qoder task_notification',
      detail: JSON.stringify({ subtype: 'task_notification', task_id: 'sub-h', status: 'failed', summary: 'x' })
    })
    expect(notification.sdkSubtype).toBe('task_notification')
    expect(notification.status).toBe('failed')
    // task_progress:lastToolName / description 进聚合样本
    const progress = subtaskMetaOf({
      title: 'Qoder task_progress',
      detail: JSON.stringify({
        subtype: 'task_progress',
        task_id: 'sub-h',
        last_tool_name: 'Glob',
        description: '扫文件'
      })
    })
    expect(progress.lastToolName).toBe('Glob')
    expect(progress.description).toBe('扫文件')
  })

  it('历史兑底不误伤:payload 已有归属 / title 非 Qoder task_* 前缀时不走 detail 反解', () => {
    // payload 有值 → 不看 title / detail
    const withPayload = subtaskMetaOf({
      title: 'Qoder task_started',
      detail: 'not json',
      payload: { subtaskId: 'sub-p', sdkSubtype: 'task_started' }
    })
    expect(withPayload.parentTaskId).toBe('sub-p')
    // 非 task_* 的 Qoder 状态(如「Qoder Agent 错误」)不反解
    const other = subtaskMetaOf({ title: 'Qoder Agent 错误', detail: JSON.stringify({ task_id: 'sub-x' }) })
    expect(other.parentTaskId).toBeUndefined()
    expect(other.sdkSubtype).toBeUndefined()
  })
})

describe('subtaskStatusOf', () => {
  it('从 payload.status 提取 completed / failed / stopped', () => {
    expect(subtaskStatusOf({ payload: { status: 'completed' } })).toBe('completed')
    expect(subtaskStatusOf({ payload: { status: 'failed' } })).toBe('failed')
    expect(subtaskStatusOf({ payload: { status: 'stopped' } })).toBe('stopped')
  })

  it('调用方传 task_started(还没收到收尾)时, 视为 running', () => {
    // 调用方在子任务还没收到 task_notification 时,header 是 task_started 本身
    // (entry 存在但 payload 没有 status 字段)——按 running 处理,UI 显示"执行中"徽章。
    expect(subtaskStatusOf({ payload: { foo: 'bar' } })).toBe('running')
  })

  it('传 undefined 时 = unknown(纯头尾缺失场景)', () => {
    expect(subtaskStatusOf(undefined)).toBe('unknown')
  })
})

/**
 * SubTaskGroup 视觉与 TimelineEntryBody 对齐:左 task 图标 + 右上 trigger 行
 * (chevron + Task 名称 + 状态徽章 + time) + 下方折叠内容。
 */
describe('SubTaskGroup 视觉', () => {
  it('trigger 行显示 Task 名称 + createdAt 时间 + 状态徽章,默认折叠', () => {
    const { container } = render(
      <SubTaskGroup
        taskId="sub-1"
        createdAt="2026-08-01T12:38:00.000Z"
        header={<SubTaskHeader description="查找发票推送相关代码" taskType="local_agent" status="completed" />}
      >
        <div data-testid="child">子条目</div>
      </SubTaskGroup>
    )
    // trigger 显示 Task 名称
    expect(screen.getByText('查找发票推送相关代码')).toBeInTheDocument()
    // 类型徽章
    expect(screen.getByText('local_agent')).toBeInTheDocument()
    // 状态徽章
    expect(screen.getByText('已完成')).toBeInTheDocument()
    // 时间(只要 <time> 元素存在即可,locale 决定具体输出)
    expect(container.querySelector('time')).not.toBeNull()
    // 默认折叠:children 不可见
    expect(screen.queryByTestId('child')).not.toBeInTheDocument()
  })

  it('不传 createdAt 时 trigger 行不显示 time 元素', () => {
    const { container } = render(
      <SubTaskGroup taskId="sub-1" header={<SubTaskHeader description="查找发票推送相关代码" status="running" />}>
        <div data-testid="child">子条目</div>
      </SubTaskGroup>
    )
    expect(container.querySelector('time')).toBeNull()
  })
})

describe('toolInputSummary', () => {
  it('按优先级提取内联摘要:description > file_path > pattern > command', () => {
    expect(toolInputSummary({ description: '列出文件', command: 'ls' })).toBe('列出文件')
    // file_path 会被压缩为末段文件名,避免内联行被省略号截掉关键信息
    expect(toolInputSummary({ file_path: '/tmp/a.ts', limit: 80 })).toBe('a.ts')
    expect(toolInputSummary({ pattern: '**/*.ts' })).toBe('**/*.ts')
    expect(toolInputSummary({ command: 'ls -la' })).toBe('ls -la')
  })

  it('file_path / path 只保留末段文件名,同时识别 Unix / 与 Windows \\ 分隔符', () => {
    expect(
      toolInputSummary({
        file_path: '/Users/robin/Library/Application Support/@task-pipeline/desktop/data/workspaces/x/src/api/index.ts'
      })
    ).toBe('index.ts')
    expect(toolInputSummary({ path: 'src/api/index.ts' })).toBe('index.ts')
    expect(toolInputSummary({ path: 'C:\\Users\\foo\\bar.ts' })).toBe('bar.ts')
    // 已经是纯文件名时不再加工
    expect(toolInputSummary({ file_path: 'single.ts' })).toBe('single.ts')
  })

  it('不命中优先键时 JSON 截断;空输入返回 undefined', () => {
    expect(toolInputSummary({ foo: 'bar' })).toBe('{"foo":"bar"}')
    expect(toolInputSummary(undefined)).toBeUndefined()
    expect(toolInputSummary(null)).toBeUndefined()
    expect(toolInputSummary('')).toBeUndefined()
  })

  it('字符串输入单行化并截断', () => {
    expect(toolInputSummary('hello')).toBe('hello')
    const long = 'x'.repeat(120)
    expect(toolInputSummary(long)).toHaveLength(81) // 80 + 省略号
  })
})

describe('aggregateSubTaskProgress', () => {
  it('聚合多条 progress:次数 / 最后工具 / 最新描述 / usage 求和', () => {
    const agg = aggregateSubTaskProgress([
      { lastToolName: 'Read', description: '读文件', usage: { total_tokens: 10, tool_uses: 1, duration_ms: 100 } },
      { lastToolName: 'Grep', description: '搜代码', usage: { total_tokens: 20, tool_uses: 2, duration_ms: 200 } }
    ])
    expect(agg.progressCount).toBe(2)
    expect(agg.lastToolName).toBe('Grep')
    expect(agg.latestDescription).toBe('搜代码')
    expect(agg.totalTokens).toBe(30)
    expect(agg.totalToolUses).toBe(3)
    expect(agg.totalDurationMs).toBe(300)
  })

  it('空样本返回 progressCount=0', () => {
    expect(aggregateSubTaskProgress([]).progressCount).toBe(0)
  })
})

describe('SubTaskProgressSummary', () => {
  it('渲染聚合统计行', () => {
    render(
      <SubTaskProgressSummary
        aggregate={aggregateSubTaskProgress([{ lastToolName: 'Read', usage: { total_tokens: 12, tool_uses: 1 } }])}
      />
    )
    expect(screen.getByText('过程态 1 次')).toBeInTheDocument()
    expect(screen.getByText('最后工具: Read')).toBeInTheDocument()
  })

  it('running 时附最新描述作为当前活动', () => {
    render(<SubTaskProgressSummary running aggregate={aggregateSubTaskProgress([{ description: '正在扫描 src' }])} />)
    expect(screen.getByText('正在扫描 src')).toBeInTheDocument()
  })

  it('非 running 且无样本时不渲染', () => {
    const { container } = render(<SubTaskProgressSummary aggregate={aggregateSubTaskProgress([])} />)
    expect(container).toBeEmptyDOMElement()
  })
})

describe('spawnerToolUseIdOf', () => {
  it('识别直挂 part.toolUseId 与嵌套 payload.toolUseId 两种形态', () => {
    expect(spawnerToolUseIdOf({ toolUseId: 'toolu_1' })).toBe('toolu_1')
    expect(spawnerToolUseIdOf({ payload: { toolUseId: 'toolu_2' } })).toBe('toolu_2')
    expect(spawnerToolUseIdOf({})).toBeUndefined()
    expect(spawnerToolUseIdOf(undefined)).toBeUndefined()
    expect(spawnerToolUseIdOf({ payload: {} })).toBeUndefined()
  })
})

describe('ToolCallRow', () => {
  it('单行展示:工具名粗体 + 内联摘要,默认折叠,点击展开输入/输出', () => {
    render(
      <ToolCallRow
        name="Read"
        summary="/tmp/a.ts"
        input={{ file_path: '/tmp/a.ts' }}
        output="file content"
        status="done"
        createdAt="2026-08-01T12:00:00.000Z"
      />
    )
    expect(screen.getByText('Tools - Read')).toBeInTheDocument()
    expect(screen.getByText('/tmp/a.ts')).toBeInTheDocument()
    // 默认折叠:输入/输出段不可见
    expect(screen.queryByText('输入')).not.toBeInTheDocument()
    expect(screen.queryByText('file content')).not.toBeInTheDocument()
    // 点击行展开
    fireEvent.click(screen.getByRole('button', { name: /Read/ }))
    expect(screen.getByText('输入')).toBeInTheDocument()
    expect(screen.getByText('输出')).toBeInTheDocument()
    expect(screen.getByText(/file_path/)).toBeInTheDocument()
    expect(screen.getByText('file content')).toBeInTheDocument()
  })

  it('error 状态:输出段标签变为「失败」', () => {
    render(<ToolCallRow name="Bash" output="denied" status="error" />)
    fireEvent.click(screen.getByRole('button', { name: /Bash/ }))
    expect(screen.getByText('失败')).toBeInTheDocument()
    expect(screen.getByText('denied')).toBeInTheDocument()
  })

  it('无输入输出时退化为纯展示行(不可点击)', () => {
    render(<ToolCallRow name="Read" summary="/tmp/a.ts" status="done" />)
    expect(screen.getByText('Tools - Read')).toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('输出为 Anthropic content 块数组时提取 text 拼接(不展示原始 JSON)', () => {
    render(
      <ToolCallRow
        name="Grep"
        output={[
          { type: 'text', text: 'index.ts:1:foo' },
          { type: 'text', text: 'main.ts:2:foo' }
        ]}
        status="done"
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /Grep/ }))
    expect(screen.getByText(/index\.ts:1:foo/)).toBeInTheDocument()
    expect(screen.getByText(/main\.ts:2:foo/)).toBeInTheDocument()
    expect(screen.queryByText(/"type":"text"/)).not.toBeInTheDocument()
  })
})

describe('SubTaskResultBlock', () => {
  it('渲染收尾 summary + 输出段', () => {
    render(<SubTaskResultBlock summary="找到 3 个文件" output="full output" />)
    expect(screen.getByText('找到 3 个文件')).toBeInTheDocument()
    expect(screen.getByText('输出')).toBeInTheDocument()
    expect(screen.getByText('full output')).toBeInTheDocument()
  })

  it('summary 与 output 都缺失时不渲染', () => {
    const { container } = render(<SubTaskResultBlock />)
    expect(container).toBeEmptyDOMElement()
  })
})
