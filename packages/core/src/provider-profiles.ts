import { PROVIDER_KINDS } from "./provider-kinds";

/**
 * Authoritative built-in OpenAI-compatible provider metadata for #726.
 *
 * This module is declarative: transport construction and configuration
 * integration deliberately live elsewhere. URLs are documented defaults;
 * placeholders in URLs must be substituted by the endpoint owner.
 */
export interface ProviderProfile {
  id: string;
  displayName: string;
  baseUrl: string;
  apiKeyEnv: string;
  defaultModel: string;
  endpointAlternatives?: readonly { label: string; baseUrl: string }[];
}

/** The profile rows of a provider-kind table, as the exact tuple of
 * profiles a hand-written `as const` list would declare (#1423). */
type ProfilesOf<T extends readonly unknown[]> = T extends readonly [infer H, ...infer R]
  ? H extends { readonly kind: infer K; readonly defaultBaseUrl: infer B; readonly apiKeyEnv: infer E; readonly profile: infer P }
    ? P extends { readonly displayName: infer D; readonly defaultModel: infer M; readonly endpointAlternatives: infer A }
      ? readonly [{ readonly id: K; readonly displayName: D; readonly baseUrl: B; readonly apiKeyEnv: E; readonly defaultModel: M; readonly endpointAlternatives: A }, ...ProfilesOf<R>]
      : P extends { readonly displayName: infer D; readonly defaultModel: infer M }
        ? readonly [{ readonly id: K; readonly displayName: D; readonly baseUrl: B; readonly apiKeyEnv: E; readonly defaultModel: M }, ...ProfilesOf<R>]
        : ProfilesOf<R>
    : ProfilesOf<R>
  : readonly [];

export const PROVIDER_PROFILES = PROVIDER_KINDS.flatMap((row) =>
  "profile" in row
    ? [{
        id: row.kind,
        displayName: row.profile.displayName,
        baseUrl: row.defaultBaseUrl,
        apiKeyEnv: row.apiKeyEnv,
        defaultModel: row.profile.defaultModel,
        ...("endpointAlternatives" in row.profile ? { endpointAlternatives: row.profile.endpointAlternatives } : {}),
      }]
    : [],
) as unknown as ProfilesOf<typeof PROVIDER_KINDS> satisfies readonly ProviderProfile[];

type ProviderProfileId = (typeof PROVIDER_PROFILES)[number]["id"];

/** Finds a first-party profile by its stable endpoint type. */
export function providerProfile(id: string): ProviderProfile | undefined {
  return PROVIDER_PROFILES.find((profile) => profile.id === id);
}

export function isProviderProfile(id: string): id is ProviderProfileId {
  return providerProfile(id) !== undefined;
}

/** The documented endpoint choices a guided setup can safely present. */
export function providerRequiresBaseUrlInput(id: string): boolean {
  return providerProfile(id)?.baseUrl.includes("{") ?? false;
}

export function providerEndpointChoices(id: string): readonly { label: string; baseUrl: string }[] {
  const profile = providerProfile(id);
  return profile ? [{ label: profile.displayName, baseUrl: profile.baseUrl }, ...(profile.endpointAlternatives ?? [])] : [];
}
