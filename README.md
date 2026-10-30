# T3 Code with composer predictions

A Windows x64 nightly fork of [T3 Code](https://github.com/pingdotgg/t3code).

- **Claude Prompt Suggestions** uses Claude Code's native suggestion events, including compatible custom providers.
- **Codex Composer Predictions** predicts the next user message through the same Codex account. It uses a small additional subscription request, not the native Codex desktop prediction service. Codex remains the coding agent.

Get an installer from [Releases](https://github.com/stanekdo/t3code/releases). Builds are unsigned. Installing this fork replaces the matching official nightly installation; its desktop updater then follows this fork. The existing official installation does not change until you install a fork build.

Enable **Prompt suggestions** or **Composer predictions** for each provider in **Settings > Providers**. Tab or Right Arrow inserts the suggestion as an editable draft. Esc dismisses it. Nothing is sent automatically. Disable the setting to stop suggestions. Desktop and web are supported; mobile is not.

Codex predictions use bounded recent text, disable tools, time out, and cancel when the last viewer leaves. Suggestions stay in memory and are not added to conversation history. The optional **Prediction model** setting overrides the lightweight default without changing the coding model.

## How updates work

The [Patched nightly workflow](.github/workflows/patched-nightly.yml) checks hourly at minute 17, and can be run manually. It fetches the newest published official nightly, applies the feature branch's diff with a three-way patch, runs `check:changed`, builds Windows x64, checks the embedded update destination, and publishes a prerelease with checksums and the exact patch. Conflicts or failed checks stop publication; the previous release remains available. Published releases are not overwritten.

GitHub schedules can be delayed and are disabled after 60 days without repository activity. The workflow makes an empty maintenance commit after 30 quiet days to keep tracking active. If Actions is disabled manually or by GitHub, re-enable the workflow on the Actions page. No external scheduler or personal access token is required.

- `fork-builds` is the default branch and owns only fork maintenance changes.
- `feat/composer-predictions` owns the code patch. Merge `upstream/main` into it when the patch needs maintenance, resolve conflicts, run `vp run check:changed <official-nightly-tag>`, and push normally.
- `main` remains an upstream reference. Do not merge build-control files into the feature branch.

To build a specific official nightly:

```sh
gh workflow run patched-nightly.yml --repo stanekdo/t3code --ref fork-builds -f tag=<official-nightly-tag>
```

Keep the nightly version inside the app unchanged for updater ordering. The GitHub release tag adds `-patched`. Its tag points to the build-control commit; release notes identify the upstream commit, feature commit and exact patch that produced the binary. Keep local credentials and provider configuration out of the repository.

## Credits and license

T3 Code is by [pingdotgg and contributors](https://github.com/pingdotgg/t3code). The Claude ghost-text feature and patch/rebuild workflow are adapted from [danielyc/t3code](https://github.com/danielyc/t3code); the Claude source is based on commit [7c6d2d7](https://github.com/danielyc/t3code/commit/7c6d2d728caf4c6c6d2a5541428a8722614751e1). Upstream notices and the [MIT license](LICENSE) are retained. This fork is not an official T3 release.
