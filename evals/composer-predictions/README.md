# Composer prediction eval

Checks the real Codex prediction prompt for useful next-user messages, completed-task suppression, language preservation, and transcript injection resistance. Cases are synthetic; never add user conversations.

From `evals/`, run `pnpm composer-predictions --out runs/predictions --samples 3`. Use `--case finished-task --samples 1` for a smoke run, `--model <id>` to choose a model, or `--baseline runs/earlier/results.json` to retain a comparison alongside the candidate.

Uses the existing Codex subscription, not an API key. The default is the lightweight text-generation model; requests consume normal subscription usage. The CLI does not report a monetary cost. Review each output against its rubric in `results.json`; a case fails when at least half its samples fail. Compare on the same model. Results are ignored by Git.
