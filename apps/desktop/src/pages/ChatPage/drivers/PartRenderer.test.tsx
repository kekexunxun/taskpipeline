import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { PartRenderer } from './PartRenderer'

/**
 * Radix Collapsible 的 trigger 上会带 `data-state="open" | "closed"`,
 * 用它来观察折叠态最稳 —— accessible name 拼出"子任务 + taskType + description + 状态"，
 * 单一文本特征不稳定。
 */
function getSubtaskTrigger(taskId: string): HTMLElement {
  return document.querySelector<HTMLElement>(`[data-subtask-id="${taskId}"]`)!
}

describe('PartRenderer', () => {
  it('renders main text parts in the main flow without wrapping them in a SubTaskGroup', () => {
    render(<PartRenderer parts={[{ driverId: 'qoder', type: 'text', text: '主流程文本' }]} />)
    expect(screen.getByText('主流程文本')).toBeInTheDocument()
    // 没有任何 SubTaskGroup trigger
    expect(document.querySelector('[data-subtask-id]')).toBeNull()
  })

  it('keeps qoder.session in the main flow (元信息,不属于任何子任务)', () => {
    render(<PartRenderer parts={[{ driverId: 'qoder', type: 'qoder.session', sessionId: 'sess-abcdef123456' }]} />)
    expect(screen.getByText(/sess-abcdef/)).toBeInTheDocument()
    expect(document.querySelector('[data-subtask-id]')).toBeNull()
  })

  it('merges consecutive text parts into a single block (正文不再分块)', () => {
    render(
      <PartRenderer
        parts={[
          { driverId: 'qoder', type: 'text', text: '第一段内容' },
          { driverId: 'qoder', type: 'text', text: '，第二段内容' },
          { driverId: 'qoder', type: 'text', text: '。第三段内容' }
        ]}
      />
    )
    // 流式 text_delta 拆成的多个 part 必须合并为完整正文,不能渲染成多个分块。
    expect(screen.getByText('第一段内容，第二段内容。第三段内容')).toBeInTheDocument()
    expect(screen.getAllByText(/内容/).length).toBe(1)
  })

  it('merges consecutive qoder.thinking parts into a single collapsible block', () => {
    render(
      <PartRenderer
        parts={[
          { driverId: 'qoder', type: 'qoder.thinking', text: '第一步思考' },
          { driverId: 'qoder', type: 'qoder.thinking', text: '第二步思考' },
          { driverId: 'qoder', type: 'qoder.thinking', text: '第三步思考' },
          { driverId: 'qoder', type: 'text', text: '最终答案' }
        ]}
      />
    )
    // 流式 thinking_delta 被拆成多个 part:必须合并成 1 个「思考过程」折叠块,不能刷屏。
    expect(screen.getAllByText('思考过程').length).toBe(1)
    // 正文仍然独立渲染。
    expect(screen.getByText('最终答案')).toBeInTheDocument()
    // 展开后能看到完整的拼接推理文本。
    fireEvent.click(screen.getByText('思考过程'))
    // thinking_delta 按 token 粒度推送:合并必须直接拼接,不能插入换行(否则每个词一行)
    expect(screen.getByText('第一步思考第二步思考第三步思考')).toBeInTheDocument()
  })

  it('wraps a full subtask (start + in-task parts + end) in a SubTaskGroup, default collapsed', () => {
    render(
      <PartRenderer
        parts={[
          // 主流程
          { driverId: 'qoder', type: 'text', text: '主流程' },
          // 子任务起点
          {
            driverId: 'qoder',
            type: 'qoder.subtask-start',
            taskId: 't-1',
            parentTaskId: 't-1',
            taskType: 'search',
            description: '查询文档'
          },
          // 子任务内 text(由 driver 反查 parent_tool_use_id 后挂上 parentTaskId)
          { driverId: 'qoder', type: 'text', text: '子任务内文本', parentTaskId: 't-1' },
          // 过程态
          {
            driverId: 'qoder',
            type: 'qoder.subtask-progress',
            taskId: 't-1',
            parentTaskId: 't-1',
            description: '正在搜索',
            lastToolName: 'searchDocs'
          },
          // 收尾
          {
            driverId: 'qoder',
            type: 'qoder.subtask-end',
            taskId: 't-1',
            parentTaskId: 't-1',
            status: 'completed',
            summary: '完成'
          }
        ]}
      />
    )

    // 主流程 part 始终可见
    expect(screen.getByText('主流程')).toBeInTheDocument()

    // SubTaskGroup trigger 存在
    const trigger = getSubtaskTrigger('t-1')
    expect(trigger).toBeInTheDocument()
    expect(trigger.getAttribute('data-state')).toBe('closed')

    // header 视觉块:子任务标签 + taskType + description + 状态徽章
    expect(screen.getByText('查询文档')).toBeInTheDocument()
    expect(screen.getByText('search')).toBeInTheDocument()
    expect(screen.getByText('已完成')).toBeInTheDocument()

    // 默认折叠:子任务内的 part 不可见(Radix CollapsibleContent 在 closed 时 hidden)
    expect(screen.queryByText('子任务内文本')).toBeNull()
    expect(screen.queryByText('正在搜索')).toBeNull()
  })

  it('嵌套子组按出现时间穿插进阶段卡（不一律沉到卡片末尾）', () => {
    render(
      <PartRenderer
        parts={[
          {
            driverId: 'qoder',
            type: 'qoder.subtask-start',
            taskId: 'stage-1',
            parentTaskId: 'stage-1',
            description: 'Agent planning'
          },
          { driverId: 'qoder', type: 'text', text: '阶段前段', parentTaskId: 'stage-1' },
          // 阶段中途委派的子任务：stageId 指向阶段组 → 嵌套
          {
            driverId: 'qoder',
            type: 'qoder.subtask-start',
            taskId: 'sub-1',
            parentTaskId: 'sub-1',
            stageId: 'stage-1',
            description: 'Explore'
          },
          { driverId: 'qoder', type: 'text', text: '子任务内', parentTaskId: 'sub-1' },
          { driverId: 'qoder', type: 'qoder.subtask-end', taskId: 'sub-1', parentTaskId: 'sub-1', status: 'completed' },
          { driverId: 'qoder', type: 'text', text: '阶段后段', parentTaskId: 'stage-1' },
          {
            driverId: 'qoder',
            type: 'qoder.subtask-end',
            taskId: 'stage-1',
            parentTaskId: 'stage-1',
            status: 'completed'
          }
        ]}
      />
    )
    // 展开阶段卡：嵌套 Explore 卡应夹在「阶段前段」与「阶段后段」之间，
    // 而非沉到「阶段后段」之后（否则发生在阶段中段的子任务视觉时序倒挂）。
    fireEvent.click(getSubtaskTrigger('stage-1'))
    const before = screen.getByText('阶段前段')
    const nested = getSubtaskTrigger('sub-1')
    const after = screen.getByText('阶段后段')
    expect(before.compareDocumentPosition(nested) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(nested.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('expands a subtask on header click and reveals in-task parts', () => {
    render(
      <PartRenderer
        parts={[
          {
            driverId: 'qoder',
            type: 'qoder.subtask-start',
            taskId: 't-2',
            parentTaskId: 't-2',
            taskType: 'search',
            description: '查询文档'
          },
          { driverId: 'qoder', type: 'text', text: '子任务内文本', parentTaskId: 't-2' },
          {
            driverId: 'qoder',
            type: 'qoder.subtask-end',
            taskId: 't-2',
            parentTaskId: 't-2',
            status: 'completed'
          }
        ]}
      />
    )

    const trigger = getSubtaskTrigger('t-2')
    expect(trigger.getAttribute('data-state')).toBe('closed')
    expect(screen.queryByText('子任务内文本')).toBeNull()

    fireEvent.click(trigger)
    expect(trigger.getAttribute('data-state')).toBe('open')
    expect(screen.getByText('子任务内文本')).toBeInTheDocument()
  })

  it('aggregates subtask-progress parts into a single summary line (不再逐条刷屏)', () => {
    render(
      <PartRenderer
        parts={[
          {
            driverId: 'qoder',
            type: 'qoder.subtask-start',
            taskId: 't-3',
            parentTaskId: 't-3',
            description: '查询文档'
          },
          {
            driverId: 'qoder',
            type: 'qoder.subtask-progress',
            taskId: 't-3',
            parentTaskId: 't-3',
            description: '正在搜索',
            lastToolName: 'searchDocs'
          },
          {
            driverId: 'qoder',
            type: 'qoder.subtask-end',
            taskId: 't-3',
            parentTaskId: 't-3',
            status: 'completed'
          }
        ]}
      />
    )

    // 默认折叠时统计行不可见
    expect(screen.queryByText(/过程态/)).toBeNull()

    // 展开后 progress 聚合成一行统计;已有 subtask-end(非 running)→ 过程描述不再单独显示
    fireEvent.click(getSubtaskTrigger('t-3'))
    expect(screen.getByText('过程态 1 次')).toBeInTheDocument()
    expect(screen.getByText('最后工具: searchDocs')).toBeInTheDocument()
    expect(screen.queryByText('正在搜索')).toBeNull()
  })

  it('still creates a group for orphan in-task parts (no subtask-start) and folds them by default', () => {
    render(
      <PartRenderer
        parts={[
          { driverId: 'qoder', type: 'text', text: '主流程' },
          // 只有子任务内的 part,缺 subtask-start(数据层不该发生,这里是 groupByParentTask 容错)
          { driverId: 'qoder', type: 'text', text: '孤儿子任务文本', parentTaskId: 't-orphan' }
        ]}
      />
    )

    // 主流程可见
    expect(screen.getByText('主流程')).toBeInTheDocument()
    // 孤儿 group 仍然有 trigger,默认折叠
    const trigger = getSubtaskTrigger('t-orphan')
    expect(trigger).toBeInTheDocument()
    expect(trigger.getAttribute('data-state')).toBe('closed')
    // 孤儿 part 默认不可见
    expect(screen.queryByText('孤儿子任务文本')).toBeNull()
  })

  it('shows 执行中 status badge when subtask-start exists but no subtask-end has arrived yet', () => {
    render(
      <PartRenderer
        parts={[
          {
            driverId: 'qoder',
            type: 'qoder.subtask-start',
            taskId: 't-running',
            parentTaskId: 't-running',
            taskType: 'search',
            description: '查询文档'
          },
          {
            driverId: 'qoder',
            type: 'qoder.subtask-progress',
            taskId: 't-running',
            parentTaskId: 't-running',
            description: '正在搜索',
            lastToolName: 'searchDocs'
          }
        ]}
      />
    )
    // 还没收到 subtask-end → status 走 running 分支
    expect(screen.getByText('执行中')).toBeInTheDocument()
    expect(screen.queryByText('已完成')).toBeNull()
    // 运行中:展开后最新一条 progress 描述作为「当前活动」显示
    fireEvent.click(getSubtaskTrigger('t-running'))
    expect(screen.getByText('正在搜索')).toBeInTheDocument()
  })

  it('interleaves the subtask card at its real position in the message flow (not after all main parts)', () => {
    render(
      <PartRenderer
        parts={[
          { driverId: 'qoder', type: 'text', text: '主流程前文' },
          {
            driverId: 'qoder',
            type: 'qoder.subtask-start',
            taskId: 't-pos',
            parentTaskId: 't-pos',
            description: '查询文档'
          },
          { driverId: 'qoder', type: 'text', text: '子任务内文本', parentTaskId: 't-pos' },
          { driverId: 'qoder', type: 'text', text: '主流程后文' }
        ]}
      />
    )
    const before = screen.getByText('主流程前文')
    const trigger = getSubtaskTrigger('t-pos')
    const after = screen.getByText('主流程后文')
    // DOM 顺序:主流程前文 → 子任务卡 → 主流程后文
    expect(before.compareDocumentPosition(trigger) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(trigger.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('pairs qoder.tool-use with its tool-result into a single ToolCallRow (点击展开输入/输出)', () => {
    render(
      <PartRenderer
        parts={[
          {
            driverId: 'qoder',
            type: 'qoder.tool-use',
            toolCallId: 'c-1',
            name: 'Read',
            input: { file_path: '/tmp/a.ts' }
          },
          { driverId: 'qoder', type: 'qoder.tool-result', toolCallId: 'c-1', output: '文件内容' }
        ]}
      />
    )
    // 紧凑单行:工具名 + 内联摘要(file_path 压缩为末段文件名)
    expect(screen.getByText('Tools - Read')).toBeInTheDocument()
    expect(screen.getByText('a.ts')).toBeInTheDocument()
    // result 不单独成行
    expect(screen.queryByText('Tools - 工具结果')).not.toBeInTheDocument()
    // 展开后输入/输出
    fireEvent.click(screen.getByRole('button', { name: /Read/ }))
    expect(screen.getByText('输入')).toBeInTheDocument()
    expect(screen.getByText('输出')).toBeInTheDocument()
    expect(screen.getByText('文件内容')).toBeInTheDocument()
  })

  it('pairs openai.tool-call with its tool-result into a ToolCallRow as well', () => {
    render(
      <PartRenderer
        parts={[
          {
            driverId: 'openai',
            type: 'openai.tool-call',
            toolCallId: 'o-1',
            name: 'search',
            input: { query: 'qoder docs' }
          },
          { driverId: 'openai', type: 'openai.tool-result', toolCallId: 'o-1', output: '搜索结果' }
        ]}
      />
    )
    expect(screen.getByText('Tools - search')).toBeInTheDocument()
    expect(screen.getByText('qoder docs')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /search/ }))
    expect(screen.getByText('搜索结果')).toBeInTheDocument()
  })

  it('merges consecutive openai.thinking deltas into one collapsible block and renders it', () => {
    render(
      <PartRenderer
        isStreaming
        parts={[
          { driverId: 'openai', type: 'openai.thinking', text: '第一段推理' },
          { driverId: 'openai', type: 'openai.thinking', text: '第二段推理' },
          { driverId: 'openai', type: 'text', text: '最终回答' }
        ]}
      />
    )
    // 流式期间显示「思考中…」折叠块,两条 thinking 合并成一块
    expect(screen.getByText('思考中…')).toBeInTheDocument()
    const blocks = screen.getAllByText(/第一段推理/)
    expect(blocks).toHaveLength(1)
    // reasoning-delta 按 token 粒度推送:合并必须直接拼接,不能插入换行(否则每个词一行)
    expect(screen.getByText('第一段推理第二段推理')).toBeInTheDocument()
    expect(screen.getByText('最终回答')).toBeInTheDocument()
  })

  it('merges token-level openai.thinking deltas without breaking lines (思考过程不再每词一行)', () => {
    render(
      <PartRenderer
        isStreaming
        parts={[
          // 模拟 DeepSeek reasoning 流:每个 chunk 一个词/短语,其中一段自带换行
          { driverId: 'openai', type: 'openai.thinking', text: '用户' },
          { driverId: 'openai', type: 'openai.thinking', text: '询问' },
          { driverId: 'openai', type: 'openai.thinking', text: '模型身份\n' },
          { driverId: 'openai', type: 'openai.thinking', text: '简洁' },
          { driverId: 'openai', type: 'openai.thinking', text: '回应' },
          { driverId: 'openai', type: 'text', text: '最终回答' }
        ]}
      />
    )
    // token 间直接拼接,只有模型自带的换行保留(归一化后表现为一个空格分隔)
    expect(screen.getByText('用户询问模型身份 简洁回应')).toBeInTheDocument()
    // 仍是单个「思考中…」折叠块
    expect(screen.getAllByText('思考中…').length).toBe(1)
  })

  it('renders an orphan tool-result (no matching tool-use) as a fallback row', () => {
    render(
      <PartRenderer parts={[{ driverId: 'qoder', type: 'qoder.tool-result', toolCallId: 'c-x', output: '孤立输出' }]} />
    )
    expect(screen.getByText('Tools - 工具结果')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /工具结果/ }))
    expect(screen.getByText('孤立输出')).toBeInTheDocument()
  })

  it('absorbs the spawner tool call into the subtask card (主流程不重复成行,result 进卡片输出段)', () => {
    render(
      <PartRenderer
        parts={[
          // 主流程发起子任务的工具调用(toolUseId 被 subtask-start 引用)
          {
            driverId: 'qoder',
            type: 'qoder.tool-use',
            toolCallId: 'spawn-1',
            name: 'Task',
            input: { description: '查询文档' }
          },
          {
            driverId: 'qoder',
            type: 'qoder.subtask-start',
            taskId: 't-9',
            parentTaskId: 't-9',
            taskType: 'local_agent',
            subagentType: 'Explore',
            description: '查询文档',
            toolUseId: 'spawn-1'
          },
          { driverId: 'qoder', type: 'qoder.tool-result', toolCallId: 'spawn-1', output: '子任务完整输出' },
          {
            driverId: 'qoder',
            type: 'qoder.subtask-end',
            taskId: 't-9',
            parentTaskId: 't-9',
            status: 'completed',
            summary: '完成'
          }
        ]}
      />
    )
    // header:description + task_type / subagent_type 徽章
    expect(screen.getByText('查询文档')).toBeInTheDocument()
    expect(screen.getByText('local_agent')).toBeInTheDocument()
    expect(screen.getByText('Explore')).toBeInTheDocument()
    // 主流程不出现 Task 工具行(被子任务卡吸收)
    expect(screen.queryByRole('button', { name: /Task/ })).not.toBeInTheDocument()
    expect(screen.queryByText('子任务完整输出')).toBeNull()
    // 展开卡片:notification summary 不展示,被吸收调用的 result 进「输出」段
    fireEvent.click(getSubtaskTrigger('t-9'))
    expect(screen.queryByText('完成')).toBeNull()
    expect(screen.getByText('输出')).toBeInTheDocument()
    expect(screen.getByText('子任务完整输出')).toBeInTheDocument()
  })
})
