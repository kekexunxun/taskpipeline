import { useChat as useAiChat } from "@ai-sdk/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type ChatConversation, type ChatConversationMeta, type ChatMessage, type ChatModelGroup } from "@/api";
import { useFeedback } from "@/hooks/useGlobalFeedback";
import { ElectronChatTransport } from "../chat-transport";

const transport = new ElectronChatTransport();

export function useChat() {
  const { showError, showSuccess } = useFeedback();
  const [metas, setMetas] = useState<ChatConversationMeta[]>([]);
  const [activeId, setActiveId] = useState<string>();
  const [conversation, setConversation] = useState<ChatConversation>();
  const [draft, setDraft] = useState("");
  const [modelGroups, setModelGroups] = useState<ChatModelGroup[]>([]);
  const [model, setModel] = useState<string>();
  const [taskCreationEnabled, setTaskCreationEnabled] = useState(false);
  const [taskBackend, setTaskBackend] = useState<{ id: string; displayName: string; configured: boolean }>();
  /**
   * 缓存最新消息的 ref，避免 useEffect 因 `ai` 引用变化而抖动。
   * useAiChat 内部对 messages 用 useSyncExternalStore 订阅；这里只是为了给消费方
   * 提供稳定引用。
   */
  const initialMessages = useMemo<ChatMessage[]>(
    () => (conversation && conversation.id === activeId ? conversation.messages : []),
    // 仅在 activeId 或 conversation.id 变化时重算
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeId, conversation?.id]
  );

  const refreshMetas = useCallback(async () => {
    try {
      setMetas(await api.listChats());
    } catch (reason) {
      showError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [showError]);
  const refreshMetasRef = useRef(refreshMetas);
  useEffect(() => {
    refreshMetasRef.current = refreshMetas;
  }, [refreshMetas]);

  const ai = useAiChat<ChatMessage>({
    id: activeId ?? "no-active-chat",
    messages: initialMessages,
    transport,
    onError: (error) => showError(error.message),
    onFinish: () => {
      void refreshMetasRef.current?.();
    }
  });

  // 始终指向最新 ai 的方法引用，避免 select/remove/send 等回调闭包到旧 chat 实例。
  const aiRef = useRef(ai);
  useEffect(() => {
    aiRef.current = ai;
  }, [ai]);

  useEffect(() => {
    void refreshMetas();
    void api
      .listChatModels()
      .then((groups) => {
        setModelGroups(groups);
        const preferred =
          groups.flatMap((group) => group.models).find((item) => item.isDefault) ??
          groups[0]?.models[0];
        setModel((current) => current ?? preferred?.value);
      })
      .catch((reason) => showError(reason instanceof Error ? reason.message : String(reason)));
    // 拉取后端列表，决定任务创建 Agent 默认显示的 backend 名称。
    // 这里失败也静默：没有后端时 UI 仍然可用，只是 tooltip 会显示通用文案。
    void api
      .listTaskBackends()
      .then((backends) => {
        const firstConfigured = backends.find((item) => item.configured) ?? backends[0];
        setTaskBackend(firstConfigured);
      })
      .catch(() => undefined);
  }, [refreshMetas, showError]);

  // 切换会话时把已加载的消息灌入 ai；流式中短路以免回退丢字。
  // 仅依赖关键状态：activeId / conversation 引用 / streaming 状态。
  useEffect(() => {
    if (!conversation || !activeId || conversation.id !== activeId) return;
    if (ai.status === "streaming" || ai.status === "submitted") return;
    try {
      aiRef.current.setMessages(conversation.messages);
    } catch (reason) {
      showError(reason instanceof Error ? reason.message : String(reason));
    }
    // 故意忽略 ai 引用：方法已通过 aiRef 访问最新实例。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, conversation, ai.status, showError]);

  const select = useCallback(
    async (id: string | undefined) => {
      try {
        await aiRef.current.stop();
      } catch {
        // 忽略 stop 失败（旧实例被释放）
      }
      setActiveId(id);
      setConversation(undefined);
      aiRef.current.setMessages([]);
      if (!id) return;
      try {
        const next = await api.getChat(id);
        setConversation(next);
        if (next?.model) setModel(next.model);
      } catch (reason) {
        showError(reason instanceof Error ? reason.message : String(reason));
      }
    },
    [showError]
  );

  const create = useCallback(async () => {
    try {
      try {
        await aiRef.current.stop();
      } catch {
        // 忽略
      }
      const next = await api.createChat(model);
      setActiveId(next.id);
      setConversation(next);
      await refreshMetas();
      return next.id;
    } catch (reason) {
      showError(reason instanceof Error ? reason.message : String(reason));
      return undefined;
    }
  }, [model, refreshMetas, showError]);

  const remove = useCallback(
    async (id: string) => {
      try {
        if (activeId === id) {
          try {
            await aiRef.current.stop();
          } catch {
            // 忽略
          }
        }
        await api.deleteChat(id);
        if (activeId === id) {
          setActiveId(undefined);
          setConversation(undefined);
          aiRef.current.setMessages([]);
        }
        await refreshMetas();
        showSuccess("对话已删除");
      } catch (reason) {
        showError(reason instanceof Error ? reason.message : String(reason));
      }
    },
    [activeId, refreshMetas, showError, showSuccess]
  );

  const send = useCallback(
    async (value?: string) => {
      const text = (value ?? draft).trim();
      if (!model || !text) return undefined;
      if (aiRef.current.status === "streaming" || aiRef.current.status === "submitted") return undefined;
      setDraft("");
      // 没有当前对话时，自动创建一个，避免「必须先点新建对话」的额外入口。
      let targetId = activeId;
      let createdConversation: ChatConversation | undefined;
      if (!targetId) {
        try {
          const created = await api.createChat(model);
          targetId = created.id;
          createdConversation = created;
          await refreshMetas();
        } catch (reason) {
          showError(reason instanceof Error ? reason.message : String(reason));
          return undefined;
        }
      }
      try {
        await aiRef.current.sendMessage({ text }, { body: { model, chatId: targetId, mode: taskCreationEnabled ? "task-create" : "chat" } });
        const refreshed = await api.getChat(targetId);
        if (createdConversation) setActiveId(targetId);
        if (refreshed) setConversation(refreshed);
        await refreshMetas();
        return targetId;
      } catch (reason) {
        showError(reason instanceof Error ? reason.message : String(reason));
        return undefined;
      }
    },
    [activeId, draft, model, refreshMetas, showError, taskCreationEnabled]
  );

  const streaming = ai.status === "streaming" || ai.status === "submitted";

  return useMemo(
    () => ({
      metas,
      activeId,
      conversation,
      messages: ai.messages ?? [],
      draft,
      streaming,
      modelGroups,
      model,
      taskCreationEnabled,
      taskBackend,
      setDraft,
      setModel,
      setTaskCreationEnabled,
      select,
      create,
      remove,
      send,
      stop: () => aiRef.current.stop()
    }),
    [
      metas,
      activeId,
      conversation,
      ai.messages,
      ai.status,
      draft,
      streaming,
      modelGroups,
      model,
      taskCreationEnabled,
      taskBackend,
      setDraft,
      setModel,
      select,
      create,
      remove,
      send
    ]
  );
}
