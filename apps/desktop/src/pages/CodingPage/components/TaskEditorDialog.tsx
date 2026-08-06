import { useEffect, useRef, useState } from "react";
import { CheckIcon, ChevronDownIcon, Loader2Icon, PlayIcon, SaveIcon, SlidersHorizontalIcon, SparklesIcon, WandSparklesIcon } from "lucide-react";
import type { AgentProfile, RepositoryProfile, Task, TaskRepository, TaskStartMode } from "@coding-agent/core";
// 与 packages/core/src/types.ts 的 AGENT_TASK_DISABLED 保持一致；
// 前端不得 import core 运行值（会拖入 better-sqlite3，导致 vite 预打包在浏览器环境崩溃）
const AGENT_TASK_DISABLED = "__disabled__";
import { api, type RepositoryCommands, type StartTaskOptions } from "@/api";
import { useFeedback } from "@/hooks/useGlobalFeedback";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Field, FieldGroup } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { mergeRepositoryOptions, RepositoryPicker } from "./RepositoryPicker";
import { cn } from "@/lib/utils";

/**
 * 任务编辑/启动 统一弹窗。
 *
 * 「一个弹窗，只区分提交行为」：
 *   - edit 模式：保存任务（新建/更新）+ 同步仓库 + 持久化仓库命令，关闭弹窗。
 *   - start 模式：先保存任务 + 同步仓库 + 持久化命令（让用户可以顺手改任务正文），再启动任务。
 *
 * 共享字段（两种模式都展示、都可编辑）：
 *   标题 / 描述 / 关键词 / 验收标准 / 关联仓库（含每个仓库的命令配置，默认折叠）/ 高级设置 · 任务自动化
 *
 * 启动专用字段（仅 start 模式展示）：
 *   启动方式（卡片选择器）
 *
 * 共享：宽度 720px、容器 max-h-[88vh] flex-col、正文 max-h-[58vh] overflow-y-auto；
 * 共享：DialogHeader / DialogFooter 排版；共享：仓库选择 + 取消按钮。
 */
export type TaskEditorDialogMode = "edit" | "start";

/**
 * 任务级自动化覆盖的三态值：
 *
 * - `undefined` 表示「沿用系统设置」（保存时不写入 task 字段）。
 * - `true` / `false` 表示本任务的显式覆盖。
 *
 * 选中「沿用」会重置回 `undefined`；切换到「开启 / 关闭」会写入 task 字段。
 * 这里与 system setting 互相独立——用户改系统设置不会回写到已有任务。
 */
type TaskOverride = boolean | undefined;
type Overrides = {
  openCodeReviewEnabled: TaskOverride;
  createTestCasesEnabled: TaskOverride;
  autoCreateMergeRequests: TaskOverride;
};

const SYSTEM_FLAG_KEYS = {
  openCodeReviewEnabled: "openCodeReviewEnabled",
  createTestCasesEnabled: "createTestCasesEnabled",
  autoCreateMergeRequests: "autoCreateMergeRequests"
} as const;

function readSetting(key: keyof typeof SYSTEM_FLAG_KEYS): Promise<boolean> {
  return api.getSetting(SYSTEM_FLAG_KEYS[key]).then((value) => value === "true");
}

/**
 * 启动方式卡片选择器。
 *
 * 视觉上彻底脱离 tab / segmented control 模式：左右两枚独立卡片，每张卡含
 * icon + 标题 + 描述；选中态用 `border-primary` + `bg-primary/5` + `ring-1 ring-primary/30`
 * 强调，与页面里其它"主操作"区域在视觉权重上一致。
 */
