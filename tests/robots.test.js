import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const load = name => new Function(`${readFileSync(new URL(`../src/functions/${name}.js`, import.meta.url), "utf8")}\nreturn ${name};`)();
const robotsAllowed = load("robotsAllowed");
const robotsUrl = load("robotsUrl");

describe("robots.txt check", () => {
  test("reads robots.txt from the URL's origin", () => {
    expect(robotsUrl("https://example.com:8443/a/b?c=1")).toBe("https://example.com:8443/robots.txt");
  });

  test.each([
    [404, "", "allows when robots.txt is missing", true],
    [403, "", "allows when robots.txt is refused", true],
    [429, "", "stops when robots.txt is rate limited", false],
    [503, "", "stops when robots.txt is unavailable", false],
  ])("status %i: %s", (status, body, _name, allowed) => {
    expect(robotsAllowed(status, body, "https://example.com/page")).toBe(allowed);
  });

  test.each([
    ["User-agent: *\nDisallow: /private", "/private/page", false],
    ["User-agent: *\nDisallow: /private", "/public", true],
    ["User-agent: *\nDisallow:", "/anything", true],
    ["User-agent: *\nDisallow: /\nAllow: /open", "/open/page", true],
    ["User-agent: *\nAllow: /a\nDisallow: /a", "/a", true],
    ["User-agent: *\nDisallow: /*.pdf$", "/files/doc.pdf", false],
    ["User-agent: *\nDisallow: /*.pdf$", "/files/doc.pdf?x=1", true],
    ["User-agent: *\nDisallow: /search?q=", "/search?q=x", false],
    ["User-agent: otherbot\nDisallow: /", "/page", true],
    ["User-agent: otherbot\nUser-agent: *\nDisallow: /", "/page", false],
    ["User-agent: *\nDisallow: /a\n\nUser-agent: *\nDisallow: /b", "/b", false],
    ["# comment\nUSER-AGENT: *  # all\nDISALLOW: /x # no", "/x/y", false],
    ["User-agent: *\r\nDisallow: /caf%C3%A9", "/café", false],
  ])("%j for %s", (body, path, allowed) => {
    expect(robotsAllowed(200, body, `https://example.com${path}`)).toBe(allowed);
  });

  test("functions fit Make's 5,000-character limit", () => {
    for (const name of ["robotsAllowed", "robotsUrl"]) {
      expect(readFileSync(new URL(`../src/functions/${name}.js`, import.meta.url), "utf8").length).toBeLessThanOrEqual(5000);
    }
  });
});
