import { describe, expect, it } from "vitest";
import type { TaskStore } from "@coding-agent/core";
import { listChatModels, resolveChatModel } from "./chat-models.js";

function store(settings: Record<string, string | undefined>): TaskStore { return { getSetting: (key: string) => settings[key] } as TaskStore; }

describe("chat model registry", () => {
  it("exposes an opaque OpenAI model id without the base URL", async () => {
    const taskStore = store({ modelProfile: JSON.stringify({ provider: "company-openai", baseUrl: "https://private.example/v1", model: "company-model" }) });
    const groups = await listChatModels(taskStore, async () => ({ enabled: false, connected: false, running: false, models: [] }));
    expect(groups[0]?.models[0]).toMatchObject({ value: "openai:default", displayName: "company-model" }); expect(JSON.stringify(groups)).not.toContain("private.example");
  });

  it("resolves OpenAI configuration only inside the main process", () => {
    const taskStore = store({ modelProfile: JSON.stringify({ provider: "company-openai", baseUrl: "https://private.example/v1", model: "company-model" }) });
    expect(resolveChatModel("openai:default", taskStore, () => "secret")).toEqual({ provider: "openai", key: "company-model", baseUrl: "https://private.example/v1", apiKey: "secret" });
    expect(resolveChatModel("qoder:model-a", taskStore, () => undefined)).toEqual({ provider: "qoder", key: "model-a" });
    expect(() => resolveChatModel("openai:https://leak", taskStore, () => undefined)).toThrow("未知的聊天模型");
  });
});
