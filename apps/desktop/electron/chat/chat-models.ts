import type { ChatModelGroup, ChatModelInfo } from "./chat-types.js";
import type { TaskStore } from "@coding-agent/core";

type QoderStatus = {
  enabled: boolean;
  connected: boolean;
  running: boolean;
  models: Array<{ value: string; displayName: string; isDefault?: boolean; isReasoning?: boolean; priceFactor?: number }>;
};

export async function listChatModels(store: TaskStore, getQoderStatus: () => Promise<QoderStatus>): Promise<ChatModelGroup[]> {
  const groups: ChatModelGroup[] = [];
  try {
    const qoder = await getQoderStatus();
    if (qoder.enabled && qoder.connected && qoder.models.length > 0) {
      groups.push({
        provider: "qoder",
        displayName: "Qoder Agent SDK",
        models: qoder.models.map((m): ChatModelInfo => ({
          value: `qoder:${m.value}`,
          displayName: m.displayName,
          isDefault: m.isDefault,
          isReasoning: m.isReasoning,
          priceFactor: m.priceFactor
        }))
      });
    }
  } catch { /* qoder not configured */ }

  try {
    const raw = store.getSetting("modelProfile");
    if (raw) {
      const profile = JSON.parse(raw) as { provider?: string; baseUrl?: string; model?: string; apiKeyEnv?: string };
      if (profile.provider === "company-openai" && profile.baseUrl && profile.model) {
        groups.push({
          provider: "openai",
          displayName: "OpenAI-Compatible",
          models: [{ value: `openai:${profile.baseUrl}|${profile.model}`, displayName: profile.model }]
        });
      }
    }
  } catch { /* malformed profile */ }

  return groups;
}

export function parseModelValue(value: string): { provider: "qoder" | "openai"; key: string; openai?: { baseUrl: string; model: string; apiKey?: string } } {
  const colon = value.indexOf(":");
  const head = colon >= 0 ? value.slice(0, colon) : "";
  const body = value.slice(colon + 1);
  if (head === "openai") {
    const sep = body.indexOf("|");
    if (sep < 0) return { provider: "openai", key: body };
    const baseUrl = body.slice(0, sep);
    const model = body.slice(sep + 1);
    const apiKey = process.env.OPENAI_API_KEY;
    return { provider: "openai", key: model, openai: { baseUrl, model, apiKey } };
  }
  return { provider: "qoder", key: body };
}
