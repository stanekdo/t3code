import { describe, expect, it } from "vite-plus/test";
import { isNightlyDesktopVersion } from "./updateChannels.ts";

describe("desktop release identity", () => {
  it.each([
    ["0.1.6-nightly.20261030.3917", true],
    ["0.1.6-nightly.20261030.3917.patched.2", true],
    ["0.1.6-preview.20261030.3917", true],
    ["0.1.6", false],
    ["0.1.6-nightly.20261030.3917.patched.invalid", false],
  ] as const)("classifies %s without changing its profile", (version, expected) => {
    expect(isNightlyDesktopVersion(version)).toBe(expected);
  });
});