function StartModeCards({
  value,
  onChange
}: {
  value: TaskStartMode;
  onChange(next: TaskStartMode): void;
}) {
  const options: Array<{ value: TaskStartMode; label: string; description: string; Icon: typeof PlayIcon }> = [
    { value: "direct", label: "直接开始", description: "立即进入实现，跳过计划阶段。", Icon: PlayIcon },
    { value: "plan", label: "先生成计划", description: "先输出执行计划，确认后再实现。", Icon: WandSparklesIcon }
  ];
  return (
    <Field label="启动方式">
      <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="启动方式">
        {options.map((option) => {
          const active = option.value === value;
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => onChange(option.value)}
              className={cn(
                "rounded-md border p-3 text-left transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
                active
                  ? "border-primary/60 bg-primary/[0.06] ring-1 ring-primary/30"
                  : "border-border/60 hover:border-foreground/30 hover:bg-foreground/[0.02]"
              )}
            >
              <div className="flex items-center gap-1.5">
                <option.Icon size={12} className={cn(active ? "text-primary" : "text-muted-foreground")} />
                <span className={cn("text-xs font-medium", active ? "text-foreground" : "text-foreground/80")}>{option.label}</span>
                {active && <span className="ml-auto h-1.5 w-1.5 rounded-full bg-primary" aria-hidden />}
              </div>
              <p className="mt-1 text-[10.5px] leading-snug text-muted-foreground">{option.description}</p>
            </button>
          );
        })}
      </div>
    </Field>
  );
}

/**
 * 任务级覆盖的「沿用 / 开启 / 关闭」三态控件。
 *
 * 视觉重设计：
 *   - 字段标签与控件分离：标签「CodeReview」在 Field 的 label 区，控件在 children 区，避免把名字塞进按钮文案。
 *   - 按钮组只承担动作语义：「沿用」「开启」「关闭」。
 *   - 控件右侧用 inline tag 显示「系统默认: 开/关」，明确告诉用户跟随时的实际行为。
 *   - 底部 helper 行显示「实际生效: 开启 (沿用系统)」或「实际生效: 关闭 (任务独立覆盖)」。
 */
function AutomationOverrideField({
  label,
  helper,
  value,
  systemValue,
  onChange
}: {
  label: string;
  helper: string;
  value: TaskOverride;
  systemValue: boolean;
  onChange(next: TaskOverride): void;
}) {
  const options: Array<{ value: TaskOverride; label: string }> = [
    { value: undefined, label: "沿用" },
    { value: true, label: "开启" },
    { value: false, label: "关闭" }
  ];
  const effective = value ?? systemValue;
  const source = value === undefined ? "沿用系统" : "任务独立配置";
  return (
    <Field label={<span className="text-xs font-medium">{label}</span>}>
      <div className="space-y-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex h-7 items-center gap-0.5 rounded-md border bg-card/40 p-0.5 text-[11px]">
            {options.map((option) => {
              const active = option.value === value;
              return (
                <Button
                  key={option.label}
                  type="button"
                  variant={active ? "default" : "ghost"}
                  size="sm"
                  className="h-6 px-2"
                  onClick={() => onChange(option.value)}
                  aria-pressed={active}
                >
                  {option.label}
                </Button>
              );
            })}
          </div>
          <span className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-muted/30 px-1.5 py-0.5 text-[10px] text-muted-foreground">
            <span className="text-muted-foreground/70">系统默认</span>
            <span className={cn("font-medium", systemValue ? "text-emerald-500" : "text-muted-foreground/80")}>
              {systemValue ? "开" : "关"}
            </span>
          </span>
        </div>
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          {helper}
          <span className="ml-1 text-foreground/70">实际生效：{effective ? "开启" : "关闭"}（{source}）</span>
        </p>
      </div>
    </Field>
  );
}

/**
 * 任务级 Agent 覆盖的三态控件（与 AutomationOverrideField 同视觉语言）：
 *
 * -「跟随仓库」= `undefined`：按仓库白名单解析（默认），保存时不写 task 字段。
 * -「指定」= 具体 Agent id：强制使用该 Agent，不受仓库绑定限制。
 * -「禁用」= `AGENT_TASK_DISABLED`：本任务不注入 Agent 上下文，模型跟随系统设置。
 */
