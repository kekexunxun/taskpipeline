import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ElectronChatTransport } from "../chat-transport";
import {
  api,
  type ChatAgentMode,
  type ChatConversation,
  type ChatConversationMeta,
  type ChatDriverId,
  type ChatMessage,
  type ChatModelGroup,
  type ChatStreamChunk,
  type DriverPart,
  type StoredMessageRecord
} from "@/api";
import { useChatModels } from "@/hooks/useChatModels";
import { useFeedback } from "@/hooks/useGlobalFeedback";

const transport = new ElectronChatTransport();

export type ChatStatus = "idle" | "submitted" | "streaming" | "error";

/**
 * 在 user 推上来 user message + 在 user 推上"在飞"的 assistant 消息时,把它们存进同一份 list。
 * assistant 消息的 `metadata` 来自 `start` chunk 推上来的 `messageMetadata`,以及 stream 结束时的
 * `task-created` / `done` 事件。
 */
type InFlightAssistant = {
  id: string;
  driverId: ChatDriverId;
  parts: DriverPart[];
  metadata: Record<string, never>;
};

type ActiveStream = {
  streamId: string;
  chatId: string;
  driverId: ChatDriverId;
  model: string;
  userMessageId: string;
  assistant: InFlightAssistant;
  abort: () => void;
  closed: Promise<void>;
};

