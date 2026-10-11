/**
 * #1324: the provider-facing tool schema. `z.toJSONSchema` renders a
 * discriminated union as a bare top-level `oneOf`, which openai-chat
 * backends reject outright (strict: 400 "got 'type: null'") or answer
 * with calls that carry no arguments (lenient: the model fails to
 * populate a union). This module rewrites such a schema into a single
 * flat object — the shape these models are trained on — while the
 * zod schema stays the moh-side validation schema.
 */
import { z } from "zod";

type JsonObject = Record<string, unknown>;

/** Schema of one union variant; the wire shape zod actually emits. */
interface VariantSchema {
  type?: string;
  properties?: Record<string, JsonObject>;
  required?: string[];
  [key: string]: unknown;
}

function discriminatorName(variants: VariantSchema[]): string | null {
  let name: string | null = null;
  for (const v of variants) {
    for (const [key, prop] of Object.entries(v.properties ?? {})) {
      // Only `const` (a z.literal) can be a discriminator. `enum` cannot:
      // a variant carrying its own enum property (browser `scroll.direction`,
      // required in its own variant by zod's compilation) would otherwise
      // read as a second candidate and the flatten is refused — #1324.
      if ("const" in prop) {
        if (name === null) name = key;
        else if (name !== key) return null;
      }
    }
  }
  return name;
}

function valuesOf(v: VariantSchema, key: string): unknown[] | null {
  const prop = v.properties?.[key];
  if (!prop) return null;
  if ("const" in prop) return [prop.const];
  if ("enum" in prop && Array.isArray(prop.enum)) return prop.enum;
  return null;
}

export function wireSchema(raw: JsonObject): JsonObject {
  const unionKey = "oneOf" in raw ? "oneOf" : "anyOf" in raw ? "anyOf" : null;
  if (!unionKey) return raw;
  const variants = raw[unionKey];
  if (!Array.isArray(variants) || variants.length === 0) return raw;
  if (!variants.every((v) => v && typeof v === "object" && (v as VariantSchema).type === "object")) return raw;

  const disc = discriminatorName(variants as VariantSchema[]);
  // A variant without the discriminator would silently vanish from the
  // wire enum — refuse to flatten rather than widen the schema.
  if (!disc || variants.some((v) => !valuesOf(v as VariantSchema, disc))) return raw;
  const properties: Record<string, JsonObject> = {};
  const values: unknown[] = [];
  for (const v of variants as VariantSchema[]) {
    for (const value of valuesOf(v, disc) ?? []) {
      if (!values.includes(value)) values.push(value);
    }
  }
  properties[disc] = {
    ...(values.every((v) => typeof v === "string") ? { type: "string" } : {}),
    enum: values,
  };
  for (const v of variants as VariantSchema[]) {
    for (const [propKey, prop] of Object.entries(v.properties ?? {})) {
      if (propKey === disc) continue;
      properties[propKey] = { ...prop };
    }
  }
  // Keep only the requirements shared by every variant; per-variant
  // required keys are enforced by the zod schema at validation time.
  const required = (variants as VariantSchema[])
    .map((v) => new Set(v.required ?? []))
    .reduce((common, set) => new Set([...common].filter((k) => set.has(k))));
  return { type: "object", properties, required: [...required], additionalProperties: false };
}

/**
 * The single seam agent-loop uses for tool specs: generate the JSON
 * Schema from the zod input and flatten it for the wire.
 */
export function wireToolSchema(inputSchema: z.ZodType): JsonObject {
  return wireSchema(z.toJSONSchema(inputSchema) as JsonObject);
}
