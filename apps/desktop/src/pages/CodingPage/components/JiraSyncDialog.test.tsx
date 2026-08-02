import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
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
  jiraKey: "OPS-13",
  title: "Confirm before import",
  description: "",
  keywords: [],
  acceptanceCriteria: []
};

describe("JiraSyncDialog", () => {
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

    fireEvent.click(await screen.findByRole("button", { name: "导入 1 项" }));

    await waitFor(() => expect(mocks.importJiraTasks).toHaveBeenCalledWith([candidate]));
    expect(onImported).toHaveBeenCalledOnce();
  });
});
