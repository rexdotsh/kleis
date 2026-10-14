// Generates the admin app icons and iOS launch images in public/admin/icons.
// Run with `bun scripts/admin-icons.ts` after changing the artwork below.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const OUT = "public/admin/icons";
const RESVG = "@resvg/resvg-js-cli@2.6.2-beta.1";
const PAGE = "#0a0a0b";
const TEXT = "#e6e4df";
const ACCENT = "#d4a24e";

// The key from the admin UI's #i-key symbol, on a 16-unit grid. At scale 42
// it stays inside the maskable safe zone (a circle of 80% of the icon).
const glyph = (scale: number) => `
  <g transform="translate(512 512) scale(${scale}) translate(-8 -8)">
    <g fill="none" stroke="${TEXT}" stroke-width="1.4" stroke-linecap="round">
      <circle cx="5.5" cy="10.5" r="3"/>
      <path d="M7.6 8.4 13.5 2.5M11.4 4.6l1.6 1.6M9.9 6.1l1.2 1.2"/>
    </g>
    <circle cx="5.5" cy="10.5" r="0.9" fill="${ACCENT}"/>
  </g>`;

const icon = ({ radius, scale }: { radius: number; scale: number }) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#1b1b1e"/>
      <stop offset="1" stop-color="${PAGE}"/>
    </linearGradient>
  </defs>
  <rect width="1024" height="1024" rx="${radius}" fill="url(#bg)"/>${glyph(scale)}
</svg>
`;

const svgs = {
  // Full bleed: iOS and Android mask it to their own shape.
  "icon.svg": icon({ radius: 0, scale: 42 }),
  // Rounded for places that show the icon as is (desktop, launchers).
  "icon-rounded.svg": icon({ radius: 230, scale: 42 }),
  // A larger key so it still reads at 16px in a browser tab.
  "favicon.svg": icon({ radius: 230, scale: 56 }),
};

const pngs: [source: keyof typeof svgs, name: string, size: number][] = [
  ["icon.svg", "apple-touch-icon.png", 180],
  ["icon.svg", "icon-maskable-192.png", 192],
  ["icon.svg", "icon-maskable-512.png", 512],
  ["icon-rounded.svg", "icon-192.png", 192],
  ["icon-rounded.svg", "icon-512.png", 512],
  ["favicon.svg", "favicon-32.png", 32],
];

// iPhone screens in CSS pixels and device pixel ratio. iOS shows a launch
// image only when it matches the screen exactly; the plain page colour keeps
// the launch from flashing white before the first paint.
const launchScreens: [width: number, height: number, ratio: number][] = [
  [375, 667, 2],
  [414, 736, 3],
  [375, 812, 3],
  [414, 896, 2],
  [414, 896, 3],
  [390, 844, 3],
  [428, 926, 3],
  [393, 852, 3],
  [430, 932, 3],
  [402, 874, 3],
  [420, 912, 3],
  [440, 956, 3],
];

const launchName = (width: number, height: number, ratio: number) =>
  `launch-${width * ratio}x${height * ratio}`;

const render = async (input: string, output: string, width: number) => {
  const child = Bun.spawn(
    ["bunx", RESVG, "--fit-width", String(width), input, output],
    { stdout: "ignore", stderr: "inherit" }
  );
  if ((await child.exited) !== 0) {
    throw new Error(`Failed to render ${output}`);
  }
};

const work = await mkdtemp(join(tmpdir(), "kleis-icons-"));
try {
  for (const [name, svg] of Object.entries(svgs)) {
    await Bun.write(`${OUT}/${name}`, svg);
  }
  for (const [source, name, size] of pngs) {
    await render(`${OUT}/${source}`, `${OUT}/${name}`, size);
  }
  for (const [width, height, ratio] of launchScreens) {
    const name = launchName(width, height, ratio);
    const svg = join(work, `${name}.svg`);
    await Bun.write(
      svg,
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width * ratio}" height="${height * ratio}"><rect width="100%" height="100%" fill="${PAGE}"/></svg>`
    );
    await render(svg, `${OUT}/${name}.png`, width * ratio);
  }
} finally {
  await rm(work, { recursive: true, force: true });
}

const links = launchScreens.map(
  ([width, height, ratio]) =>
    `<link rel="apple-touch-startup-image" href="./icons/${launchName(width, height, ratio)}.png" media="(device-width: ${width}px) and (device-height: ${height}px) and (-webkit-device-pixel-ratio: ${ratio}) and (orientation: portrait)">`
);
console.log(links.join("\n"));
