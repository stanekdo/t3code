import type { CodexSettings } from "@t3tools/contracts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { compareSemverVersions } from "@t3tools/shared/semver";
import { decodeJwt } from "jose";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Random from "effect/Random";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import { HttpClient, HttpClientRequest } from "effect/http";
import { ChildProcessSpawner } from "effect/process";

import type { CodexEffectiveRuntime } from "./CodexManagedRuntime.ts";
import { withCodexAppServerClient } from "./CodexProvider.ts";
import { resolveCodexLaunchArgs } from "./codexLaunchArgs.ts";

// Keep an internal kill switch without ever falling back to ordinary inference.
export const CodexPredictionQuotaExemption = Context.Reference<boolean>(
  "t3/provider/CodexPredictionQuotaExemption",
  { defaultValue: () => true },
);

const PredictionConfig = Schema.Struct({
  is_enabled: Schema.Boolean,
  prompt: Schema.NonEmptyString.check(Schema.isMaxLength(16_000)),
  prompt_version: Schema.NonEmptyString,
  prediction_reasoning_effort: Schema.String,
  unsupported_models: Schema.optionalKey(Schema.Array(Schema.String)),
  catch_up_sample_rate: Schema.optionalKey(
    Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  ),
});
const SampleResponse = Schema.Struct({
  sourceTurnId: Schema.String,
  responseId: Schema.String,
  text: Schema.NullOr(Schema.String.check(Schema.isMaxLength(16_384))),
});
const ParentThread = Schema.Struct({
  thread: Schema.Struct({ id: Schema.String }),
  model: Schema.String,
  modelProvider: Schema.String,
  collaborationMode: Schema.optionalKey(Schema.NullOr(Schema.Struct({ mode: Schema.String }))),
});
const Prediction = Schema.fromJsonString(
  Schema.Struct({ suggestion: Schema.NullOr(Schema.String) }),
);
const AccountClaims = Schema.Struct({
  "https://api.openai.com/auth": Schema.Struct({ chatgpt_account_id: Schema.NonEmptyString }),
});
const predictionResponseFormat =
  'Return only JSON matching this schema: {"type":"object","properties":{"suggestion":{"type":["string","null"]}},"required":["suggestion"],"additionalProperties":false}.';
const decodePredictionConfig = Schema.decodeUnknownEffect(PredictionConfig);
const decodeSampleResponse = Schema.decodeUnknownEffect(SampleResponse);
const decodeParentThread = Schema.decodeUnknownEffect(ParentThread);
const decodePrediction = Schema.decodeEffect(Prediction);
const decodeAccountClaims = Schema.decodeUnknownEffect(AccountClaims);

export const makeCodexComposerPredictions = Effect.fn("CodexComposerPredictions.make")(function* (
  config: CodexSettings,
  environment: NodeJS.ProcessEnv | undefined,
  resolveRuntime?: Effect.Effect<
    CodexEffectiveRuntime,
    import("@t3tools/contracts").ProviderSetupError,
    Scope.Scope
  >,
) {
  const quotaExempt = yield* CodexPredictionQuotaExemption;
  const http = yield* HttpClient.HttpClient;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const homeDirectory = yield* HostProcess.HomeDirectory;

  const request: NonNullable<ProviderInstance["requestPromptSuggestion"]> = Effect.fn(
    "CodexComposerPredictions.request",
  )(
    function* (input) {
      if (!quotaExempt || !config.enabled || !config.promptSuggestions) return null;
      const runtime = resolveRuntime ? yield* resolveRuntime : { config, environment };
      const { client, initialize } = yield* withCodexAppServerClient({
        binaryPath: runtime.config.binaryPath || "codex",
        homePath: runtime.config.homePath,
        launchArgs: resolveCodexLaunchArgs(runtime.config.launchArgs, runtime.environment),
        environment: runtime.environment,
        cwd: input.cwd,
      });
      const version = initialize.userAgent.match(/\/(\d+\.\d+\.\d+(?:-[\w.]+)?)/)?.[1];
      if (version === undefined || compareSemverVersions(version, "0.164.0") < 0) return null;
      const { account } = yield* client.request("account/read", {});
      if (account?.type !== "chatgpt") return null;
      const auth = yield* client.request("getAuthStatus", { includeToken: true });
      const token = auth.authToken;
      if (!token) return null;
      const claims = yield* Effect.try(() => decodeJwt(token)).pipe(
        Effect.flatMap(decodeAccountClaims),
      );
      const response = yield* http.execute(
        HttpClientRequest.get("https://chatgpt.com/backend-api/wham/predictions/config").pipe(
          HttpClientRequest.bearerToken(token),
          HttpClientRequest.setHeader(
            "ChatGPT-Account-Id",
            claims["https://api.openai.com/auth"].chatgpt_account_id,
          ),
        ),
      );
      if (response.status !== 200) return null;
      const predictionConfig = yield* response.json.pipe(Effect.flatMap(decodePredictionConfig));
      if (!predictionConfig.is_enabled) return null;
      const sampleRate = predictionConfig.catch_up_sample_rate ?? 1;
      if (sampleRate === 0 || (sampleRate < 1 && (yield* Random.next) >= sampleRate)) return null;
      const parent = yield* client.raw
        .request("thread/resume", {
          threadId: input.nativeThreadId,
          excludeTurns: true,
        })
        .pipe(Effect.flatMap(decodeParentThread));
      if (
        parent.thread.id !== input.nativeThreadId ||
        parent.modelProvider !== "openai" ||
        parent.collaborationMode?.mode === "plan" ||
        predictionConfig.unsupported_models?.includes(parent.model)
      )
        return null;
      const sample = yield* client.raw
        .request("thread/sample", {
          threadId: input.nativeThreadId,
          expectedTurnId: input.nativeTurnId,
          prompt: `${predictionConfig.prompt}\n\n${predictionResponseFormat}`,
          ...(predictionConfig.prediction_reasoning_effort
            ? { effort: predictionConfig.prediction_reasoning_effort }
            : {}),
          threadSource: "composer_predictions",
          turnTrigger: "composer_predictions",
          responsesapiClientMetadata: {
            prediction_source_thread_id: input.nativeThreadId,
            prediction_source_turn_id: input.nativeTurnId,
            prediction_trigger: "catch_up",
          },
          disableMcp: true,
        })
        .pipe(Effect.flatMap(decodeSampleResponse));
      if (sample.sourceTurnId !== input.nativeTurnId || sample.text === null) return null;
      const prediction = yield* decodePrediction(sample.text);
      const text = prediction.suggestion?.trim() ?? "";
      return text.length > 0 && text.length <= 240 && !/[\r\n\x00-\x1f]/.test(text) ? text : null;
    },
    Effect.scoped,
    Effect.timeout("30 seconds"),
    Effect.orElseSucceed(() => null),
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    Effect.provideService(FileSystem.FileSystem, fileSystem),
    Effect.provideService(Path.Path, path),
    Effect.provideService(HostProcess.HomeDirectory, homeDirectory),
  );
  return request;
});
