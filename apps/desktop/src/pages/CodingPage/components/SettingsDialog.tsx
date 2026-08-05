import { useEffect, useState, type ReactNode } from "react";
import {
  ChevronRightIcon,
  ExternalLinkIcon,
  GitBranchIcon,
  KeyRoundIcon,
  Loader2Icon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  ServerIcon,
  Trash2Icon
} from "lucide-react";
import type { QoderStatus } from "@/api";
import type { Memory, MemoryScope, RepositoryProfile } from "@coding-agent/core";
import { api } from "@/api";
import { useFeedback } from "@/hooks/useGlobalFeedback";
import { cn } from "@/lib/utils";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import { Field, FieldGroup } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { SecretInput } from "@/components/ui/secret-input";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ModelBadges } from "@/components/ModelBadges";
import { RepositoryDialog, TestButton, type RepoDraft } from "./RepositoryDialog";
import { MemoryDialog } from "./MemoryDialog";
import {
  OpenAIProfileDialog,
  OpenAIProfileTrigger,
  type OpenAIProfile
} from "./OpenAIProfileDialog";

type Settings = {
  defaultModel: string;
  qoderToken: string;
  gitlabToken: string;
  jiraUrl: string;
  jiraEmail: string;
  jiraToken: string;
  confluenceUrl: string;
  confluenceEmail: string;
  confluenceToken: string;
  autoCreateMergeRequests: string;
  openCodeReviewEnabled: string;
  createTestCasesEnabled: string;
  // modelApiKey 不再在通用设置中展示，由 OpenAI-Compatible 弹窗维护
  modelApiKey?: string;
};
type OpenAIDraft = {
  baseUrl: string;
  model: string;
  displayName: string;
  apiKeyConfigured: boolean;
};
const defaults: Settings = {
  defaultModel: "claude-sonnet-4.5",
  qoderToken: "",
  gitlabToken: "",
  jiraUrl: "",
  jiraEmail: "",
  jiraToken: "",
  confluenceUrl: "",
  confluenceEmail: "",
  confluenceToken: "",
  autoCreateMergeRequests: "false",
  openCodeReviewEnabled: "false",
  createTestCasesEnabled: "false"
};
const ordinaryKeys = [
  "defaultModel",
  "jiraUrl",
  "jiraEmail",
  "confluenceUrl",
  "confluenceEmail",
  "autoCreateMergeRequests",
  "openCodeReviewEnabled",
  "createTestCasesEnabled"
] as const;
const secretKeys = [
  "qoderToken",
  "gitlabToken",
  "jiraToken",
  "confluenceToken",
  "modelApiKey"
] as const;
const MANAGED_MEMORY_SCOPES: MemoryScope[] = ["user", "repo"];

function Section({
  title,
  description,
  children
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-2.5 border-b pb-4 last:border-b-0 last:pb-0">
      <div className="space-y-1">
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        {description && (
          <p className="text-xs leading-5 text-muted-foreground">{description}</p>
        )}
      </div>
      {children}
    </section>
  );
}

function SettingField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Field className="gap-1" label={label}>
      {children}
    </Field>
  );
}

/**
 * 仓库卡片：按需求只展示名称 + 分支两个核心字段，操作按钮靠右悬浮。
 */
function RepositoryCard({
  repository,
  onEdit,
  onDelete
}: {
  repository: RepositoryProfile;
  onEdit(): void;
  onDelete(): void;
}) {
  return (
    <article
      className="group flex items-center justify-between gap-2 rounded-md border bg-card px-3 py-2.5"
      title={repository.localPath}
    >
      <div className="flex min-w-0 items-center gap-2.5">
        <div className="grid size-7 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
          <GitBranchIcon size={12} />
        </div>
        <div className="min-w-0">
          <h4 className="truncate text-xs font-semibold text-foreground">{repository.name}</h4>
          <p className="mt-0.5 inline-flex items-center gap-1 truncate text-[11px] text-muted-foreground">
            <GitBranchIcon size={9} />
            {repository.defaultBranch || "main"}
          </p>
        </div>
      </div>
      <div className="flex shrink-0 gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`编辑仓库 ${repository.name}`}
          onClick={onEdit}
        >
          <PencilIcon size={11} />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`删除仓库 ${repository.name}`}
          onClick={onDelete}
        >
          <Trash2Icon size={11} />
        </Button>
      </div>
    </article>
  );
}

