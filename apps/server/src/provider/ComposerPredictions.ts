import {
  CodexSettings,
  latestProviderTurnForAttempt,
  type PromptSuggestion,
  type PromptSuggestionSubscribeInput,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ProjectService from "../project/ProjectService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProviderInstances from "./ProviderInstanceRegistry.ts";
import * as PromptSuggestions from "./PromptSuggestions.ts";

const decodeCodexSettings = Schema.decodeUnknownEffect(CodexSettings);

interface PredictionLease {
  readonly runId: RunId;
  readonly threadId: ThreadId;
  subscribers: number;
  finished: boolean;
  cancelled: boolean;
  fiber: Fiber.Fiber<void> | undefined;
}

export const makePredictionController = Effect.fn("ComposerPredictions.makeController")(
  function* (callbacks: {
    readonly request: (input: { threadId: ThreadId; runId: RunId }) => Effect.Effect<string | null>;
    readonly publish: (
      threadId: ThreadId,
      suggestion: PromptSuggestion | null,
    ) => Effect.Effect<void>;
  }) {
    const scope = yield* Effect.scope;
    const permits = yield* Semaphore.make(2);
    const pending = new Map<ThreadId, PredictionLease>();
    const completed = new Map<ThreadId, RunId>();

    const cancel = Effect.fn("ComposerPredictions.cancel")(function* (entry: PredictionLease) {
      entry.cancelled = true;
      if (pending.get(entry.threadId) === entry) pending.delete(entry.threadId);
      if (entry.fiber !== undefined) yield* Fiber.interrupt(entry.fiber);
    });

    const acquire = Effect.fn("ComposerPredictions.acquire")(function* (
      input: PromptSuggestionSubscribeInput,
    ) {
      const existing = pending.get(input.threadId);
      if (existing !== undefined && existing.runId === input.runId) {
        existing.subscribers += 1;
        return existing;
      }
      if (existing !== undefined) yield* cancel(existing);
      if (input.runId === undefined) {
        yield* callbacks.publish(input.threadId, null);
        return;
      }
      if (completed.get(input.threadId) === input.runId) return;
      const entry: PredictionLease = {
        threadId: input.threadId,
        runId: input.runId,
        subscribers: 1,
        finished: false,
        cancelled: false,
        fiber: undefined,
      };
      pending.set(input.threadId, entry);
      yield* callbacks.publish(input.threadId, null);
      entry.fiber = yield* permits
        .withPermits(1)(
          Effect.gen(function* () {
            const text = yield* callbacks.request({ threadId: entry.threadId, runId: entry.runId });
            if (entry.cancelled || pending.get(entry.threadId) !== entry) return;
            yield* callbacks.publish(
              entry.threadId,
              text === null
                ? null
                : {
                    id: `${entry.runId}:codex-prediction`,
                    runId: entry.runId,
                    text,
                  },
            );
          }),
        )
        .pipe(
          Effect.ensuring(
            Effect.gen(function* () {
              entry.finished = true;
              if (entry.cancelled) return;
              completed.set(entry.threadId, entry.runId);
              if (completed.size > 128) {
                const oldest = completed.keys().next().value;
                if (oldest !== undefined) {
                  completed.delete(oldest);
                  yield* callbacks.publish(oldest, null);
                }
              }
            }),
          ),
          Effect.forkIn(scope, { startImmediately: true }),
        );
      return entry;
    });

    const release = Effect.fn("ComposerPredictions.release")(function* (
      entry: PredictionLease | undefined,
    ) {
      if (entry === undefined) return;
      entry.subscribers -= 1;
      if (entry.subscribers > 0) return;
      if (!entry.finished) yield* cancel(entry);
      else if (pending.get(entry.threadId) === entry) pending.delete(entry.threadId);
    });

    return { acquire, release };
  },
);

export class ComposerPredictions extends Context.Reference<{
  readonly stream: (
    input: PromptSuggestionSubscribeInput,
  ) => Stream.Stream<PromptSuggestion | null>;
}>("t3/provider/ComposerPredictions", {
  defaultValue: () => ({ stream: () => Stream.make(null) }),
}) {}

const make = Effect.gen(function* () {
  const suggestions = yield* PromptSuggestions.PromptSuggestions;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const instances = yield* ProviderInstances.ProviderInstanceRegistry;
  const settings = yield* ServerSettings.ServerSettingsService;

  const request = Effect.fn("ComposerPredictions.request")(
    function* (input: { threadId: ThreadId; runId: RunId }) {
      const shell = yield* threads.getThreadShell(input.threadId);
      if (
        shell === null ||
        shell.latestRunId !== input.runId ||
        shell.activeRunId !== null ||
        shell.interactionMode === "plan" ||
        shell.delegatedFrom != null
      )
        return null;
      const serverSettings = yield* settings.getSettings;
      const config = yield* decodeCodexSettings(
        serverSettings.providerInstances[shell.providerInstanceId]?.config ?? {},
      );
      if (!config.promptSuggestions) return null;
      const instance = yield* instances.getInstance(shell.providerInstanceId);
      const generate = instance?.requestPromptSuggestion;
      if (generate === undefined) return null;
      const { projection } = yield* threads.getThreadSnapshotWindow(input.threadId, {
        rowLimit: 32,
        userTurnLimit: 4,
      });
      const run = projection.runs.find((run) => run.id === input.runId);
      if (run?.status !== "completed" || run.providerInstanceId !== shell.providerInstanceId)
        return null;
      const attempt = projection.attempts
        .filter((attempt) => attempt.runId === input.runId)
        .reduce<(typeof projection.attempts)[number] | undefined>(
          (latest, attempt) =>
            latest === undefined || attempt.attemptOrdinal > latest.attemptOrdinal
              ? attempt
              : latest,
          undefined,
        );
      if (attempt?.status !== "completed") return null;
      const providerThread = projection.providerThreads.find(
        (thread) => thread.id === attempt.providerThreadId,
      );
      const providerTurn = latestProviderTurnForAttempt(
        projection.providerTurns.filter(
          (turn) => turn.providerThreadId === attempt.providerThreadId,
        ),
        attempt.id,
      );
      const nativeThreadId = attempt.nativeThreadId ?? providerThread?.nativeThreadRef?.nativeId;
      const nativeTurnId = providerTurn?.nativeTurnRef?.nativeId;
      if (
        !nativeThreadId ||
        !nativeTurnId ||
        providerTurn?.status !== "completed" ||
        providerThread?.nativeThreadRef?.nativeId !== nativeThreadId ||
        providerThread.providerInstanceId !== shell.providerInstanceId
      )
        return null;
      const project = yield* projects.getShell(shell.projectId);
      if (Option.isNone(project)) return null;
      const result = yield* generate({
        cwd: shell.worktreePath ?? project.value.workspaceRoot,
        nativeThreadId,
        nativeTurnId,
      });
      const current = yield* threads.getThreadShell(input.threadId);
      const currentSettings = yield* settings.getSettings;
      const currentConfig = yield* decodeCodexSettings(
        currentSettings.providerInstances[shell.providerInstanceId]?.config ?? {},
      );
      return current !== null &&
        current.latestRunId === input.runId &&
        current.activeRunId === null &&
        current.providerInstanceId === shell.providerInstanceId &&
        currentConfig.promptSuggestions
        ? result
        : null;
    },
    Effect.orElseSucceed(() => null),
  );

  const controller = yield* makePredictionController({ request, publish: suggestions.publish });
  const stream = (input: PromptSuggestionSubscribeInput) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const shell = yield* threads.getThreadShell(input.threadId);
        if (shell === null) return Stream.make(null);
        const serverSettings = yield* settings.getSettings;
        const driver =
          serverSettings.providerInstances[shell.providerInstanceId]?.driver ??
          shell.providerInstanceId;
        if (driver !== "codex") return suggestions.stream(input.threadId);
        yield* Effect.acquireRelease(controller.acquire(input), controller.release);
        return suggestions.stream(input.threadId);
      }).pipe(Effect.orElseSucceed(() => Stream.make(null))),
    );

  return ComposerPredictions.of({ stream });
});

export const layer = Layer.effect(ComposerPredictions, make);
