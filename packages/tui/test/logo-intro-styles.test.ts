import { describe, expect, test } from "bun:test";
import { STYLES } from "../src/LogoIntro";
import { LOGO_BANNER, SPLASH_BANNERS } from "../src/ui";

// #1467: `settled` is `tick >= total - 1`, so whatever a style's last frame
// shows is what the intro paints as settled before handing off to Home.
// Every style must land on the full banner, for every splash font.
describe("LogoIntro styles settle on the full banner (#1467)", () => {
  const banners: Array<[string, string[]]> = [
    ...Object.entries(SPLASH_BANNERS).map(([font, rows]) => [font, rows] as [string, string[]]),
    ["LOGO_BANNER", LOGO_BANNER],
  ];

  for (const style of STYLES) {
    test(`${style.name}: the last frame is the banner for every font`, () => {
      for (const [font, banner] of banners) {
        // Styles draw from Math.random (scatter order, glitch noise, rain
        // landings): sample several builds so a lucky order cannot pass.
        for (let run = 0; run < 10; run++) {
          const frames = style.make(banner);
          const last = frames[frames.length - 1]!.map((r) => r.trimEnd());
          expect({ font, last }).toEqual({ font, last: banner.map((r) => r.trimEnd()) });
        }
      }
    });
  }
});
