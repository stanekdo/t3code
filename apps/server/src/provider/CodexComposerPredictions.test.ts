import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { CodexSettings } from "@t3tools/contracts";
import { writeFakeCli } from "@t3tools/provider-testing/fakeCli";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";

import {
  CodexPredictionQuotaExemption,
  makeCodexComposerPredictions,
} from "./CodexComposerPredictions.ts";
import { makeProcessProbe, processProbeSource } from "../testUtils/processProbe.ts";

const remoteConfig = {
  is_enabled: true,
  prompt: "Fixture native prediction prompt.",
  prompt_version: "fixture-5",
  prediction_reasoning_effort: "high",
  unsupported_models: ["unsupported"],
};
const NativeRequests = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      method: Schema.String,
      params: Schema.optionalKey(Schema.Unknown),
    }),
  ),
);
const decodeCodexSettings = Schema.decodeEffect(CodexSettings);
const decodeNativeRequests = Schema.decodeUnknownEffect(NativeRequests);

const withFixture = Effect.fn("CodexComposerPredictionsTest.withFixture")(function* (
  options: {
    quotaExempt?: boolean;
    enabled?: boolean;
    version?: string;
    accountType?: "chatgpt" | "apiKey";
    model?: string;
    modelProvider?: string;
    mode?: string;
    config?: unknown;
    configStatus?: number;
    text?: string | null;
    sourceTurnId?: string;
    sampleError?: boolean;
    hangSample?: number;
    managedRuntime?: boolean;
  } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-native-predictions-" });
  const requestsPath = path.join(directory, "requests.json");
  const binaryPath = writeFakeCli({
    directory: path.join(directory, "bin"),
    name: "codex",
    source: `
import * as fs from "node:fs";
import * as readline from "node:readline";
const options = ${JSON.stringify(options)};
const requestsPath = ${JSON.stringify(requestsPath)};
const requests = [];
if (!process.argv.includes("app-server") || process.argv.includes("exec")) process.exit(77);
const token = Buffer.from(JSON.stringify({alg:"none"})).toString("base64url") + "." +
  Buffer.from(JSON.stringify({"https://api.openai.com/auth":{chatgpt_account_id:"fixture-account"}})).toString("base64url") + ".fixture";
for await (const line of readline.createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  requests.push({method: request.method, params: request.params});
  fs.writeFileSync(requestsPath, JSON.stringify(requests));
  if (request.id === undefined) continue;
  let result;
  switch (request.method) {
    case "initialize": result = {codexHome: ${JSON.stringify(directory)}, platformFamily:"windows", platformOs:"windows", userAgent:"codex/" + (options.version ?? "0.166.0")}; break;
    case "account/read": result = {requiresOpenaiAuth:true, account: options.accountType === "apiKey" ? {type:"apiKey"} : {type:"chatgpt", email:"fixture@example.invalid", planType:"pro"}}; break;
    case "getAuthStatus": result = {authMethod:"chatgpt", authToken:token, requiresOpenaiAuth:true}; break;
    case "thread/resume": result = {thread:{id:"native-thread"}, model:options.model ?? "gpt-6.1-sol", modelProvider:options.modelProvider ?? "openai", collaborationMode:{mode:options.mode ?? "default"}}; break;
    case "thread/sample":
      if (options.hangSample !== undefined) {
        ${options.hangSample === undefined ? "" : processProbeSource(options.hangSample)}
        await new Promise(() => {});
      }
      if (options.sampleError) {
        process.stdout.write(JSON.stringify({id:request.id,error:{code:-32601,message:"unsupported"}}) + "\\n");
        continue;
      }
      result = {sourceTurnId:options.sourceTurnId ?? "native-turn", responseId:"fixture-response", text:options.text === undefined ? JSON.stringify({suggestion:"Add a regression test."}) : options.text};
      break;
    default: process.exit(78);
  }
  process.stdout.write(JSON.stringify({id:request.id,result}) + "\\n");
}
`,
  });
  let httpCalls = 0;
  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      httpCalls += 1;
      expect(request.url).toBe("https://chatgpt.com/backend-api/wham/predictions/config");
      expect(request.headers["chatgpt-account-id"]).toBe("fixture-account");
      return HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify(options.config ?? remoteConfig), {
          status: options.configStatus ?? 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }),
  );
  const config = yield* decodeCodexSettings({
    enabled: options.enabled ?? true,
    promptSuggestions: true,
    binaryPath,
    homePath: directory,
  });
  const environment = { ...process.env, CODEX_HOME: directory };
  const make = makeCodexComposerPredictions(
    options.managedRuntime
      ? { ...config, binaryPath: "must-not-launch-configured-binary" }
      : config,
    environment,
    options.managedRuntime
      ? Effect.succeed({ config, environment, revision: "fixture" })
      : undefined,
  ).pipe(Effect.provideService(HttpClient.HttpClient, http));
  const request = yield* options.quotaExempt === undefined
    ? make
    : make.pipe(Effect.provideService(CodexPredictionQuotaExemption, options.quotaExempt));
  const result = yield* request({
    cwd: directory,
    nativeThreadId: "native-thread",
    nativeTurnId: "native-turn",
  });
  const requests = (yield* fs.exists(requestsPath))
    ? yield* fs.readFileString(requestsPath).pipe(Effect.flatMap(decodeNativeRequests))
    : [];
  return { result, requests, httpCalls };
});

