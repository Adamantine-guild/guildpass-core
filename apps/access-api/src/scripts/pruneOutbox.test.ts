import { parseRetentionDays } from "./pruneOutbox";

describe("parseRetentionDays", () => {
  test("defaults to seven days", () => {
    expect(parseRetentionDays([], undefined)).toBe(7);
  });

  test("accepts --days value and equals forms", () => {
    expect(parseRetentionDays(["--days", "14"], undefined)).toBe(14);
    expect(parseRetentionDays(["--days=0.5"], undefined)).toBe(0.5);
  });

  test("uses OUTBOX_RETENTION_DAYS when the flag is omitted", () => {
    expect(parseRetentionDays([], "30")).toBe(30);
  });

  test("the CLI flag takes precedence over the environment", () => {
    expect(parseRetentionDays(["--days=2"], "30")).toBe(2);
  });

  test.each([
    [["--days"], undefined],
    [["--days", "0"], undefined],
    [["--days=-1"], undefined],
    [["--days=not-a-number"], undefined],
    [["--unknown"], undefined],
  ] as const)("rejects invalid arguments %j", (argv, envValue) => {
    expect(() => parseRetentionDays([...argv], envValue)).toThrow();
  });
});
