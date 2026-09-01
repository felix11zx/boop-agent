import { describe, expect, it } from "vitest";
import { matchesLinkedInDemoPrompt } from "../server/scripted-demo-replies.js";

describe("scripted demo replies", () => {
  it("matches natural LinkedIn browser demo prompts", () => {
    expect(matchesLinkedInDemoPrompt("Check my LinkedIn")).toBe(true);
    expect(matchesLinkedInDemoPrompt("Check my LinkedIn messages using the browser.")).toBe(true);
    expect(matchesLinkedInDemoPrompt("Can you use the browser to check my LinkedIn messages?")).toBe(
      true,
    );
  });

  it("does not intercept unrelated LinkedIn messages", () => {
    expect(matchesLinkedInDemoPrompt("Write a LinkedIn post for me")).toBe(false);
    expect(matchesLinkedInDemoPrompt("Who messaged me?")).toBe(false);
  });
});
