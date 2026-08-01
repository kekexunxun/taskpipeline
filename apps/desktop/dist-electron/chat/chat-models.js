function readProfile(store) {
    const raw = store.getSetting("modelProfile");
    if (!raw)
        return undefined;
    try {
        return JSON.parse(raw);
    }
    catch {
        return undefined;
    }
}
export async function listChatModels(store, getQoderStatus) {
    const groups = [];
    try {
        const qoder = await getQoderStatus();
        if (qoder.enabled && qoder.connected && qoder.models.length)
            groups.push({ provider: "qoder", displayName: "Qoder Agent SDK", models: qoder.models.map((model) => ({ value: `qoder:${model.value}`, displayName: model.displayName, isDefault: model.isDefault, isReasoning: model.isReasoning, isVl: model.isVl, priceFactor: model.priceFactor })) });
    }
    catch { /* Qoder is optional. */ }
    const profile = readProfile(store);
    if (profile?.provider === "company-openai" && profile.baseUrl && profile.model)
        groups.push({ provider: "openai", displayName: "OpenAI-Compatible", models: [{ value: "openai:default", displayName: profile.displayName || profile.model, isDefault: groups.length === 0 }] });
    return groups;
}
export function resolveChatModel(value, store, getOpenAIKey) {
    if (value.startsWith("qoder:") && value.length > 6)
        return { provider: "qoder", key: value.slice(6) };
    if (value !== "openai:default")
        throw new Error("未知的聊天模型");
    const profile = readProfile(store);
    if (!profile?.baseUrl || !profile.model)
        throw new Error("OpenAI-Compatible profile 未配置");
    const apiKey = (profile.apiKeyEnv ? process.env[profile.apiKeyEnv] : undefined) ?? getOpenAIKey();
    return { provider: "openai", key: profile.model, baseUrl: profile.baseUrl, apiKey };
}
//# sourceMappingURL=chat-models.js.map