import { execa } from "execa";

/**
 * 唤起外部编辑器打开工作区。
 *
 * - macOS:用 `open -a <App> <paths>` 让 LaunchServices 找到已安装的 app。
 * - 其他平台:直接调 `code` / `qoder` CLI,要求用户把 CLI 装到 PATH。
 */
export async function openTaskEditor(editor: "vscode" | "qoder", worktreePaths: string[], platform: NodeJS.Platform = process.platform): Promise<void> {
  if (worktreePaths.length === 0) throw new Error("任务未关联代码仓库");
  if (platform === "darwin") {
    await execa("/usr/bin/open", ["-a", editor === "vscode" ? "Visual Studio Code" : "Qoder", ...worktreePaths]);
  } else {
    await execa(editor === "vscode" ? "code" : "qoder", worktreePaths);
  }
}
