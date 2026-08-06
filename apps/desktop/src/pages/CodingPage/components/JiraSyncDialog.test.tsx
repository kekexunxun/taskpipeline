import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { JiraSyncDialog } from "./JiraSyncDialog";

const mocks = vi.hoisted(() => ({
  syncJiraTasks: vi.fn(),
  importJiraTasks: vi.fn()
}));

vi.mock("@/api", () => ({
  api: {
    syncJiraTasks: mocks.syncJiraTasks,
    importJiraTasks: mocks.importJiraTasks
  }
}));

const candidate = {
  taskKey: "OPS-13",
  source: "jira",
  title: "Confirm before import",
  description: "",
  keywords: [],
  acceptanceCriteria: []
};

describe("JiraSyncDialog", () => {
  beforeEach(() => {
    mocks.syncJiraTasks.mockClear();
    mocks.importJiraTasks.mockClear();
  });

  it("only reads candidates when the dialog opens", async () => {
    mocks.syncJiraTasks.mockResolvedValueOnce([candidate]);
    render(
      <JiraSyncDialog
        open
        onOpenChange={vi.fn()}
        onImported={vi.fn()}
      />
    );

    expect(await screen.findByText(candidate.title)).toBeInTheDocument();
    expect(mocks.syncJiraTasks).toHaveBeenCalledOnce();
    expect(mocks.importJiraTasks).not.toHaveBeenCalled();
  });

  it("leaves all candidates unchecked by default", async () => {
    mocks.syncJiraTasks.mockResolvedValueOnce([candidate]);
    render(
      <JiraSyncDialog
        open
        onOpenChange={vi.fn()}
        onImported={vi.fn()}
      />
    );

    await screen.findByText(candidate.title);
    expect(screen.getByRole("checkbox")).not.toBeChecked();
    expect(screen.getByRole("button", { name: /导入/ })).toBeDisabled();
  });

  it("imports selected candidates only after confirmation", async () => {
    mocks.syncJiraTasks.mockResolvedValueOnce([candidate]);
    mocks.importJiraTasks.mockResolvedValueOnce([]);
    const onImported = vi.fn();
    render(
      <JiraSyncDialog
        open
        onOpenChange={vi.fn()}
        onImported={onImported}
      />
    );

    await screen.findByText(candidate.title);
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "导入 1 项" }));

    await waitFor(() => expect(mocks.importJiraTasks).toHaveBeenCalledWith([candidate]));
    expect(onImported).toHaveBeenCalledOnce();
  });

  it("asks for confirmation before overwriting a conflicting task", async () => {
    const conflicting = { ...candidate, existing: true, conflict: true };
    mocks.syncJiraTasks.mockResolvedValueOnce([conflicting]);
    mocks.importJiraTasks.mockResolvedValueOnce([]);
    const onImported = vi.fn();
    render(
      <JiraSyncDialog
        open
        onOpenChange={vi.fn()}
        onImported={onImported}
      />
    );

    await screen.findByText(conflicting.title);
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "导入 1 项" }));

    // 冲突任务先弹覆盖确认，不直接导入。
    expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
    expect(mocks.importJiraTasks).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "确认覆盖" }));
    await waitFor(() => expect(mocks.importJiraTasks).toHaveBeenCalledWith([conflicting]));
    expect(onImported).toHaveBeenCalledOnce();
  });
});
