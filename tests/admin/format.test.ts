import { expect, test } from "bun:test";

const globals = globalThis as Record<string, unknown>;
globals.document ??= { querySelector: () => null, querySelectorAll: () => [] };
globals.window ??= { location: { origin: "http://localhost" } };
globals.localStorage ??= { getItem: () => null };

const { formatCompact } = await import("../../public/admin/app-format.js");

test("formats token counts into billions and trillions", () => {
  expect(formatCompact(950)).toBe("950");
  expect(formatCompact(34_700)).toBe("34.7K");
  expect(formatCompact(9_101_800_000 / 10)).toBe("910.2M");
  expect(formatCompact(10_263_200_000)).toBe("10.26B");
  expect(formatCompact(1_500_000_000_000)).toBe("1.50T");
});