/**
 * 记忆卡片：标题可点击展开内容，操作按钮靠右悬浮。
 */
function MemoryCard({
  memory,
  expanded,
  onToggle,
  onEdit,
  onDelete
}: {
  memory: Memory;
  expanded: boolean;
  onToggle(): void;
  onEdit(): void;
  onDelete(): void;
}) {
  return (
    <article className="group rounded-md border bg-card">
      <div className="flex items-center gap-1.5 px-2.5 py-2">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
        >
          <ChevronRightIcon size={12} className={cn("shrink-0 text-muted-foreground transition-transform", expanded && "rotate-90")} />
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              {memory.pinned && <Badge variant="muted" className="text-[9px]">置顶</Badge>}
              <h4 className="truncate text-xs font-semibold text-foreground">{memory.title}</h4>
            </div>
          </div>
        </button>
        <div className="flex shrink-0 gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`编辑记忆 ${memory.title}`}
            onClick={onEdit}
          >
            <PencilIcon size={11} />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`删除记忆 ${memory.title}`}
            onClick={onDelete}
          >
            <Trash2Icon size={11} />
          </Button>
        </div>
      </div>
      {expanded && (
        <div className="border-t px-3 pb-2.5 pt-2">
          <p className="whitespace-pre-wrap text-[11px] leading-5 text-muted-foreground">{memory.content}</p>
          {memory.tags.length > 0 && (
            <p className="mt-1.5 text-[10px] text-muted-foreground/70">#{memory.tags.join(" #")}</p>
          )}
        </div>
      )}
    </article>
  );
}

/**
 * Qoder 模型卡片：复用 ModelBadges 保持与 ChatModelSelector 展示一致。
 */
function QoderModelCard({
  model,
  isDefault
}: {
  model: QoderStatus["models"][number];
  isDefault: boolean;
}) {
  return (
    <article className="flex items-center justify-between gap-2 rounded-md border bg-card px-3 py-2">
      <div className="min-w-0">
        <div className="flex items-center gap-1.5">
          <h4 className="truncate text-xs font-semibold text-foreground">{model.displayName}</h4>
          {isDefault && <Badge variant="muted" className="text-[9px]">默认</Badge>}
        </div>
        <p className="mt-0.5 truncate text-[11px] text-muted-foreground" title={model.description}>
          {model.description || "—"}
        </p>
      </div>
      <ModelBadges model={model} className="shrink-0" />
    </article>
  );
}

