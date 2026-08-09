/**
 * index.ts 顶层有许多重副作用(new TaskStore / DockerToolRouter / 各种 Service),
 * 测试只关心 isSubagentProcess 这一守卫函数,所以先把重依赖 mock 掉,
 * 再动态 import,绕开 import 期间的 sqlite / docker 调用。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// === 重依赖 mock =============================================================

vi.mock("@task-pipeline/core", () => {
  const noop = () => undefined;
  const id = <T>(x: T) => x;
  return {
    TaskStore: class {
      getSetting = noop;
      setSetting = noop;
      addEvent = id;
      addApproval = id;
      resolveApproval = noop;
      getTask = () => undefined;
      updateTask = id;
      releaseLease = noop;
      acquireLease = () => true;
      listCards = () => [];
      listTasks = () => [];
      listTaskRepositories = () => [];
    },
    LocalFileKeyStore: class { resolve = id; }
  };
});

vi.mock("@task-pipeline/integrations", () => ({
  AtlassianClientFactory: class { create() { return {}; } },
  DeliveryService: class { constructor() {} },
  GitService: class {},
  McpClient: class { constructor() {} },
  MergeStatusRefresher: class { constructor() {} },
  OpenAICompatReviewer: class { constructor() {} },
  OpenCodeReviewService: class { constructor() {} },
  ReviewOrchestrator: class { constructor() {} },
  syncJiraTasks: async () => [],
  TaskCompleter: class { constructor() {} },
  TaskWorkflow: class { constructor() {} },
  testAtlassianConnection: async () => ({ ok: true, message: "ok" })
}));

vi.mock("./sandbox.js", () => ({
  DockerToolRouter: class { register() {} stop() {} check() {} activeCwd() { return ""; } }
}));

vi.mock("./permission.js", () => ({
  evaluatePermission: () => ({ action: "allow" })
}));

vi.mock("./plan-mode.js", () => ({
  PiAgentPlanModeProvider: class { runPlan = vi.fn() }
}));

// === 动态 import:必须放在 vi.mock 之后 =======================================

const indexModule = await import("./index.js");
const { isSubagentProcess } = indexModule as unknown as {
  isSubagentProcess: (pi: Pick<ExtensionAPI, "getFlag">) => boolean;
};

// === 测试辅助 ================================================================

/** 用一个能 stub `getFlag` 的最小 pi 替身。 */
function makePi(flag: { value: string | undefined }): Pick<ExtensionAPI, "getFlag"> {
  return {
    getFlag: (name: string) => (name === "subagent-nonce" ? flag.value : undefined)
  };
}

const originalEnv = process.env;
let savedPpid: number | undefined;
let originalSubagent: string | undefined;
let originalNonce: string | undefined;

beforeEach(() => {
  // 保存原 ppid(测试环境通常 process.ppid 是 test runner,远大于 1)
  savedPpid = process.ppid;
  // Node 进程上 ppid 是只读 getter,必须先 delete 再 define 才能修改
  delete (process as { ppid?: unknown }).ppid;
  Object.defineProperty(process, "ppid", { value: 99999, configurable: true, writable: true });
  originalSubagent = process.env.TASK_PIPELINE_SUBAGENT;
  originalNonce = process.env.TASK_PIPELINE_SUBAGENT_NONCE;
  process.env = { ...originalEnv };
});

afterEach(() => {
  delete (process as { ppid?: unknown }).ppid;
  if (savedPpid !== undefined) {
    Object.defineProperty(process, "ppid", { value: savedPpid, configurable: true, writable: true });
  }
  if (originalSubagent === undefined) delete process.env.TASK_PIPELINE_SUBAGENT;
  else process.env.TASK_PIPELINE_SUBAGENT = originalSubagent;
  if (originalNonce === undefined) delete process.env.TASK_PIPELINE_SUBAGENT_NONCE;
  else process.env.TASK_PIPELINE_SUBAGENT_NONCE = originalNonce;
  process.env = originalEnv;
});

function setSubagent(nonce: string | undefined): void {
  if (nonce === undefined) {
    delete process.env.TASK_PIPELINE_SUBAGENT;
    delete process.env.TASK_PIPELINE_SUBAGENT_NONCE;
  } else {
    process.env.TASK_PIPELINE_SUBAGENT = "1";
    process.env.TASK_PIPELINE_SUBAGENT_NONCE = nonce;
  }
}

// === 7 个守卫 case ===========================================================

describe("isSubagentProcess 三重身份校验", () => {
  it("case 1: env 标记 + ppid 正常 + flag nonce 一致 → 认作子进程", () => {
    const nonce = "a".repeat(32);
    setSubagent(nonce);
    expect(isSubagentProcess(makePi({ value: nonce }))).toBe(true);
  });

  it("case 2: env 标记未设(TASK_PIPELINE_SUBAGENT != '1') → 拒绝", () => {
    const nonce = "b".repeat(32);
    process.env.TASK_PIPELINE_SUBAGENT_NONCE = nonce; // 故意只设 nonce,不设标记
    expect(isSubagentProcess(makePi({ value: nonce }))).toBe(false);
  });

  it("case 3: ppid ≤ 1(孤儿进程 / init 收养)→ 拒绝", () => {
    delete (process as { ppid?: unknown }).ppid;
    Object.defineProperty(process, "ppid", { value: 1, configurable: true, writable: true });
    const nonce = "c".repeat(32);
    setSubagent(nonce);
    expect(isSubagentProcess(makePi({ value: nonce }))).toBe(false);
  });

  it("case 4: ppid = 0(理论不可能但守住)→ 拒绝", () => {
    delete (process as { ppid?: unknown }).ppid;
    Object.defineProperty(process, "ppid", { value: 0, configurable: true, writable: true });
    const nonce = "d".repeat(32);
    setSubagent(nonce);
    expect(isSubagentProcess(makePi({ value: nonce }))).toBe(false);
  });

  it("case 5: env 中 nonce 缺失 → 拒绝(防单独靠 env 标记蒙混)", () => {
    process.env.TASK_PIPELINE_SUBAGENT = "1";
    // 没设 TASK_PIPELINE_SUBAGENT_NONCE
    expect(isSubagentProcess(makePi({ value: "anything" }))).toBe(false);
  });

  it("case 6: flag nonce 与 env nonce 不一致(env 手动 set 绕过) → 拒绝", () => {
    setSubagent("env-nonce-aaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(isSubagentProcess(makePi({ value: "different-flag-nonce-bbbbbbbbbbbbbbbbbb" }))).toBe(false);
  });

  it("case 7: flag nonce 未传(pi 启动时漏传 --subagent-nonce) → 拒绝", () => {
    const nonce = "e".repeat(32);
    setSubagent(nonce);
    expect(isSubagentProcess(makePi({ value: undefined }))).toBe(false);
  });
});
