import { describe, expect, it } from "vitest";
import { parseChannelInput, aliasKey } from "@/server/youtube/resolver";

const UC = "UCSkce29rCKQIIQVOKKuihmk";

describe("parseChannelInput", () => {
  it.each([
    [UC, { kind: "id", value: UC }],
    ["@EmberDev", { kind: "handle", value: "emberdev" }],
    ["https://www.youtube.com/@EmberDev", { kind: "handle", value: "emberdev" }],
    ["youtube.com/@emberdev/videos", { kind: "handle", value: "emberdev" }],
    ["m.youtube.com/@emberdev", { kind: "handle", value: "emberdev" }],
    [`https://youtube.com/channel/${UC}`, { kind: "id", value: UC }],
    [`https://www.youtube.com/channel/${UC}/featured`, { kind: "id", value: UC }],
    ["https://www.youtube.com/user/oldname", { kind: "username", value: "oldname" }],
    ["https://www.youtube.com/c/CustomName", { kind: "custom", value: "CustomName" }],
    ["https://www.youtube.com/CustomName", { kind: "custom", value: "CustomName" }],
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10s", { kind: "video", value: "dQw4w9WgXcQ" }],
    ["https://youtu.be/dQw4w9WgXcQ?si=abc", { kind: "video", value: "dQw4w9WgXcQ" }],
    ["https://www.youtube.com/shorts/dQw4w9WgXcQ", { kind: "video", value: "dQw4w9WgXcQ" }],
    ["https://www.youtube.com/live/dQw4w9WgXcQ", { kind: "video", value: "dQw4w9WgXcQ" }],
    ["https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ", { kind: "video", value: "dQw4w9WgXcQ" }],
    ["emberdev", { kind: "ambiguous", value: "emberdev" }],
    ["  @handle.with-dots_1  ", { kind: "handle", value: "handle.with-dots_1" }],
  ])("%s", (input, expected) => {
    expect(parseChannelInput(input)).toEqual(expected);
  });

  it.each(["", "   ", "@a", "https://vimeo.com/123", "https://www.youtube.com/watch?v=short", "https://www.youtube.com/channel/notanid", "x".repeat(400), "https://www.youtube.com/playlist?list=PL123"])(
    "rejects %j",
    (input) => {
      expect(parseChannelInput(input).kind).toBe("invalid");
    },
  );

  it("builds alias keys", () => {
    expect(aliasKey(parseChannelInput("@Foo_Bar"))).toBe("handle:foo_bar");
    expect(aliasKey(parseChannelInput("youtube.com/c/Foo"))).toBe("custom:foo");
    expect(aliasKey(parseChannelInput("youtube.com/user/Foo"))).toBe("user:foo");
    expect(aliasKey(parseChannelInput("https://youtu.be/dQw4w9WgXcQ"))).toBeNull();
  });
});
