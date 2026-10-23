import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { wireToolSchema } from "../src/session/agent-loop";

describe("wireToolSchema (#1324)", () => {
  const gen = (schema: z.ZodType) => wireToolSchema(schema as never);

  it("passes a plain object schema through unchanged", () => {
    const wire = gen(z.object({ path: z.string() })) as { type?: string; oneOf?: unknown };
    expect(wire.type).toBe("object");
    expect(wire.oneOf).toBeUndefined();
  });

  it("flattens a discriminated union into a single object schema", () => {
    const wire = gen(
      z.discriminatedUnion("action", [
        z.object({ action: z.literal("navigate"), url: z.string().min(1) }),
        z.object({ action: z.literal("close") }),
      ]),
    ) as {
      type?: string;
      properties?: Record<string, { type?: string; enum?: string[]; minLength?: number }>;
      required?: string[];
      additionalProperties?: boolean;
      oneOf?: unknown;
    };
    expect(wire.type).toBe("object");
    expect(wire.oneOf).toBeUndefined();
    const props = wire.properties as Record<string, { type?: string; enum?: string[] }>;
    expect(Object.keys(props).sort()).toEqual(["action", "url"]);
    expect(props.action.enum).toEqual(["navigate", "close"]);
    expect(props.url.type).toBe("string");
    expect(wire.required).toEqual(["action"]);
    expect(wire.additionalProperties).toBe(false);
  });

  it("leaves a plain union of objects (no discriminator) untouched", () => {
    const wire = gen(
      z.union([z.object({ ref: z.string() }), z.object({ ref: z.string(), text: z.string() })]),
    ) as { anyOf?: unknown };
    expect(wire.anyOf).toBeDefined();
  });

  it("leaves unions of non-object schemas untouched", () => {
    const wire = gen(z.union([z.string(), z.number()])) as { anyOf?: unknown };
    expect(wire.anyOf).toBeDefined();
  });

  it("flattens the browser-shaped union to a required action only", () => {
    const wire = gen(
      z.discriminatedUnion("action", [
        z.object({ action: z.literal("navigate"), url: z.string().min(1) }),
        z.object({ action: z.literal("snapshot"), ref: z.string().optional(), depth: z.number().int().optional() }),
        z.object({ action: z.literal("close") }),
        z.object({ action: z.literal("click"), ref: z.string() }),
      ]),
    ) as { type?: string; required?: string[] };
    expect(wire.type).toBe("object");
    expect(wire.required).toEqual(["action"]);
  });

  it("flattens a union whose non-discriminator property is an enum (browser scroll)", () => {
    const wire = gen(
      z.discriminatedUnion("action", [
        z.object({ action: z.literal("navigate"), url: z.string() }),
        z.object({
          action: z.literal("scroll"),
          direction: z.enum(["up", "down"]).optional(),
          amount: z.number().optional(),
        }),
      ]),
    ) as { type?: string; oneOf?: unknown; properties?: Record<string, unknown> };
    expect(wire.type).toBe("object");
    expect(wire.oneOf).toBeUndefined();
    expect(wire.properties?.direction).toBeDefined();
  });
});
