import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentEvent, Task, TaskCard } from "@coding-agent/core";
import { api, type TaskDetail } from "../../../api";
import { useFeedback } from "../../../hooks/useGlobalFeedback";

export type TimelineItem = AgentEvent | {
  id: string;
  taskId: string;
  kind: AgentEvent["kind"];
  title: string;
  detail?: string;
  createdAt: string;
};

export type CodingPageState = {
  tasks: TaskCard[];
  selectedId?: string;
  detail?: TaskDetail;
  liveEvents: TimelineItem[];
  prompt: string;
  running: boolean;
  search: string;
  setSelectedId(id: string | undefined): void;
  setSearch(value: string): void;
  setPrompt(value: string): void;
  refresh(): Promise<void>;
  loadDetail(id: string): Promise<void>;
  send(): Promise<void>;
  run(action: () => Promise<unknown>): Promise<void>;
};

export function useTasks(): CodingPageState {
  const { showError, showSuccess } = useFeedback();
  const [tasks, setTasks] = useState<TaskCard[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [detail, setDetail] = useState<TaskDetail>();
  const [liveEvents, setLiveEvents] = useState<TimelineItem[]>([]);
  const [prompt, setPrompt] = useState("");
  const [running, setRunning] = useState(false);
  const [search, setSearch] = useState("");

  const liveMessageId = useRef<string | undefined>(undefined);
  const planningRef = useRef(false);
  const notifiedPlanRef = useRef<string | undefined>(undefined);

  const acceptDetail = useCallback((next: TaskDetail) => {
    setDetail(next);
    planningRef.current = next.task?.state === "planning";
    if (next.task?.state === "awaiting_plan_approval") {
      const key = `${next.task.id}:${next.task.planRevision ?? 0}`;
      if (notifiedPlanRef.current !== key) {
        notifiedPlanRef.current = key;
        showSuccess(`${next.task.title} 的计划已生成，等待确认`);
      }
    } else if (next.task?.state === "completed" && next.task.startMode === "plan" && next.task.summary === "代码已满足任务要求，无需修改") {
      const key = `${next.task.id}:completed`;
      if (notifiedPlanRef.current !== key) {
        notifiedPlanRef.current = key;
        showSuccess(`${next.task.title} 已满足要求，任务自动完成`);
      }
    }
  }, [showSuccess]);

  const refresh = useCallback(async () => {
    try {
      const list = await api.listTasks();
      setTasks(list);
      if (selectedId && !list.some((item) => item.id === selectedId)) {
        setSelectedId(undefined);
        setDetail(undefined);
      }
    } catch (reason) {
      showError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [selectedId, showError]);

  const loadDetail = useCallback(async (id: string) => {
    try {
      acceptDetail(await api.getTask(id));
    } catch (reason) {
      showError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [acceptDetail, showError]);

  // 初次 + 60s 轮询
  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 60_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  // 任务事件订阅（与原 App.tsx 一致）
  useEffect(() => {
    let changeTimer: number | undefined;
    const off = api.onTaskEvent((event) => {
      if (event.type === "extension_ui_request" && ["confirm", "select", "input", "editor"].includes(event.method)) {
        // UI request 由 UiRequestDialog 统一处理，事件通过 customEvent 广播
        window.dispatchEvent(new CustomEvent("task:ui-request", { detail: event }));
      }
      if (event.type === "agent_start") { setRunning(true); planningRef.current = event.phase === "planning"; liveMessageId.current = crypto.randomUUID(); }
      if (event.type === "task_changed") {
        const taskId = selectedId;
        window.clearTimeout(changeTimer);
        changeTimer = window.setTimeout(() => {
          void refresh();
          if (taskId && taskId === event.taskId) void api.getTask(taskId).then(acceptDetail);
        }, 100);
      }
      if (["agent_end", "agent_error", "process_exit"].includes(event.type)) {
        setRunning(false);
        liveMessageId.current = undefined;
        if (event.phase === "planning" || planningRef.current) setLiveEvents([]);
        planningRef.current = false;
        void refresh();
        if (selectedId) void api.getTask(selectedId).then(acceptDetail);
      }
      if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
        if (event.phase === "planning" || planningRef.current) return;
        const id = liveMessageId.current ??= crypto.randomUUID();
        setLiveEvents((items) => {
          const last = items[items.length - 1];
          if (last?.id === id) return [...items.slice(0, -1), { ...last, detail: `${last.detail ?? ""}${event.assistantMessageEvent.delta}` }];
          return [...items, { id, taskId: selectedId ?? "", kind: "message", title: "AI", detail: event.assistantMessageEvent.delta, createdAt: new Date().toISOString() }];
        });
      }
    });
    return () => { window.clearTimeout(changeTimer); off(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, refresh, acceptDetail]);

  // 切换任务时清空 liveEvents 并加载详情
  useEffect(() => {
    setLiveEvents([]);
    setDetail(undefined);
    if (selectedId) void api.getTask(selectedId).then(acceptDetail);
  }, [selectedId, acceptDetail]);

  const run = useCallback(async (action: () => Promise<unknown>) => {
    try {
      await action();
      await refresh();
      if (selectedId) acceptDetail(await api.getTask(selectedId));
    } catch (reason) {
      showError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [acceptDetail, refresh, selectedId, showError]);

  const send = useCallback(async () => {
    const selected = tasks.find((t) => t.id === selectedId);
    if (!selected || !prompt.trim()) return;
    const text = prompt;
    setPrompt("");
    setLiveEvents((items) => [...items, { id: crypto.randomUUID(), taskId: selected.id, kind: "message", title: "你", detail: text, createdAt: new Date().toISOString() }]);
    await run(() => api.sendTaskMessage(selected.id, text));
  }, [prompt, run, selectedId, tasks]);

  return {
    tasks,
    selectedId,
    detail,
    liveEvents,
    prompt,
    running,
    search,
    setSelectedId,
    setSearch,
    setPrompt,
    refresh,
    loadDetail,
    send,
    run
  };
}

export function selectTask(state: CodingPageState): Task | undefined {
  return state.tasks.find((t) => t.id === state.selectedId);
}

export function filteredTasks(state: CodingPageState): TaskCard[] {
  const q = state.search.toLowerCase();
  return state.tasks.filter((task) => !q || `${task.title} ${task.jiraKey ?? ""} ${task.keywords.join(" ")}`.toLowerCase().includes(q));
}