export function SettingsDialog({
  open,
  onOpenChange,
  qoder
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  qoder?: QoderStatus;
}) {
  const { showError, showSuccess } = useFeedback();
  const [settings, setSettings] = useState<Settings>(defaults);
  const [repositories, setRepositories] = useState<RepositoryProfile[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [repositoryDialog, setRepositoryDialog] = useState<{
    open: boolean;
    initial?: RepoDraft;
  }>({ open: false });
  const [deleteRepository, setDeleteRepository] = useState<RepositoryProfile | undefined>(undefined);
  const [memories, setMemories] = useState<Memory[]>([]);
  const [wikiCounts, setWikiCounts] = useState<Record<string, number>>({});
  const [memoryDialog, setMemoryDialog] = useState<{ open: boolean; initial?: Partial<Memory> & { id?: string } }>({ open: false });
  const [deleteMemory, setDeleteMemory] = useState<Memory | undefined>(undefined);
  const [rebuildingWiki, setRebuildingWiki] = useState<string | undefined>(undefined);
  const [activeMemoryTab, setActiveMemoryTab] = useState<string>("user");
  const [expandedMemoryId, setExpandedMemoryId] = useState<string | undefined>(undefined);
  const [openAIDraft, setOpenAIDraft] = useState<OpenAIDraft | null>(null);
  const [openAIDialog, setOpenAIDialog] = useState<{ open: boolean; mode: "create" | "edit" }>({
    open: false,
    mode: "create"
  });

  const load = async () => {
    setLoading(true);
    try {
      const entries = await Promise.all(
        [...ordinaryKeys, ...secretKeys].map(async (key) => [key, await api.getSetting(key)] as const)
      );
      const next = { ...defaults };
      for (const [key, value] of entries) if (value !== undefined) next[key] = value;
      setSettings(next);
      const repositoryList = await api.listRepositories();
      setRepositories(repositoryList);
      setMemories(await api.listMemories({ scopes: MANAGED_MEMORY_SCOPES }));
      const counts: Record<string, number> = {};
      for (const repository of repositoryList) counts[repository.id] = (await api.listRepoWikiDocs(repository.id)).length;
      setWikiCounts(counts);
      const profile = await api.getSetting("modelProfile");
      if (profile) {
        try {
          const parsed = JSON.parse(profile) as { baseUrl?: string; model?: string; displayName?: string };
          setOpenAIDraft({
            baseUrl: parsed.baseUrl ?? "",
            model: parsed.model ?? "",
            displayName: parsed.displayName ?? "",
            apiKeyConfigured: Boolean(await api.getSetting("modelApiKey"))
          });
        } catch {
          // 忽略历史脏数据
        }
      } else {
        setOpenAIDraft(null);
      }
    } catch (reason) {
      showError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    if (open) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const update = <K extends keyof Settings>(key: K, value: Settings[K]) =>
    setSettings((current) => ({ ...current, [key]: value }));
  const save = async () => {
    setSaving(true);
    try {
      for (const key of ordinaryKeys) await api.setSetting(key, settings[key]);
      for (const key of secretKeys)
        if (settings[key] && settings[key] !== "__configured__")
          await api.setSetting(key, settings[key], true);
      showSuccess("设置已保存");
    } catch (reason) {
      showError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };
  const saveOpenAIProfile = async (input: {
    baseUrl: string;
    model: string;
    displayName?: string;
    apiKey: string | undefined;
  }) => {
    try {
      await api.setSetting(
        "modelProfile",
        JSON.stringify({
          provider: "company-openai",
          baseUrl: input.baseUrl,
          model: input.model,
          displayName: input.displayName
        })
      );
      if (input.apiKey) await api.setSetting("modelApiKey", input.apiKey, true);
      setOpenAIDraft({
        baseUrl: input.baseUrl,
        model: input.model,
        displayName: input.displayName ?? "",
        apiKeyConfigured: input.apiKey ? true : openAIDraft?.apiKeyConfigured ?? false
      });
      setOpenAIDialog({ open: false, mode: "create" });
    } catch (reason) {
      showError(reason instanceof Error ? reason.message : String(reason));
    }
  };
  const deleteOpenAIProfile = async () => {
    try {
      await api.setSetting("modelProfile", "");
      await api.setSetting("modelApiKey", "");
      setOpenAIDraft(null);
      setOpenAIDialog({ open: false, mode: "create" });
    } catch (reason) {
      showError(reason instanceof Error ? reason.message : String(reason));
    }
  };
  const refreshRepositories = async () => {
    try {
      setRepositories(await api.listRepositories());
      window.dispatchEvent(new CustomEvent("app:repositories-changed"));
    } catch (reason) {
      showError(reason instanceof Error ? reason.message : String(reason));
    }
  };
  const addRepository = async () => {
    try {
      const folder = await api.chooseRepositoryFolder();
      if (folder) setRepositoryDialog({ open: true, initial: folder });
    } catch (reason) {
      showError(reason instanceof Error ? reason.message : String(reason));
    }
  };
  const removeRepository = async () => {
    if (!deleteRepository) return;
    try {
      await api.deleteRepository(deleteRepository.id);
      setDeleteRepository(undefined);
      await refreshRepositories();
    } catch (reason) {
      showError(reason instanceof Error ? reason.message : String(reason));
    }
  };
  const refreshMemories = async () => {
    try {
      setMemories(await api.listMemories({ scopes: MANAGED_MEMORY_SCOPES }));
    } catch (reason) {
      showError(reason instanceof Error ? reason.message : String(reason));
    }
  };
  const removeMemory = async () => {
    if (!deleteMemory) return;
    try {
      await api.deleteMemory(deleteMemory.id);
      setDeleteMemory(undefined);
      await refreshMemories();
    } catch (reason) {
      showError(reason instanceof Error ? reason.message : String(reason));
    }
  };
  const rebuildRepoWiki = async (repositoryId: string) => {
    setRebuildingWiki(repositoryId);
    try {
      const result = await api.indexRepoWiki(repositoryId);
      const docs = await api.listRepoWikiDocs(repositoryId);
      setWikiCounts((current) => ({ ...current, [repositoryId]: docs.length }));
      showSuccess(`索引完成：新增 ${result.indexed}，移除 ${result.removed}`);
    } catch (reason) {
      showError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setRebuildingWiki(undefined);
    }
  };
  const openAIConfigured = Boolean(openAIDraft?.baseUrl && openAIDraft?.model);
  const userMemories = memories.filter((memory) => memory.scope === "user");
  const openMemoryCreate = () => {
    const activeRepo = repositories.find((repository) => repository.id === activeMemoryTab);
    setMemoryDialog({ open: true, initial: activeRepo ? { scope: "repo", repositoryId: activeRepo.id } : { scope: "user" } });
  };
  const openAIInitial: OpenAIProfile | undefined = openAIDraft
    ? {
        baseUrl: openAIDraft.baseUrl,
        model: openAIDraft.model,
        displayName: openAIDraft.displayName || undefined,
        apiKeyConfigured: openAIDraft.apiKeyConfigured
      }
    : undefined;

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          hideClose
          className="!w-[min(1120px,calc(100vw-32px))] !max-w-[1120px] grid h-[min(760px,calc(100vh-32px))] grid-rows-[auto_minmax(0,1fr)_auto] gap-0 p-0"
        >
          <DialogHeader className="space-y-1 border-b px-6 pb-3 pt-3.5">
            <DialogTitle className="text-sm">系统设置</DialogTitle>
            <DialogDescription>管理服务连接、凭据、仓库和聊天模型。</DialogDescription>
          </DialogHeader>
          {loading ? (
            <div className="grid place-items-center text-xs text-muted-foreground">
              <Loader2Icon className="animate-spin-slow" size={14} />
            </div>
          ) : (
            <Tabs
              defaultValue="general"
              orientation="vertical"
              className="grid min-h-0 grid-cols-[148px_minmax(0,1fr)]"
            >
              <TabsList className="flex h-full flex-col items-stretch justify-start gap-0.5 rounded-none border-r bg-card/40 p-2">
                <TabsTrigger className="justify-start h-7 px-2 text-xs!" value="general">通用</TabsTrigger>
                <TabsTrigger className="justify-start h-7 px-2 text-xs!" value="atlassian">Atlassian</TabsTrigger>
                <TabsTrigger className="justify-start h-7 px-2 text-xs!" value="repositories">仓库</TabsTrigger>
                <TabsTrigger className="justify-start h-7 px-2 text-xs!" value="memory">记忆</TabsTrigger>
                <TabsTrigger className="justify-start h-7 px-2 text-xs!" value="model">模型</TabsTrigger>
              </TabsList>
              <div className="thin-scrollbar min-h-0 space-y-5 overflow-y-auto p-6">
                <TabsContent value="general" className="space-y-5">
                  <Section title="Qoder" description="使用 Qoder Agent SDK 执行任务和生成对话。">
                    <FieldGroup className="gap-2.5">
                      <SettingField label="Qoder Token">
                        <SecretInput
                          aria-label="Qoder Token"
                          value={settings.qoderToken}
                          onChange={(event) => update("qoderToken", event.target.value)}
                        />
                      </SettingField>
                      {qoder && (
                        <div className="flex items-center gap-1.5 rounded-md border bg-card px-2.5 py-1.5 text-xs text-muted-foreground">
                          <ServerIcon size={12} />
                          <span className="text-sm text-foreground">连接状态</span>
                          <Badge variant={qoder.connected ? "success" : "destructive"}>
                            {qoder.connected ? "已连接" : "未连接"}
                          </Badge>
                          <span>{qoder.account?.subscriptionType ?? "未知档位"}</span>
                        </div>
                      )}
                    </FieldGroup>
                  </Section>
                  <Section title="GitLab" description="用于代码仓库和 Merge Request 集成。">
                    <FieldGroup className="gap-2.5">
                      <SettingField label="GitLab Token">
                        <SecretInput
                          aria-label="GitLab Token"
                          value={settings.gitlabToken}
                          onChange={(event) => update("gitlabToken", event.target.value)}
                        />
                      </SettingField>
                    </FieldGroup>
                  </Section>
                  <Section title="任务自动化" description="控制实现完成后的 Review / 测试用例生成 / MR 提交流程。">
                    <div className="space-y-2.5">
                      <label className="flex items-center justify-between gap-3 rounded-md border bg-card/40 px-3 py-2.5">
                        <span className="min-w-0">
                          <span className="block text-xs font-medium text-foreground">开启 CodeReview</span>
                          <span className="mt-0.5 block text-[11px] text-muted-foreground">实现和校验完成后自动执行代码评审。</span>
                        </span>
                        <Switch
                          checked={settings.openCodeReviewEnabled === "true"}
                          onCheckedChange={(checked) => update("openCodeReviewEnabled", checked ? "true" : "false")}
                        />
                      </label>
                      <label className="flex items-center justify-between gap-3 rounded-md border bg-card/40 px-3 py-2.5">
                        <span className="min-w-0">
                          <span className="block text-xs font-medium text-foreground">生成测试用例</span>
                          <span className="mt-0.5 block text-[11px] text-muted-foreground">实现完成后、Review 之前自动生成最小测试集；不修改业务逻辑。</span>
                        </span>
                        <Switch
                          checked={settings.createTestCasesEnabled === "true"}
                          onCheckedChange={(checked) => update("createTestCasesEnabled", checked ? "true" : "false")}
                        />
                      </label>
                      <label className="flex items-center justify-between gap-3 rounded-md border bg-card/40 px-3 py-2.5">
                        <span className="min-w-0">
                          <span className="block text-xs font-medium text-foreground">自动提交 MR</span>
                          <span className="mt-0.5 block text-[11px] text-muted-foreground">Review 通过后自动提交 Merge Request。</span>
                        </span>
                        <Switch
                          checked={settings.autoCreateMergeRequests === "true"}
                          onCheckedChange={(checked) => update("autoCreateMergeRequests", checked ? "true" : "false")}
                        />
                      </label>
                    </div>
                  </Section>
                </TabsContent>
                <TabsContent value="atlassian" className="space-y-5">
                  <Section title="Jira">
                    <FieldGroup className="gap-2.5">
                      <SettingField label="Jira Host">
                        <Input
                          value={settings.jiraUrl}
                          onChange={(event) => update("jiraUrl", event.target.value)}
                        />
                      </SettingField>
                      <SettingField label="Jira Email">
                        <Input
                          value={settings.jiraEmail}
                          onChange={(event) => update("jiraEmail", event.target.value)}
                        />
                      </SettingField>
                      <SettingField label="Jira Token">
                        <SecretInput
                          aria-label="Jira Token"
                          value={settings.jiraToken}
                          onChange={(event) => update("jiraToken", event.target.value)}
                        />
                      </SettingField>
                      <TestButton kind="jira" label="测试 Jira 连接" />
                    </FieldGroup>
                  </Section>
                  <Section title="Confluence">
                    <FieldGroup className="gap-2.5">
                      <SettingField label="Confluence Host">
                        <Input
                          value={settings.confluenceUrl}
                          onChange={(event) => update("confluenceUrl", event.target.value)}
                        />
                      </SettingField>
                      <SettingField label="Confluence Email">
                        <Input
                          value={settings.confluenceEmail}
                          onChange={(event) => update("confluenceEmail", event.target.value)}
                        />
                      </SettingField>
                      <SettingField label="Confluence Token">
                        <SecretInput
                          aria-label="Confluence Token"
                          value={settings.confluenceToken}
                          onChange={(event) => update("confluenceToken", event.target.value)}
                        />
                      </SettingField>
                      <TestButton kind="confluence" label="测试 Confluence 连接" />
                    </FieldGroup>
                  </Section>
                </TabsContent>
                <TabsContent value="repositories" className="space-y-2.5">
                  <div className="flex items-start justify-between gap-2.5">
                    <div>
                      <h3 className="text-xs font-semibold">仓库</h3>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        所有配置的仓库都会出现在这里，新增时从本地 Git 文件夹读取信息。
                      </p>
                    </div>
                    <Button size="sm" onClick={() => void addRepository()}>
                      <PlusIcon size={11} />
                      新增仓库
                    </Button>
                  </div>
                  {repositories.length ? (
                    <div className="grid gap-1.5 sm:grid-cols-2">
                      {repositories.map((repository) => (
                        <RepositoryCard
                          key={repository.id}
                          repository={repository}
                          onEdit={() =>
                            setRepositoryDialog({ open: true, initial: repository })
                          }
                          onDelete={() => setDeleteRepository(repository)}
                        />
                      ))}
                    </div>
                  ) : (
                    <div className="rounded-md border border-dashed p-6 text-center text-xs text-muted-foreground">
                      还没有配置仓库
                    </div>
                  )}
                </TabsContent>
                <TabsContent value="memory" className="space-y-5">
                  <Section title="记忆管理" description="用户级与仓库级长期记忆会注入到对话与任务执行上下文，可在此新增、修正或删除。">
                    <div className="flex items-start justify-between gap-2.5">
                      <div>
                        <h3 className="text-xs font-semibold">记忆</h3>
                        <p className="mt-0.5 text-xs text-muted-foreground">共 {memories.length} 条</p>
                      </div>
                      <Button size="sm" onClick={openMemoryCreate}>
                        <PlusIcon size={11} />
                        新增记忆
                      </Button>
                    </div>
                    <Tabs value={activeMemoryTab} onValueChange={setActiveMemoryTab}>
                      <TabsList className="h-7 justify-start gap-0.5 rounded-md border bg-card/40 p-0.5">
                        <TabsTrigger value="user" className="h-6 px-2.5 text-xs!">用户</TabsTrigger>
                        {repositories.map((repository) => (
                          <TabsTrigger key={repository.id} value={repository.id} className="h-6 max-w-36 px-2.5 text-xs!">
                            <span className="truncate">{repository.name}</span>
                          </TabsTrigger>
                        ))}
                      </TabsList>
                      <TabsContent value="user" className="mt-2.5 space-y-1.5">
                        {userMemories.length ? (
                          userMemories.map((memory) => (
                            <MemoryCard
                              key={memory.id}
                              memory={memory}
                              expanded={expandedMemoryId === memory.id}
                              onToggle={() => setExpandedMemoryId((current) => (current === memory.id ? undefined : memory.id))}
                              onEdit={() => setMemoryDialog({ open: true, initial: memory })}
                              onDelete={() => setDeleteMemory(memory)}
                            />
                          ))
                        ) : (
                          <div className="rounded-md border border-dashed p-6 text-center text-xs text-muted-foreground">
                            还没有用户级记忆
                          </div>
                        )}
                      </TabsContent>
                      {repositories.map((repository) => {
                        const repoMemories = memories.filter((memory) => memory.scope === "repo" && memory.repositoryId === repository.id);
                        return (
                          <TabsContent key={repository.id} value={repository.id} className="mt-2.5 space-y-1.5">
                            <div className="flex items-center justify-between rounded-md border bg-card/40 px-3 py-2">
                              <p className="text-[11px] text-muted-foreground">
                                repowiki 索引 {wikiCounts[repository.id] ?? 0} 篇
                              </p>
                              <Button
                                variant="secondary"
                                size="sm"
                                disabled={rebuildingWiki === repository.id}
                                onClick={() => void rebuildRepoWiki(repository.id)}
                              >
                                {rebuildingWiki === repository.id ? (
                                  <Loader2Icon className="animate-spin-slow" size={11} />
                                ) : (
                                  <RefreshCwIcon size={11} />
                                )}
                                {rebuildingWiki === repository.id ? "索引中" : "重建索引"}
                              </Button>
                            </div>
                            {repoMemories.length ? (
                              repoMemories.map((memory) => (
                                <MemoryCard
                                  key={memory.id}
                                  memory={memory}
                                  expanded={expandedMemoryId === memory.id}
                                  onToggle={() => setExpandedMemoryId((current) => (current === memory.id ? undefined : memory.id))}
                                  onEdit={() => setMemoryDialog({ open: true, initial: memory })}
                                  onDelete={() => setDeleteMemory(memory)}
                                />
                              ))
                            ) : (
                              <div className="rounded-md border border-dashed p-6 text-center text-xs text-muted-foreground">
                                该仓库还没有记忆
                              </div>
                            )}
                          </TabsContent>
                        );
                      })}
                    </Tabs>
                  </Section>
                </TabsContent>
                <TabsContent value="model" className="space-y-5">
                  <Section title="Qoder 模型" description="可用模型由 Qoder 连接状态提供，徽章与对话面板保持一致。">
                    <FieldGroup className="gap-2.5">
                      {qoder?.models.length ? (
                        <div className="grid gap-1.5">
                          {qoder.models.map((item) => (
                            <QoderModelCard
                              key={item.value}
                              model={item}
                              isDefault={item.value === settings.defaultModel}
                            />
                          ))}
                        </div>
                      ) : (
                        <div className="rounded-md border border-dashed p-6 text-center text-xs text-muted-foreground">
                          未发现 Qoder 模型
                        </div>
                      )}
                    </FieldGroup>
                  </Section>
                  <Section
                    title="OpenAI-Compatible"
                    description="连接兼容 OpenAI API 格式的模型服务。"
                  >
                    <div className="flex items-center justify-between gap-3 rounded-md border bg-card/40 px-3 py-2.5">
                      <div className="flex min-w-0 items-center gap-2.5">
                        <div className="grid size-8 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
                          <ExternalLinkIcon size={14} />
                        </div>
                        <div className="min-w-0">
                          {openAIConfigured && openAIDraft ? (
                            <>
                              <div className="flex items-center gap-1.5">
                                <h4 className="truncate text-xs font-semibold text-foreground">
                                  {openAIDraft.displayName || openAIDraft.model}
                                </h4>
                                <Badge variant="muted" className="text-[9px]">已配置</Badge>
                              </div>
                              <p
                                className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground"
                                title={openAIDraft.baseUrl}
                              >
                                {openAIDraft.model} · {openAIDraft.baseUrl}
                              </p>
                            </>
                          ) : (
                            <>
                              <h4 className="text-xs font-semibold text-foreground">尚未配置</h4>
                              <p className="mt-0.5 text-[11px] text-muted-foreground">
                                点击新增填写 URL / API Key / 名称 / Model。
                              </p>
                            </>
                          )}
                        </div>
                      </div>
                      <OpenAIProfileTrigger
                        configured={openAIConfigured}
                        onClick={() =>
                          setOpenAIDialog({ open: true, mode: openAIConfigured ? "edit" : "create" })
                        }
                      />
                    </div>
                  </Section>
                </TabsContent>
              </div>
            </Tabs>
          )}
          <DialogFooter className="border-t px-6 py-2.5">
            <DialogClose asChild>
              <Button variant="secondary" size="sm">
                关闭
              </Button>
            </DialogClose>
            <Button size="sm" disabled={saving || loading} onClick={() => void save()}>
              {saving ? (
                <Loader2Icon className="animate-spin-slow" size={11} />
              ) : (
                <KeyRoundIcon size={11} />
              )}
              {saving ? "保存中" : "保存设置"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <RepositoryDialog
        open={repositoryDialog.open}
        initial={repositoryDialog.initial}
        onOpenChange={(next) =>
          setRepositoryDialog((current) => ({ ...current, open: next }))
        }
        onError={(reason) => showError(reason instanceof Error ? reason.message : String(reason))}
        onSaved={async () => {
          setRepositoryDialog({ open: false });
          await refreshRepositories();
        }}
      />
      <OpenAIProfileDialog
        open={openAIDialog.open}
        mode={openAIDialog.mode}
        initial={openAIInitial}
        onOpenChange={(next) =>
          setOpenAIDialog((current) => ({ ...current, open: next }))
        }
        onSaved={(profile) => void saveOpenAIProfile(profile)}
        onDeleted={() => void deleteOpenAIProfile()}
        onError={(reason) => showError(reason instanceof Error ? reason.message : String(reason))}
      />
      <MemoryDialog
        open={memoryDialog.open}
        initial={memoryDialog.initial}
        repositories={repositories}
        onOpenChange={(next) =>
          setMemoryDialog((current) => ({ ...current, open: next }))
        }
        onError={(reason) => showError(reason instanceof Error ? reason.message : String(reason))}
        onSaved={async () => {
          setMemoryDialog({ open: false });
          await refreshMemories();
        }}
      />
      <AlertDialog
        open={Boolean(deleteMemory)}
        onOpenChange={(next) => {
          if (!next) setDeleteMemory(undefined);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除记忆？</AlertDialogTitle>
            <AlertDialogDescription>
              将永久删除「{deleteMemory?.title}」，删除后无法恢复。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={() => void removeMemory()}>
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog
        open={Boolean(deleteRepository)}
        onOpenChange={(next) => {
          if (!next) setDeleteRepository(undefined);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除仓库配置？</AlertDialogTitle>
            <AlertDialogDescription>
              将删除「{deleteRepository?.name}」的配置，不会删除本地文件夹。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={() => void removeRepository()}>
              删除配置
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
