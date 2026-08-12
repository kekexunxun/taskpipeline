import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Timeline, normalizeTimelineItems, type TimelineItem } from './Timeline'

function item(id: string, kind: TimelineItem['kind'], title: string, detail?: string): TimelineItem
function item(
  id: string,
  kind: TimelineItem['kind'],
  title: string,
  detail: string | undefined,
  payload: Record<string, unknown>
): TimelineItem
function item(
  id: string,
  kind: TimelineItem['kind'],
  title: string,
  detail?: string,
  payload?: Record<string, unknown>
): TimelineItem {
  return {
    id,
    taskId: 'task-1',
    kind,
    title,
    detail,
    payload,
    createdAt: `2026-08-01T00:00:0${id}.000Z`
  }
}

describe('normalizeTimelineItems', () => {
  it('sorts live events with persisted events and removes optimistic duplicates', () => {
    const persisted = { ...item('1', 'message', '你', '直接完成'), createdAt: '2026-08-01T00:00:05.100Z' }
    const localCopy = { ...item('2', 'message', '你', '直接完成'), createdAt: '2026-08-01T00:00:05.000Z' }
    const reply = { ...item('3', 'message', 'Qoder Agent', '已处理'), createdAt: '2026-08-01T00:00:07.000Z' }

    expect(
      normalizeTimelineItems([reply, persisted, localCopy] as TimelineItem[]).map((event) => event.detail)
    ).toEqual(['直接完成', '已处理'])
  })

  it('removes internal outcome markers from displayed content', () => {
    expect(
      normalizeTimelineItems([
        item('1', 'message', 'Qoder Agent', '请补充信息\n<!-- task-pipeline-outcome:needs_input -->')
      ])[0]?.detail
    ).toBe('请补充信息')
  })

  it('merges adjacent agent messages (旧数据 delta 碎片) into one paragraph', () => {
    const fragments = [
      item('1', 'message', 'Qoder Agent', '第一段'),
      item('2', 'message', 'Qoder Agent', '第二段'),
      item('3', 'message', 'Qoder Agent', '第三段')
    ]
    const merged = normalizeTimelineItems(fragments)
    expect(merged.length).toBe(1)
    expect(merged[0]?.detail).toBe('第一段第二段第三段')
  })

  it('does not merge adjacent non-agent messages (用户消息保持独立)', () => {
    const items = [item('1', 'message', '你', '问题一'), item('2', 'message', '你', '问题二')]
    expect(normalizeTimelineItems(items).length).toBe(2)
  })

  it('keeps tool use/result pair (同 kind/title/detail 仅 phase 不同,不能被去重)', () => {
    const use = item('1', 'tool', 'Read', undefined, {
      toolName: 'Read',
      toolUseId: 'call-1',
      phase: 'use',
      input: { file_path: '/a.ts' }
    })
    const result = item('2', 'tool', 'Read', undefined, {
      toolName: 'Read',
      toolUseId: 'call-1',
      phase: 'result',
      output: '文件内容'
    })
    const normalized = normalizeTimelineItems([use, result] as TimelineItem[])
    expect(normalized.length).toBe(2)
    expect(normalized.map((event) => (event.payload as { phase?: string }).phase)).toEqual(['use', 'result'])
  })

  /**
   * span 来源事件(payload.spanId)豁免 5 秒内容去重:相邻的纯 thinking / 重复文本是
   * 不同执行步骤(spanId 唯一),内容去重会误吞;无 spanId 的遗留事件仍按内容去重。
   */
  it('span 来源事件豁免 5 秒内容去重,遗留事件仍去重', () => {
    // 同 kind/title/detail、相隔 1 秒的两条 LLM 记录:带 spanId → 都保留
    const spanA = item('1', 'message', 'LLM 调用 · gpt-5', '继续推进', { spanId: 'sp-1' })
    const spanB = {
      ...item('2', 'message', 'LLM 调用 · gpt-5', '继续推进', { spanId: 'sp-2' }),
      createdAt: '2026-08-01T00:00:02.000Z'
    }
    expect(normalizeTimelineItems([spanA, spanB])).toHaveLength(2)

    // 同样的两条,无 spanId(遗留事件)→ 5 秒内容去重吞掉后者
    const legacyA = item('3', 'message', 'LLM 调用 · gpt-5', '继续推进')
    const legacyB = {
      ...item('4', 'message', 'LLM 调用 · gpt-5', '继续推进'),
      createdAt: '2026-08-01T00:00:04.000Z'
    }
    expect(normalizeTimelineItems([legacyA, legacyB])).toHaveLength(1)
  })
})

