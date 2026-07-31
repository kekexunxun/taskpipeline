import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type ChatConversation, type ChatConversationMeta, type ChatEvent, type ChatModelGroup, type ChatMessage } from "../../../api";
import { useFeedback } from "../../../hooks/useGlobalFeedback";

export type ChatState = {
  metas: ChatConversationMeta[];
  activeId?: string;
  conversation?: ChatConversation;
  draft: string;
  streaming: boolean;
  modelGroups: ChatModelGroup[];
  model?: string;
  loaded: boolean;
  setDraft(value: string): void;
  setModel(value: string): void;
  select(id: string | undefined): void;
  create(): Promise<string | undefined>;
  remove(id: string): void;
  send(): Promise<void>;
  stop(): void;
};

export function useChat(): ChatState {
  const { showError, showSuccess } = useFeedback();
  const [metas, setMetas] = useState<ChatConversationMeta[]>([]);
  const [activeId, setActiveId] = useState<string>();
  const [conversation, setConversation] = useState<ChatConversation>();
  const [draft, setDraft] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [modelGroups, setModelGroups] = useState<ChatModelGroup[]>([]);
  const [model, setModel] = useState<string>();
  const [loaded, setLoaded] = useState(false);
  const offRef = useRef<(() => void) | undefined>(undefined);

  const refreshMetas = useCallback(async () => {
    try {
      setMetas(await api.listChats());
    } catch (reason) {
      showError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [showError]);

  const loadGroups = useCallback(async () => {
    try {
      const groups = await api.listChatModels();
      setModelGroups(groups);
      if (groups.length > 0 && groups[0]!.models.length > 0) {
        const firstDefault = groups.flatMap((group) => group.models).find((m) => m.isDefault);
        setModel(firstDefault?.value ?? groups[0]!.models[0]!.value);
      }
    } catch (reason) {
      showError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [showError]);

  useEffect(() => {
    void refreshMetas();
    void loadGroups();
  }, [loadGroups, refreshMetas]);

  // 订阅 chat event
  useEffect(() => {
    offRef.current?.();
    offRef.current = api.onChatEvent((event: ChatEvent) => {
      if (event.type === "chat_message_start") {
        setConversation((prev) => prev ? { ...prev, messages: [...prev.messages, { id: event.messageId, role: "assistant", content: "", createdAt: new Date().toISOString(), status: "streaming" }] } : prev);
        setStreaming(true);
      } else if (event.type === "chat_message_delta") {
        setConversation((prev) => {
          if (!prev) return prev;
          const messages = prev.messages.map((m) => m.id === event.messageId ? { ...m, content: m.content + event.delta } : m);
          return { ...prev, messages };
        });
      } else if (event.type === "chat_message_done") {
        setConversation((prev) => {
          if (!prev) return prev;
          const messages = prev.messages.map((m) => m.id === event.messageId ? { ...m, content: event.content, status: "done" as const, model: event.model ?? m.model } : m);
          return { ...prev, messages, updatedAt: new Date().toISOString(), messageCount: messages.length };
        });
        setStreaming(false);
      } else if (event.type === "chat_message_error") {
        setConversation((prev) => {
          if (!prev) return prev;
          const messages = prev.messages.map((m) => m.id === event.messageId ? { ...m, content: m.content || event.error, status: "error" as const } : m);
          return { ...prev, messages };
        });
        setStreaming(false);
        showError(event.error);
      }
    });
    return () => { offRef.current?.(); offRef.current = undefined; };
  }, [showError]);

  const select = useCallback(async (id: string | undefined) => {
    setActiveId(id);
    if (!id) { setConversation(undefined); return; }
    try {
      const conv = await api.getChat(id);
      if (conv) {
        setConversation(conv);
        if (conv.model) setModel(conv.model);
      } else {
        setConversation(undefined);
      }
    } catch (reason) {
      showError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [showError]);

  const create = useCallback(async (): Promise<string | undefined> => {
    try {
      const conv = await api.createChat(model);
      await refreshMetas();
      setActiveId(conv.id);
      setConversation(conv);
      return conv.id;
    } catch (reason) {
      showError(reason instanceof Error ? reason.message : String(reason));
      return undefined;
    }
  }, [model, refreshMetas, showError]);

  const remove = useCallback(async (id: string) => {
    if (!window.confirm("确认删除该对话？")) return;
    try {
      await api.deleteChat(id);
      if (activeId === id) { setActiveId(undefined); setConversation(undefined); }
      await refreshMetas();
      showSuccess("对话已删除");
    } catch (reason) {
      showError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [activeId, refreshMetas, showError, showSuccess]);

  const send = useCallback(async () => {
    if (!activeId || !draft.trim() || !model) return;
    const text = draft.trim();
    setDraft("");
    setStreaming(true);
    try {
      const userMsg = await api.appendUserMessage(activeId, text);
      setConversation((prev) => {
        if (!prev) return prev;
        const next: ChatConversation = { ...prev, title: prev.messages.length === 0 ? text.slice(0, 32) : prev.title, messages: [...prev.messages, userMsg], updatedAt: new Date().toISOString(), messageCount: prev.messageCount + 1 };
        return next;
      });
      await refreshMetas();
      await api.sendChatMessage(activeId, userMsg.id, model);
    } catch (reason) {
      setStreaming(false);
      showError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [activeId, draft, model, refreshMetas, showError]);

  const stop = useCallback(async () => {
    if (!activeId) return;
    try { await api.abortChat(activeId); } catch { /* noop */ }
    setStreaming(false);
  }, [activeId]);

  useEffect(() => { setLoaded(true); }, []);

  return useMemo(() => ({
    metas, activeId, conversation, draft, streaming, modelGroups, model, loaded,
    setDraft, setModel, select, create, remove, send, stop
  }), [metas, activeId, conversation, draft, streaming, modelGroups, model, loaded, setDraft, setModel, select, create, remove, send, stop]);
}