function textOf(parts: DriverPart[]): string {
  return parts
    .filter((p): p is Extract<DriverPart, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join("");
}

/** 从 model value (`driverId:model`) 中抽出 driverId;失败返回 undefined。 */
function driverOfModelValue(value: string | undefined, groups: ChatModelGroup[]): ChatDriverId | undefined {
  if (!value) return undefined;
  // 1. 先按精确 group 匹配:model value 属于哪一组,driverId 就是哪组
  for (const group of groups) {
    if (group.models.some((model) => model.value === value)) return group.driverId;
  }
  // 2. 回退:用 value 的前缀判断
  if (value.startsWith("qoder:")) return "qoder";
  if (value.startsWith("openai:")) return "openai";
  return undefined;
}

export function useChat() {
  const { showError, showSuccess } = useFeedback();
  const [metas, setMetas] = useState<ChatConversationMeta[]>([]);
  const [activeId, setActiveId] = useState<string>();
  const [conversation, setConversation] = useState<ChatConversation>();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const { modelGroups } = useChatModels();
  const [model, setModel] = useState<string>();
  const [driverId, setDriverId] = useState<ChatDriverId | undefined>();
  /** 包装 setModel:同时根据 model value 推断 driverId 并设上。 */
  const setModelAndDriver = useCallback(
    (value: string | undefined) => {
      setModel(value);
      const resolved = driverOfModelValue(value, modelGroups);
      if (resolved) setDriverId(resolved);
    },
    [modelGroups]
  );
  const [status, setStatus] = useState<ChatStatus>("idle");
  const [taskCreationEnabled, setTaskCreationEnabled] = useState(false);
  const [taskBackend, setTaskBackend] = useState<{ id: string; displayName: string; configured: boolean }>();

  const activeStream = useRef<ActiveStream | undefined>(undefined);

  const refreshMetas = useCallback(async () => {
    try {
      setMetas(await api.listChats());
    } catch (reason) {
      showError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [showError]);

  useEffect(() => {
    void refreshMetas();
    // 任务后端列表
    void api
      .listTaskBackends()
      .then((backends) => {
        const firstConfigured = backends.find((item) => item.configured) ?? backends[0];
        setTaskBackend(firstConfigured);
      })
      .catch(() => undefined);
  }, [refreshMetas, showError]);

  // 模型列表首次加载时,设置默认 driver 和 model
  useEffect(() => {
    if (modelGroups.length === 0) return;
    const preferredDriver = modelGroups[0]?.driverId;
    const preferredModel =
      modelGroups.flatMap((group) => group.models).find((item) => item.isDefault) ??
      modelGroups[0]?.models[0];
    setDriverId((current) => current ?? preferredDriver);
    setModel((current) => current ?? preferredModel?.value);
  }, [modelGroups]);

  const loadConversation = useCallback(
    async (id: string) => {
      try {
        const next = await api.getChat(id);
        if (!next) {
          setMessages([]);
          return;
        }
        setConversation(next.conversation);
        setMessages(next.messages);
        if (next.conversation.model) setModelAndDriver(next.conversation.model);
        if (next.conversation.driverId) setDriverId(next.conversation.driverId);
      } catch (reason) {
        showError(reason instanceof Error ? reason.message : String(reason));
      }
    },
    [showError]
  );

  const select = useCallback(
    async (id: string | undefined) => {
      activeStream.current?.abort();
      activeStream.current = undefined;
      setStatus("idle");
      setActiveId(id);
      setConversation(undefined);
      setMessages([]);
      if (!id) return;
      await loadConversation(id);
    },
    [loadConversation]
  );

  const create = useCallback(
    async (workingDirectory?: string) => {
      try {
        activeStream.current?.abort();
        activeStream.current = undefined;
        setStatus("idle");
        const next = await api.createChat({ driverId, model, workingDirectory });
        setActiveId(next.id);
        setConversation(next);
        setMessages([]);
        await refreshMetas();
        return next.id;
      } catch (reason) {
        showError(reason instanceof Error ? reason.message : String(reason));
        return undefined;
      }
    },
    [driverId, model, refreshMetas, showError]
  );

  const remove = useCallback(
    async (id: string) => {
      try {
        if (activeId === id) {
          activeStream.current?.abort();
          activeStream.current = undefined;
          setStatus("idle");
          setActiveId(undefined);
          setConversation(undefined);
          setMessages([]);
        }
        await api.deleteChat(id);
        await refreshMetas();
        showSuccess("对话已删除");
      } catch (reason) {
        showError(reason instanceof Error ? reason.message : String(reason));
      }
    },
    [activeId, refreshMetas, showError, showSuccess]
  );

  const stop = useCallback(() => {
    activeStream.current?.abort();
  }, []);

  const send = useCallback(
    async (value?: string) => {
      const text = (value ?? draft).trim();
      if (!driverId || !model || !text) return undefined;
      if (activeStream.current) return undefined;
      setDraft("");

      // 没有当前对话时,自动创建一个。
      let targetId = activeId;
      if (!targetId) {
        try {
          const created = await api.createChat({ driverId, model });
          targetId = created.id;
          setActiveId(created.id);
          setConversation(created);
          setMessages([]);
          await refreshMetas();
        } catch (reason) {
          showError(reason instanceof Error ? reason.message : String(reason));
          return undefined;
        }
      }
      const streamId = crypto.randomUUID();
      const userId = crypto.randomUUID();
      const assistantId = crypto.randomUUID();
      const createdAt = new Date().toISOString();
      const userRecord: StoredMessageRecord = {
        id: userId,
        role: "user",
        createdAt,
        driverId,
        raw: { kind: "user", text }
      };
      const userMessage: ChatMessage = { ...userRecord, parts: [{ driverId, type: "text", text }] };
      const assistantMessage: ChatMessage = {
        id: assistantId,
        role: "assistant",
        createdAt,
        driverId,
        raw: { kind: "assistant", parts: [] },
        parts: []
      };
      // 立刻把 user 消息和"在飞"的 assistant 消息都 push 进去,UI 立即看到。
      setMessages((current) => [...current, userMessage, assistantMessage]);
      setStatus("submitted");

      const session = transport.start({
        streamId,
        chatId: targetId!,
        driverId,
        model,
        message: { id: userId, text, createdAt },
        mode: (taskCreationEnabled ? "task-create" : "chat") satisfies ChatAgentMode,
        onEvent: (event) => {
          const chunk = event.chunk;
          if (!chunk) return;
          applyChunk(assistantId, chunk);
        },
        onError: (error) => {
          showError(error.message);
          setStatus("error");
        }
      });

      activeStream.current = {
        streamId,
        chatId: targetId!,
        driverId,
        model,
        userMessageId: userId,
        assistant: {
          id: assistantId,
          driverId,
          parts: [],
          metadata: {} as Record<string, never>
        },
        abort: () => session.abort(),
        closed: session.closed
      };

      // 流结束(成功 / 失败 / 主动停止)时,重置 status 并刷新 metas。
      void session.closed.then(async () => {
        if (activeStream.current?.streamId !== streamId) return;
        activeStream.current = undefined;
        setStatus("idle");
        await refreshMetas();
      });

      return targetId;
    },
    [activeId, draft, driverId, model, refreshMetas, showError, taskCreationEnabled]
  );

  /**
   * 把 ChatStreamChunk 应用到指定 in-flight assistant 消息上。
   * 使用 functional setState 保证多次事件间的状态不会相互覆盖。
   */
  const applyChunk = useCallback(
    (assistantId: string, chunk: ChatStreamChunk) => {
      setMessages((current) =>
        current.map((message) => {
          if (message.id !== assistantId) return message;
          if (chunk.type === "part") {
            const next = [...message.parts, chunk.part];
            return { ...message, parts: next };
          }
          // 其它 chunk (start / model / task-created / done / error) 不影响 parts。
          return message;
        })
      );
      if (chunk.type === "part") {
        // 收到第一个 part 时切换到 streaming 状态(让 UI 的流式动画启用)。
        setStatus("streaming");
      }
    },
    []
  );

  const streaming = status === "streaming" || status === "submitted";

  return useMemo(
    () => ({
      metas,
      activeId,
      conversation,
      messages,
      draft,
      streaming,
      status,
      modelGroups,
      model,
      driverId,
      taskCreationEnabled,
      taskBackend,
      setDraft,
      setModelAndDriver,
      setDriverId,
      setTaskCreationEnabled,
      select,
      create,
      remove,
      send,
      stop
    }),
    [
      metas,
      activeId,
      conversation,
      messages,
      draft,
      streaming,
      status,
      modelGroups,
      model,
      driverId,
      taskCreationEnabled,
      taskBackend,
      select,
      create,
      remove,
      send,
      stop
    ]
  );
}

/** 测试/调试辅助。 */
export const __testHelpers = { textOf, driverOfModelValue };
