import { RunId } from "@t3tools/contracts";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { expect, it, vi } from "vite-plus/test";
import { DraftId } from "../../composerDraftStore";
import { composerCommandKeyHandler } from "./composerCommandKey";

function setup(prompt = "", menuOpen = false) {
  const submit = vi.fn();
  const change = vi.fn();
  const dismiss = vi.fn();
  const promptRef = { current: prompt };
  const handler = composerCommandKeyHandler({
    keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
    sendShortcut: "enter",
    routeKind: "server",
    phase: "ready",
    isCompacting: false,
    followUpBehavior: "queue",
    isSoftwareKeyboardOpen: false,
    planModeUiEnabled: false,
    isLiteralPendingAnswer: false,
    pendingUserInputs: [],
    promptHistoryMessages: [],
    promptHistoryPositionRef: { current: null },
    composerDraftTarget: DraftId.make("draft-test"),
    promptRef,
    composerImagesRef: { current: [] },
    composerFilesRef: { current: [] },
    composerTerminalContextsRef: { current: [] },
    composerPreviewAnnotations: [],
    composerReviewComments: [],
    composerEditorRef: { current: null },
    composerMenuOpenRef: { current: menuOpen },
    composerMenuItemsRef: { current: [] },
    activeComposerMenuItemRef: { current: null },
    setComposerDraftPrompt: change,
    setComposerCursor: () => {},
    setComposerTrigger: () => {},
    setComposerHighlightedItemId: () => {},
    dismissComposerTrigger: () => {},
    toggleInteractionMode: () => {},
    nudgeComposerMenuHighlight: () => {},
    onSelectComposerItem: () => {},
    resolveActiveComposerTrigger: () => ({ trigger: null }),
    readComposerSnapshot: () => ({ value: promptRef.current }),
    applyPromptReplacement: () => false,
    submitComposer: submit,
    promptSuggestion: { id: "prediction-1", runId: RunId.make("run-1"), text: "Add tests." },
    onDismissPromptSuggestion: dismiss,
  });
  return { handler, submit, change, dismiss, promptRef };
}

it.each(["Tab", "ArrowRight"])("accepts %s as an editable draft, never a submission", (key) => {
  const { handler, submit, change, promptRef } = setup();
  expect(handler(key, new KeyboardEvent("keydown", { key }))).toBe(true);
  expect(promptRef.current).toBe("Add tests.");
  expect(change).toHaveBeenCalledWith(DraftId.make("draft-test"), "Add tests.");
  expect(submit).not.toHaveBeenCalled();
});

it("dismisses on Escape without editing or sending", () => {
  const { handler, submit, change, dismiss } = setup();
  expect(handler("Escape", new KeyboardEvent("keydown", { key: "Escape" }))).toBe(true);
  expect(dismiss).toHaveBeenCalledWith("prediction-1");
  expect(change).not.toHaveBeenCalled();
  expect(submit).not.toHaveBeenCalled();
});

it.each([
  { draft: "Existing draft", menu: false, composing: false, shift: false },
  { draft: "", menu: true, composing: false, shift: false },
  { draft: "", menu: false, composing: true, shift: false },
  { draft: "", menu: false, composing: false, shift: true },
])("does not replace a draft or consume menus/composition/modifiers: %j", (input) => {
  const { handler, submit, change, promptRef } = setup(input.draft, input.menu);
  handler(
    "Tab",
    new KeyboardEvent("keydown", {
      key: "Tab",
      isComposing: input.composing,
      shiftKey: input.shift,
    }),
  );
  expect(promptRef.current).toBe(input.draft);
  expect(change).not.toHaveBeenCalled();
  expect(submit).not.toHaveBeenCalled();
});
