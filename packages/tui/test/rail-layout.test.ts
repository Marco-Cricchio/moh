/** #1218: the rail's geometry as pure functions — distribution, the
 * composer floor, the hybrid demand, the header markers. */
import { describe, expect, test } from "bun:test";
import {
  allocatePanels,
  allocationHeader,
  distribute,
  railAvailableRows,
  suggestOverlay,
} from "../src/rail-layout";

describe("railAvailableRows (#1218)", () => {
  test("subtracts the composer frame and the footer from the viewport", () => {
    // 3 (composer frame) + 5 (footer base) = 8 reserved rows.
    expect(railAvailableRows(30, 0)).toBe(22);
  });

  test("the subagent chips row costs one more footer row", () => {
    expect(railAvailableRows(30, 3)).toBe(21);
    expect(railAvailableRows(30, 0) - railAvailableRows(30, 2)).toBe(1);
  });

  test("never goes negative", () => {
    expect(railAvailableRows(5, 0)).toBe(0);
  });
});

describe("distribute (#1218)", () => {
  test("a single panel may take up to 100% of the available height", () => {
    expect(distribute(20, [12])).toEqual([12]);
    expect(distribute(20, [99])).toEqual([18]); // share = 20 - 2 chrome
  });

  test("the equal share is computed on real space: chrome paid before splitting", () => {
    // 3 panels, 30 rows: chrome = 3*2 + 2 = 8, share = floor(22/3) = 7.
    expect(distribute(30, [20, 20, 20])).toEqual([7, 7, 7]);
  });

  test("a panel demanding less takes only its demand — no backfill", () => {
    // 2 panels, 30 rows: share = floor(25/2) = 12. No backfill: 12 + 3.
    expect(distribute(30, [13, 3])).toEqual([12, 3]);
  });

  test("at least one row per panel, whatever the pressure", () => {
    expect(distribute(4, [10, 10])).toEqual([1, 1]);
    expect(distribute(0, [5])).toEqual([1]);
  });
});

describe("allocatePanels (#1218 hybrid demand)", () => {
  const AVAIL = 24;
  const one = (natural: number, maxHeight?: number) => allocatePanels(AVAIL, [natural], [maxHeight])[0]!;

  test("demand is the header row plus the render clamped by a declared maxHeight", () => {
    // 1 header row + 8 render rows = 9 content rows.
    expect(one(8).height).toBe(9);
    expect(one(40, 10).height).toBe(11); // maxHeight cuts the render: 1 + 10
    expect(one(40).height).toBe(AVAIL - 2); // the share cuts it (chrome = 2)
  });

  test("shareCapped marks the amber `of D` cut; maxClamped the clamp marker", () => {
    const shareCapped = one(40);
    expect(shareCapped.shareCapped).toBe(true);
    expect(shareCapped.maxClamped).toBe(false);

    const maxClamped = one(40, 10);
    expect(maxClamped.shareCapped).toBe(false); // 11 fits the single-panel share
    expect(maxClamped.maxClamped).toBe(true);

    const roomy = one(5, 12);
    expect(roomy.shareCapped).toBe(false);
    expect(roomy.maxClamped).toBe(false);
  });

  test("body rows are the content minus the header row", () => {
    expect(one(8).body).toBe(8);
  });

  test("with several panels the share is split before any single cap applies", () => {
    const [a, b] = allocatePanels(30, [20, 3], [undefined, undefined]);
    // demands = [21, 4]; chrome = 2*2 + 1 separator = 5, share = floor(25/2) = 12.
    expect(a!.height).toBe(12);
    expect(b!.height).toBe(4); // no backfill: b takes only its demand
  });
});

describe("allocationHeader (#1218 client-drawn identity + allocation)", () => {
  test("roomy: name, extension, allocated rows and the share percentage", () => {
    const h = allocationHeader("team", "agents", allocatePanels(24, [8], [undefined])[0]!, 24);
    expect(h.plain).toBe(" team agents ");
    expect(h.amber).toBe("·8r (38%)");
  });

  test("share-capped: the demand is named, in body rows", () => {
    const a = allocatePanels(24, [40], [undefined])[0]!;
    expect(allocationHeader("team", "agents", a, 24).amber).toBe("·21r (92%) of 40");
  });

  test("max-clamped: the declared value and the marker", () => {
    const a = allocatePanels(24, [40], [12])[0]!;
    expect(allocationHeader("team", "agents", a, 24).amber).toBe("·12r (54%) ·max 12 → 12 (clamped)");
  });
});

describe("suggestOverlay (#1218)", () => {
  test("a maxHeight past ~60% of the available height is overlay advice", () => {
    expect(suggestOverlay(200, 22)).toBe(true);
    expect(suggestOverlay(13, 22)).toBe(false);
    expect(suggestOverlay(200, 0)).toBe(false);
  });
});
