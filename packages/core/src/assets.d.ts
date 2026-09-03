/**
 * Ambient module declarations for bundled asset imports (#457): the
 * manual pages are statically imported markdown (ADR-0013, so the
 * compiled binary embeds them). Bun loads them as text via
 * `with { type: "text" }`; TypeScript only needs the module shape.
 */
declare module "*.md" {
  const content: string;
  export default content;
}