describe('Timeline', () => {
  it('默认主流程平铺,无子任务时不出现折叠卡', () => {
    render(
      <Timeline
        items={[item('1', 'status', 'Qoder init', 'raw payload'), item('2', 'message', 'Qoder Agent', '结果')]}
      />
    )

    // 主流程直接出现,没有折叠卡
    expect(screen.getByText('Qoder init')).toBeInTheDocument()
    expect(screen.getByText('结果')).toBeInTheDocument()
    // 没有"子任务"header
    expect(screen.queryByText(/子任务/)).not.toBeInTheDocument()
  })

  it('「注入记忆上下文」事件不在流程中展示(数据保留,渲染层隐藏)', () => {
    render(
      <Timeline
        items={[
          item('1', 'status', '检索记忆上下文', '命中 2 条'),
          item('2', 'status', '注入记忆上下文', '以下是相关记忆...'),
          item('3', 'status', '注入 Agent 上下文', '## Agent 指引'),
          item('4', 'message', 'Qoder Agent', '开始执行')
        ]}
      />
    )

    expect(screen.getByText('检索记忆上下文')).toBeInTheDocument()
    expect(screen.queryByText('注入记忆上下文')).not.toBeInTheDocument()
    expect(screen.queryByText('以下是相关记忆...')).not.toBeInTheDocument()
    expect(screen.getByText('注入 Agent 上下文')).toBeInTheDocument()
    expect(screen.getByText('开始执行')).toBeInTheDocument()
  })

  it('子任务默认折叠,点击 trigger 展开后看到子任务内条目', () => {
    render(
      <Timeline
        items={[
          item('1', 'message', 'Qoder Agent', '主流程:先分析需求'),
          // 子任务起点 → 作为折叠卡 header
          item('2', 'status', 'Qoder 子任务启动', '在仓库里搜代码', {
            parentTaskId: 'sub-1',
            subtaskId: 'sub-1',
            sdkSubtype: 'task_started',
            taskType: 'Explore',
            description: '在仓库里搜代码'
          }),
          // 子任务内的工具调用
          item('3', 'tool', '工具 Bash', 'ls -la', {
            parentTaskId: 'sub-1',
            sdkSubtype: undefined
          }),
          // 子任务收尾
          item('4', 'status', 'Qoder 子任务收尾', '完成', {
            parentTaskId: 'sub-1',
            subtaskId: 'sub-1',
            sdkSubtype: 'task_notification',
            status: 'completed',
            summary: '完成'
          })
        ]}
      />
    )

    // 主流程可见
    expect(screen.getByText('主流程:先分析需求')).toBeInTheDocument()

    // 子任务 header 可见(description 会被渲染到 SubTaskHeader)
    expect(screen.getByText('在仓库里搜代码')).toBeInTheDocument()
    // Explore 类型徽章可见
    expect(screen.getByText('Explore')).toBeInTheDocument()

    // 默认折叠:子任务内工具调用条目不出现
    expect(screen.queryByText('ls -la')).not.toBeInTheDocument()

    // 点击 trigger 展开
    const trigger = screen.getByRole('button', { name: /在仓库里搜代码/ })
    fireEvent.click(trigger)

    // 展开后能看到子任务内条目
    expect(screen.getByText('ls -la')).toBeInTheDocument()
  })

  /**
   * task_progress 聚合成卡片顶部统计行(过程态 N 次 · 最后工具 · tokens · 耗时),
   * task_notification 只驱动 header 状态徽章 —— SDK 语义上它是子任务整体状态收尾,
   * 内容(summary)不重复展示,也不再逐条平铺。
   */
  it('task_progress 聚合成统计行,task_notification 只驱动 header 状态徽章', () => {
    render(
      <Timeline
        items={[
          item('1', 'status', 'Qoder 子任务启动', '在仓库里搜代码', {
            parentTaskId: 'sub-1',
            subtaskId: 'sub-1',
            sdkSubtype: 'task_started',
            taskType: 'local_agent',
            subagentType: 'Explore',
            description: '在仓库里搜代码'
          }),
          // 过程态 progress:description 进 payload.description(这是 log.ts 实际写的字段)
          item('2', 'status', 'Qoder 子任务进度', 'raw json', {
            parentTaskId: 'sub-1',
            subtaskId: 'sub-1',
            sdkSubtype: 'task_progress',
            description: '已读 1 个文件',
            lastToolName: 'Read'
          }),
          // 收尾
          item('3', 'status', 'Qoder 子任务收尾', 'raw json', {
            parentTaskId: 'sub-1',
            subtaskId: 'sub-1',
            sdkSubtype: 'task_notification',
            status: 'completed',
            description: '完成'
          })
        ]}
      />
    )

    // header:description + task_type / subagent_type 徽章
    expect(screen.getByText('在仓库里搜代码')).toBeInTheDocument()
    expect(screen.getByText('local_agent')).toBeInTheDocument()
    expect(screen.getByText('Explore')).toBeInTheDocument()

    // 默认折叠:聚合行与收尾块不可见
    expect(screen.queryByText(/过程态/)).not.toBeInTheDocument()
    expect(screen.queryByText('完成')).not.toBeInTheDocument()

    // 展开
    fireEvent.click(screen.getByRole('button', { name: /在仓库里搜代码|查找发票推送相关代码|查找代码/ }))

    // progress 聚合成一行统计,不再逐条平铺
    expect(screen.getByText('过程态 1 次')).toBeInTheDocument()
    expect(screen.getByText('最后工具: Read')).toBeInTheDocument()
    // 非 running 时 latestDescription 不显示(过程描述收进聚合,不刷屏)
    expect(screen.queryByText('已读 1 个文件')).not.toBeInTheDocument()
    // notification 的 summary 不展示(它只是整体状态收尾,内容不重复展示)
    expect(screen.queryByText('完成')).not.toBeInTheDocument()
    // 收尾 status 折进 header 徽章(已完成)
    expect(screen.getByText('已完成')).toBeInTheDocument()
  })

  it('空 items 渲染占位符', () => {
    render(<Timeline items={[]} />)
    expect(screen.getByText('暂无执行记录')).toBeInTheDocument()
  })

  /**
   * 旧数据兜底:老版本 log.ts 只在 payload 里写 subtaskId / sdkSubtype,不写 parentTaskId;
   * subtaskMetaOf 现在会用 subtaskId 自指 parentTaskId(与新写入路径一致),
   * 让 groupByParentTask 能识别子任务折叠卡。回归测试保护这条兜底。
   */
  it('旧数据:payload 只有 subtaskId / sdkSubtype 也能正确折叠为子任务卡', () => {
    render(
      <Timeline
        items={[
          item('1', 'message', 'Qoder Agent', '主流程:执行前'),
          // 旧 data: 没有 parentTaskId 字段,只有 subtaskId + sdkSubtype
          item('2', 'status', 'Qoder 子任务启动', '在仓库里搜代码', {
            subtaskId: 'sub-old',
            sdkSubtype: 'task_started',
            taskType: 'Explore',
            description: '在仓库里搜代码'
          }),
          item('3', 'status', 'Qoder 子任务进度', '已读 1 个文件', {
            subtaskId: 'sub-old',
            sdkSubtype: 'task_progress',
            lastToolName: 'Read'
          }),
          item('4', 'status', 'Qoder 子任务收尾', '完成', {
            subtaskId: 'sub-old',
            sdkSubtype: 'task_notification',
            status: 'completed'
          })
        ]}
      />
    )

    // 旧数据也能识别为同一个子任务折叠卡,描述/类型 出现在 header
    expect(screen.getByText('在仓库里搜代码')).toBeInTheDocument()
    expect(screen.getByText('Explore')).toBeInTheDocument()
    // progress / notification 现在平铺在展开区:默认折叠时不可见
    expect(screen.queryByText('已读 1 个文件')).not.toBeInTheDocument()
    expect(screen.queryByText('完成')).not.toBeInTheDocument()
    // 展开后 progress 聚合成统计行,notification 折进 header 徽章
    fireEvent.click(screen.getByRole('button', { name: /在仓库里搜代码|查找发票推送相关代码|查找代码/ }))
    expect(screen.getByText('最后工具: Read')).toBeInTheDocument()
    expect(screen.getByText('已完成')).toBeInTheDocument()
  })

  /**
   * 更老的存量数据:commit 437cba0 之前的 log.ts 写 system 任务消息时**payload 整列留空**,
   * 只存 title=`Qoder ${subtype}` + detail=`JSON.stringify(message).slice(0, 2000)`。
   * subtaskMetaOf 第二个兜底分支会:
   *   1) 识别 title 匹配 `^Qoder task_(started|progress|notification)$`;
   *   2) 从 detail JSON 反解 task_id 自指为 parentTaskId(与新数据走同一条折叠路径);
   *   3) 补 taskType / description / status / lastToolName。
   * 回归测试保护这条兜底,避免再次出现「TaskPipeline 任务看板里 task_started 平铺 JSON」的现象。
   */
  it('更老的存量数据:title=Qoder task_*,payload undefined,detail 是 JSON,也能折叠为子任务卡', () => {
    // 模拟老版 log.ts 写入 events 表的形态:
    //   title = `Qoder ${message.subtype}`; detail = JSON.stringify(message); payload 整列留空
    const taskStartedDetail = JSON.stringify({
      type: 'system',
      subtype: 'task_started',
      task_id: 'sub-historical-1',
      tool_use_id: 'toolu_xxx',
      task_type: 'local_agent',
      subagent_type: 'Explore',
      description: '在仓库里搜代码'
    })
    const taskProgressDetail = JSON.stringify({
      type: 'system',
      subtype: 'task_progress',
      task_id: 'sub-historical-1',
      tool_use_id: 'toolu_xxx',
      last_tool_name: 'Read'
    })
    const taskNotificationDetail = JSON.stringify({
      type: 'system',
      subtype: 'task_notification',
      task_id: 'sub-historical-1',
      tool_use_id: 'toolu_xxx',
      status: 'completed',
      summary: '完成'
    })

    // payload 这里传 undefined,模拟 events 表里整列没存
    const startedItem: TimelineItem = {
      id: '2',
      taskId: 'task-1',
      kind: 'status',
      title: 'Qoder task_started',
      detail: taskStartedDetail,
      payload: undefined,
      createdAt: '2026-08-01T00:00:02.000Z'
    }
    const progressItem: TimelineItem = {
      id: '3',
      taskId: 'task-1',
      kind: 'status',
      title: 'Qoder task_progress',
      detail: taskProgressDetail,
      payload: undefined,
      createdAt: '2026-08-01T00:00:03.000Z'
    }
    const notificationItem: TimelineItem = {
      id: '4',
      taskId: 'task-1',
      kind: 'status',
      title: 'Qoder task_notification',
      detail: taskNotificationDetail,
      payload: undefined,
      createdAt: '2026-08-01T00:00:04.000Z'
    }

    render(
      <Timeline
        items={[
          { ...item('1', 'message', 'Qoder Agent', '主流程:执行前'), payload: undefined } as TimelineItem,
          startedItem,
          progressItem,
          notificationItem
        ]}
      />
    )

    // 从 detail JSON 反解出的 description 会显示在 SubTaskHeader
    expect(screen.getByText('在仓库里搜代码')).toBeInTheDocument()
    // 从 detail JSON 反解出的 task_type / subagent_type 会作为徽章显示
    expect(screen.getByText('local_agent')).toBeInTheDocument()
    expect(screen.getByText('Explore')).toBeInTheDocument()
    // status: completed → 「已完成」徽章
    expect(screen.getByText('已完成')).toBeInTheDocument()

    // 默认折叠:progress / notification 描述不可见
    expect(screen.queryByText('完成')).not.toBeInTheDocument()

    // 展开后 progress 聚合成统计行;notification 只驱动 header 徽章,内容不展示
    fireEvent.click(screen.getByRole('button', { name: /在仓库里搜代码|查找发票推送相关代码|查找代码/ }))
    // task_progress 从 detail JSON 反解 last_tool_name = 'Read'
    expect(screen.getByText('最后工具: Read')).toBeInTheDocument()
    // task_notification 的 summary 不展示(只驱动状态徽章)
    expect(screen.queryByText('完成')).not.toBeInTheDocument()
  })

  /**
   * 兜底分支的负面用例:title 看似是任务消息但 detail 是被截断的非法 JSON(老版 slice(0, 2000)
   * 偶发裁切到一半的情况),不应抛错,应静默降级为主流程。回归测试保护容错路径。
   */
  it('历史数据兜底:detail 是被截断的非法 JSON 时,静默降级为主流程,不抛错', () => {
    // detail 在第 2000 字被截断,JSON.parse 会失败 —— 兜底 catch 块吞掉
    const truncatedDetail = '{"type":"system","subtype":"task_started","task_id":"sub-truncated"'
    // payload 整列没存 → undefined。直接构造 TimelineItem,避免走 item() 助手的强类型重载。
    const startedItem: TimelineItem = {
      id: '1',
      taskId: 'task-1',
      kind: 'status',
      title: 'Qoder task_started',
      detail: truncatedDetail,
      payload: undefined,
      createdAt: '2026-08-01T00:00:01.000Z'
    }
    expect(() => render(<Timeline items={[startedItem]} />)).not.toThrow()
  })

  /**
   * 旧 log.ts 写 task_progress 时只提 description 字段,新版本补了 summary 兜底;
   * 同时 subtaskMetaOf 提 description 时也用 summary 兜底。这条测试保护:
   * 新写入的 events(payload.summary 有内容)能正确渲染成 progress 描述。
   */
  it('task_progress 摘要展示:payload.summary 兜底作为 description 文本', () => {
    render(
      <Timeline
        items={[
          item('1', 'status', 'Qoder 子任务启动', '查找相关代码', {
            parentTaskId: 'sub-1',
            subtaskId: 'sub-1',
            sdkSubtype: 'task_started',
            taskType: 'Explore',
            description: '查找相关代码'
          }),
          // 新版本:description 空字符串,summary 有「已读 1 个文件」——summary 兜底进 description
          item('2', 'status', 'Qoder 子任务进度', '', {
            parentTaskId: 'sub-1',
            subtaskId: 'sub-1',
            sdkSubtype: 'task_progress',
            description: '',
            summary: '已读 1 个文件',
            lastToolName: 'Read'
          })
        ]}
      />
    )
    // 展开
    fireEvent.click(screen.getByRole('button', { name: /查找相关代码/ }))
    // 无 notification → 运行中:summary 兜底成为 latestDescription 显示为当前活动
    expect(screen.getByText('已读 1 个文件')).toBeInTheDocument()
    expect(screen.getByText('最后工具: Read')).toBeInTheDocument()
  })

  /**
   * 时间穿插:子任务 group 出现在它实际发生的时间点附近,后续主流程消息继续渲染。
   * 验证「先全部 main + 再全部 groups」的老 bug 不会再回来 —— group 卡必须出现在
   * 它所属时间段内(主流程中间),不是被推到 Timeline 末尾。
   */
  it('时间穿插:子任务 group 出现在执行过程中,主流程消息从 group 之后继续', () => {
    // 直接构造 TimelineItem(不走 item() 助手),保证 createdAt 顺序稳定。
    const items: TimelineItem[] = [
      {
        id: '1',
        taskId: 'task-1',
        kind: 'message',
        title: 'Qoder Agent',
        detail: '主流程:分析问题',
        createdAt: '2026-08-01T00:00:01.000Z'
      },
      {
        id: '2',
        taskId: 'task-1',
        kind: 'status',
        title: 'Qoder 子任务启动',
        detail: '查找发票推送相关代码',
        payload: {
          parentTaskId: 'sub-1',
          subtaskId: 'sub-1',
          sdkSubtype: 'task_started',
          taskType: 'local_agent',
          description: '查找发票推送相关代码'
        },
        createdAt: '2026-08-01T00:00:02.000Z'
      },
      {
        id: '3',
        taskId: 'task-1',
        kind: 'status',
        title: 'Qoder 子任务进度',
        detail: '已读 1 个文件',
        payload: { parentTaskId: 'sub-1', subtaskId: 'sub-1', sdkSubtype: 'task_progress', lastToolName: 'Read' },
        createdAt: '2026-08-01T00:00:03.000Z'
      },
      {
        id: '4',
        taskId: 'task-1',
        kind: 'message',
        title: 'Qoder Agent',
        detail: '主流程:基于子任务结果总结',
        createdAt: '2026-08-01T00:00:04.000Z'
      },
      {
        id: '5',
        taskId: 'task-1',
        kind: 'status',
        title: 'Qoder 子任务收尾',
        detail: '完成',
        payload: {
          parentTaskId: 'sub-1',
          subtaskId: 'sub-1',
          sdkSubtype: 'task_notification',
          status: 'completed'
        },
        createdAt: '2026-08-01T00:00:05.000Z'
      }
    ]
    render(<Timeline items={items} />)

    // 主流程的两条 message 都应该出现
    expect(screen.getByText('主流程:分析问题')).toBeInTheDocument()
    expect(screen.getByText('主流程:基于子任务结果总结')).toBeInTheDocument()
    // 子任务 header 的 description 出现
    expect(screen.getByText('查找发票推送相关代码')).toBeInTheDocument()
    // 「已完成」状态徽章出现
    expect(screen.getByText('已完成')).toBeInTheDocument()
  })

  /**
   * 聚合语义回归:多条 progress 只出现一行统计;notification 的 description 进收尾 summary;
   * 过程描述不再逐条平铺(已完成的子任务不显示 latestDescription)。
   */
  it('展开后 progress 聚合为一行统计,notification description 进收尾 summary', () => {
    render(
      <Timeline
        items={[
          item('1', 'status', 'Qoder 子任务启动', '查找代码', {
            parentTaskId: 'sub-empty',
            subtaskId: 'sub-empty',
            sdkSubtype: 'task_started',
            taskType: 'local_agent',
            description: '查找代码'
          }),
          // progress(平铺显示:label + description + lastToolName badge)
          item('2', 'status', 'Qoder 子任务进度', '读文件', {
            parentTaskId: 'sub-empty',
            subtaskId: 'sub-empty',
            sdkSubtype: 'task_progress',
            description: '正在扫描 src 目录',
            lastToolName: 'Read'
          }),
          // notification(平铺显示:label + description + status badge)
          item('3', 'status', 'Qoder 子任务收尾', '汇总报告', {
            parentTaskId: 'sub-empty',
            subtaskId: 'sub-empty',
            sdkSubtype: 'task_notification',
            status: 'completed',
            description: '搜索完成,共找到 12 个相关文件'
          })
        ]}
      />
    )

    // 展开
    fireEvent.click(screen.getByRole('button', { name: /在仓库里搜代码|查找发票推送相关代码|查找代码/ }))

    // progress 聚合为一行统计(过程描述不再单独成行)
    expect(screen.getByText('过程态 1 次')).toBeInTheDocument()
    expect(screen.getByText('最后工具: Read')).toBeInTheDocument()
    expect(screen.queryByText('正在扫描 src 目录')).not.toBeInTheDocument()
    // notification 的 description 不展示(只驱动 header 状态徽章)
    expect(screen.queryByText('搜索完成,共找到 12 个相关文件')).not.toBeInTheDocument()
    expect(screen.getByText('已完成')).toBeInTheDocument()
  })

  /**
   * 工具调用:log.ts 把 assistant.tool_use / user.tool_result 各写一条 kind='tool' 事件,
   * payload 携带 toolUseId / phase / input / output。Timeline 按 toolUseId 配对后渲染成
   * ToolCallRow 紧凑单行(工具名 + 内联摘要),点击展开「输入」/「输出」两段。
   */
  it('工具调用:同 toolUseId 的 use + result 配对成一行 ToolCallRow,展开看输入/输出', () => {
    render(
      <Timeline
        items={[
          item('1', 'status', 'Qoder 子任务启动', '查找相关代码', {
            parentTaskId: 'sub-tool',
            subtaskId: 'sub-tool',
            sdkSubtype: 'task_started',
            taskType: 'local_agent',
            description: '查找相关代码'
          }),
          // tool_use(input 走 detail,这里 payload.input 也存一份供 SubTaskToolRow 读)
          item('2', 'tool', 'Read', JSON.stringify({ file_path: '/tmp/invoice.ts', limit: 80 }), {
            parentTaskId: 'sub-tool',
            sdkSubtype: undefined,
            toolName: 'Read',
            toolUseId: 'toolu_a',
            phase: 'use',
            input: { file_path: '/tmp/invoice.ts', limit: 80 }
          }),
          // tool_result(output 走 detail)
          item('3', 'tool', 'Read', '"export const x = 1\\n"', {
            parentTaskId: 'sub-tool',
            sdkSubtype: undefined,
            toolName: 'Read',
            toolUseId: 'toolu_a',
            phase: 'result',
            output: 'export const x = 1\n',
            isError: false
          })
        ]}
      />
    )

    // 展开子任务卡
    fireEvent.click(screen.getByRole('button', { name: /查找相关代码/ }))

    // 工具行:工具名粗体 + 内联摘要(file_path 压缩为末段文件名,避免被省略号截断)
    expect(screen.getByText('Tools - Read')).toBeInTheDocument()
    expect(screen.getByText('invoice.ts')).toBeInTheDocument()
    // 输入/输出默认折叠
    expect(screen.queryByText('输入')).not.toBeInTheDocument()
    // 点击工具行展开
    fireEvent.click(screen.getByRole('button', { name: /Read/ }))
    expect(screen.getByText('输入')).toBeInTheDocument()
    expect(screen.getByText('输出')).toBeInTheDocument()
    expect(screen.getByText((content) => content.includes('export const x = 1'))).toBeInTheDocument()
  })

  it('工具调用失败:tool_result.is_error=true 时展示「失败」标签而不是「结果」', () => {
    render(
      <Timeline
        items={[
          item('1', 'status', 'Qoder 子任务启动', '查找相关代码', {
            parentTaskId: 'sub-tool-fail',
            subtaskId: 'sub-tool-fail',
            sdkSubtype: 'task_started',
            taskType: 'local_agent',
            description: '查找相关代码'
          }),
          item('2', 'tool', 'Bash', '{"command":"rm -rf /"}', {
            parentTaskId: 'sub-tool-fail',
            sdkSubtype: undefined,
            toolName: 'Bash',
            toolUseId: 'toolu_b',
            phase: 'use',
            input: { command: 'rm -rf /' }
          }),
          item('3', 'tool', 'Bash', 'permission denied', {
            parentTaskId: 'sub-tool-fail',
            sdkSubtype: undefined,
            toolName: 'Bash',
            toolUseId: 'toolu_b',
            phase: 'result',
            output: 'permission denied',
            isError: true
          })
        ]}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /查找相关代码/ }))
    // 展开工具行后才看到失败标签与输出
    fireEvent.click(screen.getByRole('button', { name: /Bash/ }))
    expect(screen.getByText('失败')).toBeInTheDocument()
    expect(screen.getByText('permission denied')).toBeInTheDocument()
  })

  it('主流程工具调用:同 toolUseId 的 use + result 配对成一行,锚定在 use 位置', () => {
    render(
      <Timeline
        items={[
          item('1', 'message', 'Qoder Agent', '开始'),
          item('2', 'tool', 'Read', JSON.stringify({ file_path: '/tmp/a.ts' }), {
            toolName: 'Read',
            toolUseId: 'toolu_main',
            phase: 'use',
            input: { file_path: '/tmp/a.ts' }
          }),
          item('3', 'tool', 'Read', '"done"', {
            toolName: 'Read',
            toolUseId: 'toolu_main',
            phase: 'result',
            output: 'done'
          }),
          item('4', 'message', 'Qoder Agent', '结束')
        ]}
      />
    )

    // 配对成一行:工具名只出现一次(result 事件不重复成行)
    expect(screen.getAllByText('Tools - Read')).toHaveLength(1)
    expect(screen.getByText('a.ts')).toBeInTheDocument()
    expect(screen.getByText('开始')).toBeInTheDocument()
    expect(screen.getByText('结束')).toBeInTheDocument()
    // 展开后输入/输出
    fireEvent.click(screen.getByRole('button', { name: /Read/ }))
    expect(screen.getByText('输入')).toBeInTheDocument()
    expect(screen.getByText('输出')).toBeInTheDocument()
    expect(screen.getByText('done')).toBeInTheDocument()
  })

  it('发起子任务的工具调用被吸收:主流程不重复成行,result 进卡片「输出」段', () => {
    render(
      <Timeline
        items={[
          // 主流程发起子任务的工具调用(local_agent / Task)
          item('1', 'tool', 'Task', JSON.stringify({ description: '查找代码' }), {
            toolName: 'Task',
            toolUseId: 'toolu_spawn',
            phase: 'use',
            input: { description: '查找代码' }
          }),
          // 子任务起点(toolUseId 指向上面那条发起调用)
          item('2', 'status', 'Qoder 子任务启动', '查找代码', {
            parentTaskId: 'sub-spawn',
            subtaskId: 'sub-spawn',
            sdkSubtype: 'task_started',
            taskType: 'local_agent',
            description: '查找代码',
            toolUseId: 'toolu_spawn'
          }),
          // 发起调用的 result
          item('3', 'tool', 'Task', '"子任务全部输出"', {
            toolName: 'Task',
            toolUseId: 'toolu_spawn',
            phase: 'result',
            output: '子任务全部输出'
          }),
          item('4', 'status', 'Qoder 子任务收尾', '完成', {
            parentTaskId: 'sub-spawn',
            subtaskId: 'sub-spawn',
            sdkSubtype: 'task_notification',
            status: 'completed',
            summary: '找到 3 个文件'
          })
        ]}
      />
    )

    // 主流程不出现独立的 Task 工具行(被吸收进子任务卡 header,无 "Tools -" 前缀)
    expect(screen.queryByText('Tools - Task')).not.toBeInTheDocument()
    expect(screen.queryByText('子任务全部输出')).not.toBeInTheDocument()
    // 子任务卡 header 即发起调用样式:工具名 Task + 摘要「查找代码」,点击展开
    expect(screen.getByRole('button', { name: /Task/ })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /查找代码/ }))
    expect(screen.queryByText('找到 3 个文件')).not.toBeInTheDocument()
    expect(screen.getByText('输出')).toBeInTheDocument()
    expect(screen.getByText('子任务全部输出')).toBeInTheDocument()
  })

  /**
   * 嵌套层级修复(问题 3):阶段容器(agent.run 自指)折叠成阶段卡后,
   * 阶段内发起的子 Agent 组(stageId 指向阶段 id)必须嵌套进阶段卡内部,
   * 不能与阶段卡平级。此前 nested 只在 interleaveTimeline 数据层生成、
   * 渲染层被丢弃 —— 这条测试保护「阶段卡 → 子 Agent 卡 → 工具行」的树形层级。
   */
  it('nested 递归渲染:阶段卡内的子 Agent 卡嵌套展示,委派调用不重复成行', () => {
    const { container } = render(
      <Timeline
        items={[
          // 阶段容器(agent.run):parentTaskId/subtaskId 自指 → 折叠成阶段卡 header
          item('1', 'status', 'Qoder Agent 阶段', 'Agent planning', {
            parentTaskId: 'stage-1',
            subtaskId: 'stage-1',
            sdkSubtype: 'agent_run',
            taskType: 'Agent',
            description: 'Agent planning'
          }),
          // 阶段内普通工具
          item('2', 'tool', 'Read', '{"file_path":"/tmp/a.ts"}', {
            parentTaskId: 'stage-1',
            sdkSubtype: undefined,
            toolName: 'Read',
            toolUseId: 'toolu_stage',
            phase: 'use',
            input: { file_path: '/tmp/a.ts' }
          }),
          item('3', 'tool', 'Read', '"ok"', {
            parentTaskId: 'stage-1',
            sdkSubtype: undefined,
            toolName: 'Read',
            toolUseId: 'toolu_stage',
            phase: 'result',
            output: 'ok'
          }),
          // 阶段内发起子 Agent 的委派调用(use + result 都在阶段卡 children 里)
          item('4', 'tool', 'Task', '{"description":"查找代码"}', {
            parentTaskId: 'stage-1',
            sdkSubtype: undefined,
            toolName: 'Task',
            toolUseId: 'toolu_delegate',
            phase: 'use',
            input: { description: '查找代码' }
          }),
          item('5', 'tool', 'Task', '"委派输出"', {
            parentTaskId: 'stage-1',
            sdkSubtype: undefined,
            toolName: 'Task',
            toolUseId: 'toolu_delegate',
            phase: 'result',
            output: '委派输出'
          }),
          // 子 Agent(stageId 指向 stage-1 → Step 3 挂进阶段卡 nested)
          item('6', 'status', 'Qoder 子任务启动', '查找代码', {
            parentTaskId: 'sub-explore',
            subtaskId: 'sub-explore',
            sdkSubtype: 'task_started',
            stageId: 'stage-1',
            taskType: 'Explore',
            description: '查找代码',
            toolUseId: 'toolu_delegate'
          }),
          // 子 Agent 内工具
          item('7', 'tool', 'Bash', '{"command":"ls"}', {
            parentTaskId: 'sub-explore',
            sdkSubtype: undefined,
            toolName: 'Bash',
            toolUseId: 'toolu_sub',
            phase: 'use',
            input: { command: 'ls' }
          }),
          item('8', 'tool', 'Bash', '"file1"', {
            parentTaskId: 'sub-explore',
            sdkSubtype: undefined,
            toolName: 'Bash',
            toolUseId: 'toolu_sub',
            phase: 'result',
            output: 'file1'
          }),
          // 子 Agent 收尾
          item('9', 'status', 'Qoder 子任务收尾', '完成', {
            parentTaskId: 'sub-explore',
            subtaskId: 'sub-explore',
            sdkSubtype: 'task_notification',
            status: 'completed',
            summary: '找到 3 个文件'
          })
        ]}
      />
    )

    // 阶段卡可见(SubTaskHeader description)
    expect(screen.getByText('Agent planning')).toBeInTheDocument()
    // 委派调用被吸收:阶段卡内不出现独立的 Task 工具行
    expect(screen.queryByText('Tools - Task')).not.toBeInTheDocument()

    // 展开阶段卡(CollapsibleContent 折叠时内容不在 DOM,先展开才能看到内部)
    fireEvent.click(screen.getByRole('button', { name: /Agent planning/ }))
    // 阶段内工具行可见,子 Agent 卡 header 出现
    expect(screen.getByText('Tools - Read')).toBeInTheDocument()
    expect(screen.getByText('查找代码')).toBeInTheDocument()
    // 子 Agent 卡在阶段卡 article 内部,不是平级 —— 嵌套层级成立的直接证据
    const stageArticle = container.querySelector('[data-subtask-id="stage-1"]')!.closest('article')!
    expect(stageArticle.querySelector('[data-subtask-id="sub-explore"]')).not.toBeNull()
    // 子 Agent 卡默认折叠:卡内工具不可见
    expect(screen.queryByText('Tools - Bash')).not.toBeInTheDocument()

    // 展开子 Agent 卡 → 卡内工具行 + 被吸收委派调用的 result 输出段
    fireEvent.click(screen.getByRole('button', { name: /查找代码/ }))
    expect(screen.getByText('Tools - Bash')).toBeInTheDocument()
    expect(screen.getByText('委派输出')).toBeInTheDocument()
  })

  /**
   * 递归吸收(问题 3 的另一半):spawnerTaskByCallId / allToolPairs 必须递归遍历
   * nested 组 —— 阶段卡 children 里的委派调用(use/result)能被吸收进嵌套子 Agent 卡,
   * result 成为子卡底部「输出」段。此前的吸收逻辑只扫顶层 blocks,nested 组吸收不到。
   */
  it('递归吸收:阶段卡内发起的子 Agent,委派调用被吸收、result 进嵌套子卡输出段', () => {
    render(
      <Timeline
        items={[
          // 阶段容器
          item('1', 'status', 'Qoder Agent 阶段', 'Agent planning', {
            parentTaskId: 'stage-1',
            subtaskId: 'stage-1',
            sdkSubtype: 'agent_run',
            taskType: 'Agent',
            description: 'Agent planning'
          }),
          // 委派调用在阶段 children(use + result)
          item('2', 'tool', 'Task', '{"description":"查发票代码"}', {
            parentTaskId: 'stage-1',
            sdkSubtype: undefined,
            toolName: 'Task',
            toolUseId: 'toolu_delegate',
            phase: 'use',
            input: { description: '查发票代码' }
          }),
          item('3', 'tool', 'Task', '"发票模块输出"', {
            parentTaskId: 'stage-1',
            sdkSubtype: undefined,
            toolName: 'Task',
            toolUseId: 'toolu_delegate',
            phase: 'result',
            output: '发票模块输出'
          }),
          // 子 Agent(stageId → 嵌套)
          item('4', 'status', 'Qoder 子任务启动', '查发票代码', {
            parentTaskId: 'sub-delegate',
            subtaskId: 'sub-delegate',
            sdkSubtype: 'task_started',
            stageId: 'stage-1',
            taskType: 'Explore',
            description: '查发票代码',
            toolUseId: 'toolu_delegate'
          }),
          item('5', 'status', 'Qoder 子任务收尾', '完成', {
            parentTaskId: 'sub-delegate',
            subtaskId: 'sub-delegate',
            sdkSubtype: 'task_notification',
            status: 'completed',
            summary: '找到 2 处'
          })
        ]}
      />
    )

    // 委派调用不重复成行
    expect(screen.queryByText('Tools - Task')).not.toBeInTheDocument()
    // 展开阶段卡 → 子 Agent 卡出现(header 即发起调用样式:工具名 Task,无 "Tools -" 前缀)
    fireEvent.click(screen.getByRole('button', { name: /Agent planning/ }))
    expect(screen.getByRole('button', { name: /Task/ })).toBeInTheDocument()
    expect(screen.getByText('查发票代码')).toBeInTheDocument()
    // 展开子 Agent 卡 → result 进「输出」段
    fireEvent.click(screen.getByRole('button', { name: /查发票代码/ }))
    expect(screen.getByText('发票模块输出')).toBeInTheDocument()
  })

  /**
   * thinking 展示(问题 2):模型 thinking 是内部推理,不算主流程数据。
   * trace-service 已把 output 拆成 { thinking, text },前端折叠标注「思考过程」,
   * 默认收起,展开才看到完整推理 —— 主流程不被长推理文本刷屏。
   */
  it('thinking 折叠展示:标注「思考过程」,默认收起,展开可见完整推理', () => {
    render(
      <Timeline
        items={[
          item('1', 'message', 'Qoder Agent', '最终回答:发票模块在 src/invoice.ts', {
            thinking: '先分析需求:需要定位发票推送相关代码,再搜索实现模式...'
          })
        ]}
      />
    )

    // 主流程 detail 正常展示
    expect(screen.getByText('最终回答:发票模块在 src/invoice.ts')).toBeInTheDocument()
    // 「思考过程」标注可见,推理内容默认折叠(不算主流程数据)
    expect(screen.getByText('思考过程')).toBeInTheDocument()
    expect(screen.queryByText('先分析需求:需要定位发票推送相关代码,再搜索实现模式...')).not.toBeInTheDocument()
    // 点击展开 → 推理内容可见
    fireEvent.click(screen.getByRole('button', { name: /思考过程/ }))
    expect(screen.getByText('先分析需求:需要定位发票推送相关代码,再搜索实现模式...')).toBeInTheDocument()
  })

  it('live 模式:无 result 的主流程工具调用显示 running 状态', () => {
    const { container } = render(
      <Timeline
        live
        items={[
          item('1', 'tool', 'Bash', '{"command":"ls"}', {
            toolName: 'Bash',
            toolUseId: 'toolu_live',
            phase: 'use',
            input: { command: 'ls' }
          })
        ]}
      />
    )
    // running → Loader2 转圈图标
    expect(container.querySelector('.animate-spin')).not.toBeNull()
  })

  /**
   * 顶层阶段卡不缩进(此前统一 ml-7 border-l-2 让顶层「Agent planning」视觉上像
   * 嵌套在上一条 LLM 调用之下);仅嵌套子 Agent 卡保留缩进表达层级。
   * 包装 div(renderGroup 产出)在 article 外,缩进类断言落在它上面。
   */
  it('顶层阶段卡不缩进,嵌套子 Agent 卡保留缩进', () => {
    const { container } = render(
      <Timeline
        items={[
          // 阶段容器(顶层卡)
          item('1', 'status', 'Qoder Agent 阶段', 'Agent planning', {
            parentTaskId: 'stage-1',
            subtaskId: 'stage-1',
            sdkSubtype: 'agent_run',
            taskType: 'Agent',
            description: 'Agent planning'
          }),
          // 阶段内委派调用(被吸收,作为嵌套子卡锚点)
          item('2', 'tool', 'Task', undefined, {
            parentTaskId: 'stage-1',
            toolName: 'Task',
            toolUseId: 'toolu_delegate',
            phase: 'use',
            input: { description: '查代码' }
          }),
          // 嵌套子 Agent 卡(stageId → 挂进阶段卡)
          item('3', 'status', 'Qoder 子任务启动', '查代码', {
            parentTaskId: 'sub-1',
            subtaskId: 'sub-1',
            sdkSubtype: 'task_started',
            stageId: 'stage-1',
            taskType: 'Explore',
            description: '查代码',
            toolUseId: 'toolu_delegate'
          })
        ]}
      />
    )

    // 顶层阶段卡的包装 div(article 的父元素):无 ml-7 缩进
    const stageWrapper = container.querySelector('[data-subtask-id="stage-1"]')!.closest('article')!.parentElement!
    expect(stageWrapper.className).toContain('mb-4')
    expect(stageWrapper.className).not.toContain('ml-7')

    // 展开阶段卡 → 嵌套子卡包装 div 带 ml-7 缩进(层级表达保留给真正的嵌套)
    fireEvent.click(screen.getByRole('button', { name: /Agent planning/ }))
    const nestedWrapper = container.querySelector('[data-subtask-id="sub-1"]')!.closest('article')!.parentElement!
    expect(nestedWrapper.className).toContain('ml-7')
  })

  /**
   * 阶段卡内容区时序:children 与 nested 子卡按 createdAt 合并排序(此前固定先
   * children 后 nested —— 19:33 发生的子 Agent 卡排在 19:35 的 LLM 调用之后)。
   * nested 子卡的时间锚点取「被吸收委派工具」在本卡 children 里的位置。
   */
  it('阶段卡内 children 与嵌套子卡按时间合并排序(子卡锚定在被吸收委派调用的位置)', () => {
    render(
      <Timeline
        items={[
          // 阶段容器 t=01
          {
            ...item('1', 'status', 'Qoder Agent 阶段', 'Agent planning', {
              parentTaskId: 'stage-1',
              subtaskId: 'stage-1',
              sdkSubtype: 'agent_run',
              taskType: 'Agent',
              description: 'Agent planning'
            }),
            createdAt: '2026-08-01T00:00:01.000Z'
          },
          // 委派调用 use t=02(被吸收 → 嵌套子卡锚定在 t=02)
          {
            ...item('2', 'tool', 'Task', undefined, {
              parentTaskId: 'stage-1',
              toolName: 'Task',
              toolUseId: 'toolu_delegate',
              phase: 'use',
              input: { description: '查代码' }
            }),
            createdAt: '2026-08-01T00:00:02.000Z'
          },
          // 嵌套子 Agent 卡 header t=02
          {
            ...item('3', 'status', 'Qoder 子任务启动', '查代码', {
              parentTaskId: 'sub-1',
              subtaskId: 'sub-1',
              sdkSubtype: 'task_started',
              stageId: 'stage-1',
              taskType: 'Explore',
              description: '查代码',
              toolUseId: 'toolu_delegate'
            }),
            createdAt: '2026-08-01T00:00:02.500Z'
          },
          // 委派调用 result t=04(被吸收)
          {
            ...item('4', 'tool', 'Task', undefined, {
              parentTaskId: 'stage-1',
              toolName: 'Task',
              toolUseId: 'toolu_delegate',
              phase: 'result',
              output: '完成'
            }),
            createdAt: '2026-08-01T00:00:04.000Z'
          },
          // 阶段内 LLM 调用 t=05(晚于子卡发生,必须排在子卡之后)
          {
            ...item('5', 'message', 'LLM 调用 · gpt-5', '规划完成', {
              parentTaskId: 'stage-1',
              spanId: 'sp-llm'
            }),
            createdAt: '2026-08-01T00:00:05.000Z'
          }
        ]}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /Agent planning/ }))
    const nestedCard = screen.getByText('查代码')
    const llmText = screen.getByText('规划完成')
    // 嵌套子卡(锚定 t=02)必须排在 LLM 调用(t=05)之前 —— 时序错乱的回归断言
    expect(nestedCard.compareDocumentPosition(llmText) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})
