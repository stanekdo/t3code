import { describe, expect, it } from "@effect/vitest";
import { RunId, ThreadId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { makePredictionController } from "./ComposerPredictions.ts";

const threadId = ThreadId.make("thread-1");
const runId = RunId.make("run-1");

describe("ComposerPredictions", () => {
  it.effect("shares one prediction across clients and does not repeat a completed attempt", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const result = yield* Deferred.make<string | null>();
        let calls = 0;
        const published: Array<string | null> = [];
        const controller = yield* makePredictionController({
          request: () =>
            Effect.gen(function* () {
              calls += 1;
              yield* Deferred.succeed(started, undefined);
              return yield* Deferred.await(result);
            }),
          publish: (_threadId, suggestion) =>
            Effect.sync(() => {
              published.push(suggestion?.text ?? null);
            }),
        });
        const first = yield* controller.acquire({ threadId, runId });
        const second = yield* controller.acquire({ threadId, runId });
        yield* Deferred.await(started);
        expect(calls).toBe(1);
        yield* controller.release(first);
        yield* Deferred.succeed(result, "Add a cancellation test.");
        if (second?.fiber !== undefined) yield* Fiber.join(second.fiber);
        yield* controller.release(second);
        const returning = yield* controller.acquire({ threadId, runId });
        expect(returning).toBeUndefined();
        expect(calls).toBe(1);
        expect(published).toEqual([null, "Add a cancellation test."]);
      }),
    ),
  );

  it.effect("cancels an old request before a newer run can replace its suggestion", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const cancelled = yield* Deferred.make<void>();
        const blocked = yield* Deferred.make<string | null>();
        const published: Array<string | null> = [];
        const nextRunId = RunId.make("run-2");
        const controller = yield* makePredictionController({
          request: (input) =>
            input.runId === runId
              ? Effect.gen(function* () {
                  yield* Deferred.succeed(started, undefined);
                  return yield* Deferred.await(blocked);
                }).pipe(Effect.onInterrupt(() => Deferred.succeed(cancelled, undefined)))
              : Effect.succeed("Review the new change."),
          publish: (_threadId, suggestion) =>
            Effect.sync(() => {
              published.push(suggestion?.text ?? null);
            }),
        });
        yield* controller.acquire({ threadId, runId });
        yield* Deferred.await(started);
        const next = yield* controller.acquire({ threadId, runId: nextRunId });
        yield* Deferred.await(cancelled);
        yield* Deferred.succeed(blocked, "Stale suggestion.");
        if (next?.fiber !== undefined) yield* Fiber.join(next.fiber);
        expect(published).not.toContain("Stale suggestion.");
        expect(published.at(-1)).toBe("Review the new change.");
        yield* controller.release(next);
      }),
    ),
  );

  it.effect("cancels work when the last viewer leaves", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const cancelled = yield* Deferred.make<void>();
        const controller = yield* makePredictionController({
          request: () =>
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.onInterrupt(() => Deferred.succeed(cancelled, undefined)),
            ),
          publish: () => Effect.void,
        });
        const lease = yield* controller.acquire({ threadId, runId });
        yield* Deferred.await(started);
        yield* controller.release(lease);
        yield* Deferred.await(cancelled);
      }),
    ),
  );
});
