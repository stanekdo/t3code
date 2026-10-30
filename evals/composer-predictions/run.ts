// @effect-diagnostics nodeBuiltinImport:off
import * as NodeUtil from "node:util";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CodexSettings,
  DEFAULT_TEXT_GENERATION_MODEL,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ServerConfig from "../../apps/server/src/config.ts";
import { makeCodexTextGeneration } from "../../apps/server/src/textGeneration/CodexTextGeneration.ts";
import { cases } from "./cases.ts";

const { values } = NodeUtil.parseArgs({
  options: {
    out: { type: "string" },
    model: { type: "string", default: DEFAULT_TEXT_GENERATION_MODEL },
    baseline: { type: "string" },
    case: { type: "string" },
    samples: { type: "string", default: "3" },
  },
});
if (!values.out) throw new Error("Use --out <directory>.");
const outputDirectory = values.out;
const samples = Number(values.samples);
if (!Number.isInteger(samples) || samples < 1 || samples > 10) throw new Error("Use 1–10 samples.");
const selectedCases = cases.filter(
  (entry) => !values.case || values.case.split(",").includes(entry.id),
);
if (selectedCases.length === 0) throw new Error("No matching cases.");
const decodeSettings = Schema.decodeUnknownEffect(CodexSettings);
const encodeReport = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

await Effect.runPromise(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-prediction-eval-" });
    const generation = yield* makeCodexTextGeneration(yield* decodeSettings({}));
    const baseline = values.baseline ? yield* fs.readFileString(values.baseline) : null;
    const results = [];
    for (const fixture of selectedCases) {
      for (let sample = 0; sample < samples; sample += 1) {
        const generated = yield* generation.generatePromptSuggestion!({
          cwd,
          messages: fixture.messages,
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: values.model,
            options: [{ id: "reasoningEffort", value: "low" }],
          },
        });
        results.push({
          id: fixture.id,
          sample,
          source: fixture.source,
          rubric: fixture.rubric,
          suggestion: generated.suggestion,
          passed: null,
        });
      }
    }
    yield* fs.makeDirectory(outputDirectory, { recursive: true });
    yield* fs.writeFileString(
      path.join(outputDirectory, "results.json"),
      yield* encodeReport({
        model: values.model,
        samples,
        results,
        baseline,
        cost: "Codex subscription usage; CLI does not expose a monetary cost for these requests.",
        review: "Score each rubric manually. A case fails when at least half its samples fail.",
      }),
    );
    yield* Effect.log(`Wrote ${results.length} samples to ${outputDirectory}/results.json.`);
  }).pipe(
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-prediction-eval-state-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
    Effect.scoped,
  ),
);