describe("CodexComposerPredictions", () => {
  it.effect.each([false, true])(
    "blocks all native and HTTP requests when the quota policy is disabled (managed: %s)",
    (managedRuntime) =>
      Effect.gen(function* () {
        const fixture = yield* withFixture({ managedRuntime, quotaExempt: false });
        expect(fixture).toEqual({ result: null, requests: [], httpCalls: 0 });
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect.each([false, true])(
    "uses native source context and prediction purpose without a coding-turn fallback (managed: %s)",
    (managedRuntime) =>
      Effect.gen(function* () {
        const fixture = yield* withFixture({
          managedRuntime,
          text: JSON.stringify({ suggestion: "  Přidej test pro zrušení.  " }),
        });
        expect(fixture.result).toBe("Přidej test pro zrušení.");
        expect(fixture.httpCalls).toBe(1);
        expect(fixture.requests.map((request) => request.method)).toEqual([
          "initialize",
          "initialized",
          "account/read",
          "getAuthStatus",
          "thread/resume",
          "thread/sample",
        ]);
        expect(fixture.requests.at(-1)?.params).toMatchObject({
          threadId: "native-thread",
          expectedTurnId: "native-turn",
          effort: "high",
          threadSource: "composer_predictions",
          turnTrigger: "composer_predictions",
          disableMcp: true,
          responsesapiClientMetadata: {
            prediction_source_thread_id: "native-thread",
            prediction_source_turn_id: "native-turn",
            prediction_trigger: "catch_up",
          },
          prompt: expect.stringContaining(remoteConfig.prompt),
        });
        expect(fixture.requests.at(-1)?.params).not.toHaveProperty("model");
        expect(fixture.requests[0]?.params).toMatchObject({ clientInfo: { name: "T3 Code" } });
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect.each([
    { enabled: false },
    { version: "0.160.0" },
    { accountType: "apiKey" as const },
    { config: { ...remoteConfig, is_enabled: false } },
    { config: { malformed: true } },
    { configStatus: 403 },
    { config: { ...remoteConfig, catch_up_sample_rate: 0 } },
    { model: "unsupported" },
    { modelProvider: "custom" },
    { mode: "plan" },
  ])("does not sample an ineligible source or account: %j", (options) =>
    Effect.gen(function* () {
      const fixture = yield* withFixture({ quotaExempt: true, ...options });
      expect(fixture.result).toBeNull();
      expect(fixture.requests.some((request) => request.method === "thread/sample")).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect.each([
    { sampleError: true },
    { sourceTurnId: "stale-turn" },
    { text: null },
    { text: "invalid JSON" },
    ...[null, "", "   ", "first\nsecond", "run\u0000command", "x".repeat(241)].map(
      (suggestion) => ({ text: JSON.stringify({ suggestion }) }),
    ),
  ])("discards unavailable, stale, or malformed native results without fallback: %j", (options) =>
    Effect.gen(function* () {
      const fixture = yield* withFixture({ quotaExempt: true, ...options });
      expect(fixture.result).toBeNull();
      expect(fixture.requests.filter((request) => request.method === "thread/sample")).toHaveLength(
        1,
      );
      expect(
        fixture.requests.some((request) =>
          ["thread/start", "thread/fork", "turn/start"].includes(request.method),
        ),
      ).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("cancels the owned native sample process when its viewer leaves", () =>
    Effect.gen(function* () {
      const probe = yield* makeProcessProbe;
      const fiber = yield* withFixture({ quotaExempt: true, hangSample: probe.port }).pipe(
        Effect.forkScoped,
      );
      yield* probe.started;
      yield* Fiber.interrupt(fiber);
      yield* probe.exited;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("bounds a stalled native sample and closes its process without retrying", () =>
    Effect.gen(function* () {
      const probe = yield* makeProcessProbe;
      const fiber = yield* withFixture({ quotaExempt: true, hangSample: probe.port }).pipe(
        Effect.forkScoped,
      );
      yield* probe.started;
      yield* TestClock.adjust("30 seconds");
      const fixture = yield* Fiber.join(fiber);
      yield* probe.exited;
      expect(fixture.result).toBeNull();
      expect(fixture.requests.filter((request) => request.method === "thread/sample")).toHaveLength(
        1,
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