function TaskAgentOverrideField({
  agents,
  value,
  onChange
}: {
  agents: AgentProfile[];
  value: string | undefined;
  onChange(next: string | undefined): void;
}) {
  const choice = value === undefined ? "follow" : value === AGENT_TASK_DISABLED ? "disabled" : "custom";
  const selected = agents.find((agent) => agent.id === value);
  return (
    <Field label={<span className="text-xs font-medium">执行 Agent</span>}>
      <div className="space-y-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex h-7 items-center gap-0.5 rounded-md border bg-card/40 p-0.5 text-[11px]">
            <Button
              type="button"
              variant={choice === "follow" ? "default" : "ghost"}
              size="sm"
              className="h-6 px-2"
              onClick={() => onChange(undefined)}
              aria-pressed={choice === "follow"}
            >
              跟随仓库
            </Button>
            <Button
              type="button"
              variant={choice === "custom" ? "default" : "ghost"}
              size="sm"
              className="h-6 px-2"
              disabled={agents.length === 0}
              onClick={() => onChange(agents[0]?.id)}
              aria-pressed={choice === "custom"}
            >
              指定
            </Button>
            <Button
              type="button"
              variant={choice === "disabled" ? "default" : "ghost"}
              size="sm"
              className="h-6 px-2"
              onClick={() => onChange(AGENT_TASK_DISABLED)}
              aria-pressed={choice === "disabled"}
            >
              禁用
            </Button>
          </div>
          {choice === "custom" && (
            <Select value={value} onValueChange={(next) => onChange(next)}>
              <SelectTrigger className="h-7 w-44 text-xs" aria-label="指定执行 Agent">
                <SelectValue placeholder="选择 Agent" />
              </SelectTrigger>
              <SelectContent>
                {agents.map((agent) => (
                  <SelectItem key={agent.id} value={agent.id} className="text-xs">
                    {agent.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          任务执行时注入哪个 Agent 的指引并按其实例路由模型。
          {choice === "custom" && selected && <span className="ml-1 text-foreground/70">实际生效：{selected.name}（任务独立指定）</span>}
          {choice === "follow" && <span className="ml-1 text-foreground/70">实际生效：按仓库白名单解析</span>}
          {choice === "disabled" && <span className="ml-1 text-foreground/70">实际生效：禁用注入，模型跟随系统设置</span>}
        </p>
      </div>
    </Field>
  );
}

/**
 * 任务正文：标题 / 描述 / 关键词 / 验收标准 的输入字段。
 *
 * 两种模式都使用此组件并允许编辑。start 模式下用户改完后会随"开始实现"一起持久化，
 * 不必先退出再去 edit 弹窗单独改一遍。
 */
function TaskBodyFields({
  title,
  description,
  keywords,
  acceptance,
  onTitleChange,
  onDescriptionChange,
  onKeywordsChange,
  onAcceptanceChange
}: {
  title: string;
  description: string;
  keywords: string;
  acceptance: string;
  onTitleChange(next: string): void;
  onDescriptionChange(next: string): void;
  onKeywordsChange(next: string): void;
  onAcceptanceChange(next: string): void;
}) {
  return (
    <FieldGroup className="grid-cols-1 gap-3">
      <Field label="标题">
        <Input
          autoFocus
          value={title}
          onChange={(event) => onTitleChange(event.target.value)}
          placeholder="请输入标题"
        />
      </Field>
      <Field label="描述">
        <Textarea
          value={description}
          rows={3}
          onChange={(event) => onDescriptionChange(event.target.value)}
          placeholder="请输入描述"
        />
      </Field>
      <Field label="关键词（逗号分隔）">
        <Input
          value={keywords}
          onChange={(event) => onKeywordsChange(event.target.value)}
          placeholder="请输入关键词"
        />
      </Field>
      <Field label="验收标准（每行一条）">
        <Textarea
          value={acceptance}
          rows={2}
          onChange={(event) => onAcceptanceChange(event.target.value)}
          placeholder="请输入验收标准"
        />
      </Field>
    </FieldGroup>
  );
}

/**
 * 单个仓库的命令配置面板：默认折叠，标题行直接显示命令摘要。
 *
 * 之所以折叠：start 模式下用户通常不会在每次启动时都重写命令；展开后看到的
 * 4 个输入控件（setup / lint / test / build）占空间大。折叠态只占一行。
 */
function RepositoryCommandPanel({
  profile,
  isNewlyAttached,
  isOpen,
  onToggle,
  commands,
  onChange,
  agentId,
  agents,
  onAgentChange
}: {
  profile: RepositoryProfile;
  isNewlyAttached: boolean;
  isOpen: boolean;
  onToggle(): void;
  commands: RepositoryCommands | undefined;
  onChange(key: keyof RepositoryCommands, value: string): void;
  agentId?: string;
  agents: AgentProfile[];
  onAgentChange(agentId: string | undefined): void;
}) {
  const summary = summarizeCommands(commands);
  const selectedAgent = agents.find((a) => a.id === agentId);
  return (
    <section className="overflow-hidden rounded-md border bg-card/40">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={isOpen}
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-foreground/[0.02] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-medium">{profile.name}</span>
          {isNewlyAttached && <span className="text-[10.5px] text-muted-foreground/80">· 新关联</span>}
          <span className="mx-1 h-3 w-px bg-border/60" />
          <Select value={agentId ?? "__none__"} onValueChange={(value) => onAgentChange(value === "__none__" ? undefined : value)}>
            <SelectTrigger className="h-5 w-auto gap-0.5 border-0 bg-transparent p-0 text-[10.5px] text-muted-foreground hover:text-foreground focus:ring-0 [&_svg]:h-3 [&_svg]:w-3" aria-label="选择执行 Agent">
              <SelectValue placeholder={<span className="text-muted-foreground/60">默认 Agent</span>} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none__" className="text-xs">默认 Agent（跟随仓库绑定）</SelectItem>
              {agents.map((agent) => (
                <SelectItem key={agent.id} value={agent.id} className="text-xs">
                  {agent.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {selectedAgent && <span className="text-[10px] text-foreground/70">{selectedAgent.name}</span>}
        </div>
        <span className={cn("flex-1 truncate text-[10.5px]", summary.configured > 0 ? "text-muted-foreground" : "text-muted-foreground/60")}>
          {summary.text}
        </span>
        <span className="text-[10px] text-muted-foreground/70">
          {summary.configured}/4
        </span>
        <ChevronDownIcon
          size={11}
          className={cn("transition-transform duration-200", isOpen && "rotate-180")}
        />
      </button>
      {isOpen && (
        <div className="border-t p-3">
          <FieldGroup className="grid-cols-2 gap-2">
            <Field className="col-span-2" label="准备命令">
              <Textarea
                value={commands?.setupCommand ?? ""}
                onChange={(event) => onChange("setupCommand", event.target.value)}
                placeholder="可选，例如 npm install"
              />
            </Field>
            <Field label="Lint">
              <Input
                value={commands?.lintCommand ?? ""}
                onChange={(event) => onChange("lintCommand", event.target.value)}
              />
            </Field>
            <Field label="Test">
              <Input
                value={commands?.testCommand ?? ""}
                onChange={(event) => onChange("testCommand", event.target.value)}
              />
            </Field>
            <Field className="col-span-2" label="Build">
              <Input
                value={commands?.buildCommand ?? ""}
                onChange={(event) => onChange("buildCommand", event.target.value)}
              />
            </Field>
          </FieldGroup>
        </div>
      )}
    </section>
  );
}

/**
 * 把 4 个命令的"是否已配置"压成一段单行摘要。
 * 返回 `{ text, configured }`：`text` 用作标题行的展示，`configured` 用来显示 N/4 计数。
 */
function summarizeCommands(cmds?: RepositoryCommands): { text: string; configured: number } {
  const parts: string[] = [];
  let configured = 0;
  if (cmds?.setupCommand?.trim()) { parts.push(`准备 ${cmds.setupCommand}`); configured += 1; }
  if (cmds?.lintCommand?.trim()) { parts.push(`lint ${cmds.lintCommand}`); configured += 1; }
  if (cmds?.testCommand?.trim()) { parts.push(`test ${cmds.testCommand}`); configured += 1; }
  if (cmds?.buildCommand?.trim()) { parts.push(`build ${cmds.buildCommand}`); configured += 1; }
  if (configured === 0) return { text: "未配置命令（点击展开）", configured: 0 };
  return { text: parts.join(" · "), configured };
}

export function TaskEditorDialog({
  mode,
  task,
  taskId,
  reimplement = false,
  open,
  onOpenChange,
  onSaved,
  onStarting,
  onStarted
}: {
  mode: TaskEditorDialogMode;
  task?: Task;
  taskId?: string;
  reimplement?: boolean;
  open: boolean;
  onOpenChange(open: boolean): void;
  onSaved(task: Task): void | Promise<void>;
  onStarting?(taskId: string): void;
  onStarted?(): Promise<void>;
}) {
  // === 任务正文（两种模式都可编辑） ===
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [keywords, setKeywords] = useState("");
  const [acceptance, setAcceptance] = useState("");

  // === 共享：仓库选择 ===
  const [repositories, setRepositories] = useState<RepositoryProfile[]>([]);
  const [selectedRepoIds, setSelectedRepoIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const initialIdsRef = useRef<Set<string>>(new Set());
  const { showError, showSuccess } = useFeedback();

  // === 共享：高级设置（折叠面板） ===
  const [overrides, setOverrides] = useState<Overrides>({ openCodeReviewEnabled: undefined, createTestCasesEnabled: undefined, autoCreateMergeRequests: undefined });
  const [systemFlags, setSystemFlags] = useState<{ openCodeReviewEnabled: boolean; createTestCasesEnabled: boolean; autoCreateMergeRequests: boolean }>({ openCodeReviewEnabled: false, createTestCasesEnabled: false, autoCreateMergeRequests: false });
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  // === 任务级 Agent 覆盖：undefined=跟随仓库 | AGENT_TASK_DISABLED=禁用 | 其它=指定 Agent id ===
  const [agents, setAgents] = useState<AgentProfile[]>([]);
  const [agentProfileId, setAgentProfileId] = useState<string | undefined>(undefined);
  // 逐仓库 Agent 覆盖
  const [repoAgentIds, setRepoAgentIds] = useState<Record<string, string>>({});

  // === start 专用：启动方式 / 仓库命令（默认折叠） / reimplement 标记 ===
  const [startMode, setStartMode] = useState<TaskStartMode>("direct");
  const [taskRepositories, setTaskRepositories] = useState<TaskRepository[]>([]);
  const [commands, setCommands] = useState<Record<string, RepositoryCommands>>({});
  const [commandPanelsOpen, setCommandPanelsOpen] = useState<Record<string, boolean>>({});
  const [startSaving, setStartSaving] = useState(false);
  const [confirmingAll, setConfirmingAll] = useState(false);
  const reimplementedRef = useRef(false);

  // 依赖 key 用来在 open / mode / task.id 变化时统一重置状态
  const sessionKey = `${mode}|${open ? "1" : "0"}|${task?.id ?? ""}|${taskId ?? ""}`;

  // 构造提交用的 task input：edit 和 start 共用一份 payload。
  const buildTaskInput = () => ({
    title: title.trim(),
    description: description.trim(),
    keywords: keywords
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
    acceptanceCriteria: acceptance
      .split("\n")
      .map((item) => item.trim())
      .filter(Boolean),
    // 任务级覆盖：显式 boolean 才写入 task 字段；undefined 视为"沿用系统设置"（后端 patch 会清掉字段）。
    openCodeReviewEnabled: overrides.openCodeReviewEnabled,
    createTestCasesEnabled: overrides.createTestCasesEnabled,
    autoCreateMergeRequests: overrides.autoCreateMergeRequests,
    // 任务级 Agent：undefined=跟随仓库（不写入）；AGENT_TASK_DISABLED / id 为显式覆盖。
    agentProfileId,
    // 逐仓库 Agent 覆盖
    repoAgentIds: Object.keys(repoAgentIds).length > 0 ? repoAgentIds : undefined
  });

  // 同步仓库关联：edit / start 共用。
  const syncRepositories = async (targetTaskId: string, useAllRepositories: boolean) => {
    if (useAllRepositories) {
      for (const id of initialIdsRef.current) await api.detachRepository(targetTaskId, id);
      return;
    }
    const desired = new Set(selectedRepoIds);
    const current = new Set(initialIdsRef.current);
    const toAttach = [...desired].filter((id) => !current.has(id));
    const toDetach = [...current].filter((id) => !desired.has(id));
    for (const repoId of toAttach) {
      await api.attachRepository(targetTaskId, repoId);
    }
    for (const repoId of toDetach) {
      await api.detachRepository(targetTaskId, repoId);
    }
  };

  useEffect(() => {
    if (!open) return;
    if (mode === "edit") {
      setTitle(task?.title ?? "");
      setDescription(task?.description ?? "");
      setKeywords(task?.keywords.join(", ") ?? "");
      setAcceptance(task?.acceptanceCriteria.join("\n") ?? "");
      setAdvancedOpen(false);
      setAgentProfileId(task?.agentProfileId ?? undefined);
    } else {
      // start 模式：标题等数据由下面的 fetch effect 填充；这里只清 start 专用状态。
      reimplementedRef.current = false;
      setConfirmingAll(false);
      setCommandPanelsOpen({});
    }
  }, [sessionKey, mode, open, task?.title, task?.description, task?.keywords, task?.acceptanceCriteria, task]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);

    const repoPromise = api.listRepositories().catch((reason) => {
      showError(reason instanceof Error ? reason.message : String(reason));
      return [] as RepositoryProfile[];
    });

    // 两种模式都根据 taskId / task.id 拉详情——start 模式要靠它填充正文与初始化仓库。
    const detailTaskId = mode === "edit" ? task?.id : taskId;
    const detailPromise = detailTaskId
      ? api.getTask(detailTaskId).catch((reason) => {
        showError(reason instanceof Error ? reason.message : String(reason));
        return undefined;
      })
      : Promise.resolve(undefined);

    // 两种模式都需要读系统设置，让高级设置区显示真实"系统默认"。
    const systemFlagsPromise = Promise.all([
      readSetting("openCodeReviewEnabled"),
      readSetting("createTestCasesEnabled"),
      readSetting("autoCreateMergeRequests")
    ]);

    const agentsPromise = api.listAgents().catch((reason) => {
      showError(reason instanceof Error ? reason.message : String(reason));
      return [] as AgentProfile[];
    });

    Promise.all([repoPromise, detailPromise, systemFlagsPromise, agentsPromise])
      .then(([repos, detail, flags, agentList]) => {
        if (cancelled) return;
        setAgents(agentList);
        const attached = detail?.repositories ?? [];
        const merged = mergeRepositoryOptions(repos, attached);
        setRepositories(merged);
        const ids = attached.map((item) => item.repositoryId);
        initialIdsRef.current = new Set(ids);
        setSelectedRepoIds(new Set(ids));
        // 用详情填充正文 + overrides + 仓库命令（start 模式起始默认值）
        if (detail?.task) {
          setTitle(detail.task.title);
          setDescription(detail.task.description);
          setKeywords(detail.task.keywords.join(", "));
          setAcceptance(detail.task.acceptanceCriteria.join("\n"));
          setAgentProfileId(detail.task.agentProfileId);
          setRepoAgentIds(detail.task.repoAgentIds ?? {});
          setOverrides({
            openCodeReviewEnabled: detail.task.openCodeReviewEnabled,
            createTestCasesEnabled: detail.task.createTestCasesEnabled,
            autoCreateMergeRequests: detail.task.autoCreateMergeRequests
          });
        } else if (task) {
          setAgentProfileId(task.agentProfileId);
          setRepoAgentIds(task.repoAgentIds ?? {});
          setOverrides({
            openCodeReviewEnabled: task.openCodeReviewEnabled,
            createTestCasesEnabled: task.createTestCasesEnabled,
            autoCreateMergeRequests: task.autoCreateMergeRequests
          });
        }
        setSystemFlags({ openCodeReviewEnabled: flags[0], createTestCasesEnabled: flags[1], autoCreateMergeRequests: flags[2] });
        if (mode === "start") {
          setStartMode(detail?.task?.state === "planning" ? "plan" : "direct");
        }
        setTaskRepositories(attached);
        const byProfile = new Map(attached.map((repo) => [repo.repositoryId, repo]));
        setCommands(Object.fromEntries(merged.map((profile) => {
          const repo = byProfile.get(profile.id);
          return [profile.id, {
            setupCommand: repo?.setupCommand ?? profile.setupCommand,
            lintCommand: repo?.lintCommand ?? profile.lintCommand,
            testCommand: repo?.testCommand ?? profile.testCommand,
            buildCommand: repo?.buildCommand ?? profile.buildCommand
          }];
        })));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionKey, mode, task?.id, taskId, showError]);

  // === edit 提交：保存任务 + 同步仓库 + 持久化命令 + 关闭 ===
  const save = async () => {
    setSaving(true);
    try {
      const saved = task
        ? await api.updateTask(task.id, buildTaskInput())
        : await api.createTask(buildTaskInput());
      await syncRepositories(saved.id, false);
      // 持久化每个已选仓库的命令配置（setup / lint / test / build）。
      // 新关联的仓库在 syncRepositories 中已 attach，这里按 (taskId, repositoryId) 更新即可。
      for (const repoId of selectedRepoIds) {
        const cmds = commands[repoId];
        if (cmds) await api.updateTaskRepositoryCommands(saved.id, repoId, cmds);
      }
      await onSaved(saved);
      showSuccess(task ? "任务已更新" : "任务已创建");
      onOpenChange(false);
    } catch (reason) {
      showError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };

  // === start 提交：先保存任务（让用户改的正文 / 自动化覆盖一起持久化），再启动 ===
  const startTask = async (useAllRepositories = false) => {
    if (!taskId) return;
    if (selectedRepoIds.size === 0 && !useAllRepositories) {
      setConfirmingAll(true);
      return;
    }
    setStartSaving(true);
    onStarting?.(taskId);
    onOpenChange(false);
    try {
      // 1) 任务正文 + 自动化覆盖 与 仓库关联 一起持久化。
      await api.updateTask(taskId, buildTaskInput());
      await syncRepositories(taskId, useAllRepositories);
      // 2) 启动。
      const repositoryCommands = Object.fromEntries([...selectedRepoIds].map((id) => [id, commands[id] ?? {}]));
      if (reimplement && !reimplementedRef.current) {
        await api.reimplementTask(taskId);
        reimplementedRef.current = true;
      }
      const startOptions: StartTaskOptions = { mode: startMode, repositoryCommands, repoAgentIds: Object.keys(repoAgentIds).length > 0 ? repoAgentIds : undefined, ...(useAllRepositories ? { useAllRepositories: true } : {}) };
      await api.startTask(taskId, startOptions);
      await onStarted?.();
    } catch (reason) {
      await onStarted?.();
      showError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setStartSaving(false);
    }
  };

  const creating = mode === "edit" && !task;
  const selectedRepoProfiles = repositories.filter((repo) => selectedRepoIds.has(repo.id));

  // 启动按钮的文案 + 图标
  const startButtonLabel = startSaving
    ? "启动中"
    : selectedRepoIds.size === 0
      ? "使用全部 system 仓库启动"
      : startMode === "plan"
        ? "生成计划"
        : "开始实现";
  const StartIcon = startMode === "plan" ? SparklesIcon : PlayIcon;

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="flex max-h-[88vh] w-[min(720px,calc(100vw-32px))] flex-col gap-3 overflow-hidden p-5">
          <DialogHeader className="shrink-0">
            <DialogTitle>
              {mode === "edit" ? (creating ? "新建任务" : "编辑任务") : reimplement ? "重新实现" : "开始任务"}
            </DialogTitle>
            <DialogDescription>
              {mode === "edit"
                ? creating
                  ? "创建本地任务，并选择要关联的仓库。"
                  : "调整标题、描述、关键词、验收标准与仓库关联。"
                : reimplement
                  ? "将基于现有任务重新实现。可直接修改任务正文，确认后启动会一并保存。"
                  : "可直接修改任务正文与启动方式，确认后启动会一并保存任务。"}
            </DialogDescription>
          </DialogHeader>

          <FieldGroup className="thin-scrollbar grid-cols-1 max-h-[58vh] gap-3 overflow-y-auto px-1 py-1 pr-2">
            <TaskBodyFields
              title={title}
              description={description}
              keywords={keywords}
              acceptance={acceptance}
              onTitleChange={setTitle}
              onDescriptionChange={setDescription}
              onKeywordsChange={setKeywords}
              onAcceptanceChange={setAcceptance}
            />

            {mode === "start" && <StartModeCards value={startMode} onChange={setStartMode} />}

            <Field
              label={
                <span className="flex items-center justify-between gap-2">
                  <span>关联仓库</span>
                  <small className="text-xs font-normal text-muted-foreground">
                    已选 {selectedRepoIds.size} / {repositories.length}
                  </small>
                </span>
              }
            >
              <RepositoryPicker
                repositories={repositories}
                selectedIds={selectedRepoIds}
                loading={loading}
                onToggle={(id, checked) => setSelectedRepoIds((prev) => {
                  const next = new Set(prev);
                  if (checked) next.add(id);
                  else next.delete(id);
                  return next;
                })}
              />
            </Field>

            {selectedRepoProfiles.map((profile) => {
              const taskRepo = taskRepositories.find((repo) => repo.repositoryId === profile.id);
              return (
                <RepositoryCommandPanel
                  key={profile.id}
                  profile={profile}
                  isNewlyAttached={!taskRepo}
                  isOpen={Boolean(commandPanelsOpen[profile.id])}
                  onToggle={() => setCommandPanelsOpen((prev) => ({ ...prev, [profile.id]: !prev[profile.id] }))}
                  commands={commands[profile.id]}
                  onChange={(key, value) => setCommands((current) => ({ ...current, [profile.id]: { ...current[profile.id], [key]: value } }))}
                  agentId={repoAgentIds[profile.id]}
                  agents={agents}
                  onAgentChange={(agentId) => setRepoAgentIds((prev) => ({ ...prev, [profile.id]: agentId ?? "" }))}
                />
              );
            })}

            <fieldset className="overflow-hidden rounded-md border bg-card/40">
              <button
                type="button"
                className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-[11px] font-semibold text-muted-foreground transition-colors hover:bg-foreground/[0.03] hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                aria-expanded={advancedOpen}
                aria-controls="task-advanced-section"
                onClick={() => setAdvancedOpen((value) => !value)}
              >
                <span className="inline-flex items-center gap-1.5 text-xs">
                  <SlidersHorizontalIcon size={11} className="text-foreground/70" />
                  高级设置 · 任务自动化
                </span>
                <ChevronDownIcon
                  size={11}
                  className={cn("transition-transform duration-200", advancedOpen && "rotate-180")}
                />
              </button>
              {advancedOpen && (
                <div id="task-advanced-section" className="space-y-3 border-t p-3">
                  <p className="text-[11px] text-muted-foreground">默认沿用系统设置；如需本任务独立配置，请选择「开启 / 关闭」。修改系统设置不会回写到已创建的任务。</p>
                  <TaskAgentOverrideField
                    agents={agents}
                    value={agentProfileId}
                    onChange={setAgentProfileId}
                  />
                  <AutomationOverrideField
                    label="CodeReview"
                    helper="实现完成后是否自动跑 Review。"
                    value={overrides.openCodeReviewEnabled}
                    systemValue={systemFlags.openCodeReviewEnabled}
                    onChange={(next) => setOverrides((prev) => ({ ...prev, openCodeReviewEnabled: next }))}
                  />
                  <AutomationOverrideField
                    label="生成测试用例"
                    helper="实现完成后、Review 之前是否生成最小测试集。"
                    value={overrides.createTestCasesEnabled}
                    systemValue={systemFlags.createTestCasesEnabled}
                    onChange={(next) => setOverrides((prev) => ({ ...prev, createTestCasesEnabled: next }))}
                  />
                  <AutomationOverrideField
                    label="自动提交 MR"
                    helper="Review 通过后是否自动提交 Merge Request。"
                    value={overrides.autoCreateMergeRequests}
                    systemValue={systemFlags.autoCreateMergeRequests}
                    onChange={(next) => setOverrides((prev) => ({ ...prev, autoCreateMergeRequests: next }))}
                  />
                </div>
              )}
            </fieldset>
          </FieldGroup>

          <DialogFooter className="shrink-0">
            <DialogClose asChild>
              <Button variant="secondary" size="sm" disabled={saving || startSaving}>
                取消
              </Button>
            </DialogClose>
            {mode === "edit" ? (
              <Button
                size="sm"
                disabled={!title.trim() || saving || loading}
                onClick={() => void save()}
              >
                {saving ? (
                  <Loader2Icon className="animate-spin-slow" size={12} />
                ) : (
                  <SaveIcon size={12} />
                )}
                {creating ? "创建" : "保存"}
              </Button>
            ) : (
              <Button
                size="sm"
                disabled={startSaving || loading || !taskId}
                onClick={() => void startTask(false)}
              >
                {startSaving ? (
                  <Loader2Icon className="animate-spin-slow" size={12} />
                ) : (
                  <StartIcon size={12} />
                )}
                {startButtonLabel}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {mode === "start" && (
        <AlertDialog open={confirmingAll} onOpenChange={setConfirmingAll}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>使用系统配置的全部仓库？</AlertDialogTitle>
              <AlertDialogDescription>
                未选择任何仓库，任务启动时会自动 attach 系统配置的全部 {repositories.length} 个仓库。
                <br />
                后续可随时在任务详情调整关联。
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>返回选择</AlertDialogCancel>
              <AlertDialogAction onClick={() => { setConfirmingAll(false); void startTask(true); }}>
                <CheckIcon size={11} />
                确认启动
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </>
  );
}
