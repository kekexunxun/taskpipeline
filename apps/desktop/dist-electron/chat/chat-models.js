export async function listChatModels(store, getQoderStatus) {
    const groups = [];
    try {
        const qoder = await getQoderStatus();
        if (qoder.enabled && qoder.connected && qoder.models.length > 0) {
            groups.push({
                provider: "qoder",
                displayName: "Qoder Agent SDK",
                models: qoder.models.map((m) => ({
                    value: `qoder:${m.value}`,
                    displayName: m.displayName,
                    isDefault: m.isDefault,
                    isReasoning: m.isReasoning,
                    priceFactor: m.priceFactor
                }))
            });
        }
    }
    catch { /* qoder not configured */ }
    try {
        const raw = store.getSetting("modelProfile");
        if (raw) {
            const profile = JSON.parse(raw);
            if (profile.provider === "company-openai" && profile.baseUrl && profile.model) {
                groups.push({
                    provider: "openai",
                    displayName: "OpenAI-Compatible",
                    models: [{ value: `openai:${profile.baseUrl}|${profile.model}`, displayName: profile.model }]
                });
            }
        }
    }
    catch { /* malformed profile */ }
    return groups;
}
export function parseModelValue(value) {
    const colon = value.indexOf(":");
    const head = colon >= 0 ? value.slice(0, colon) : "";
    const body = value.slice(colon + 1);
    if (head === "openai") {
        const sep = body.indexOf("|");
        if (sep < 0)
            return { provider: "openai", key: body };
        const baseUrl = body.slice(0, sep);
        const model = body.slice(sep + 1);
        const apiKey = process.env.OPENAI_API_KEY;
        return { provider: "openai", key: model, openai: { baseUrl, model, apiKey } };
    }
    return { provider: "qoder", key: body };
}
//# sourceMappingURL=chat-models.js.map