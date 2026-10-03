# 997-D2 — How mature platforms design extension capability contracts

Prior art for wayfinder ticket #997 (child of map #996). Primary sources only: each claim carries one URL.
The goal is *design vocabulary*: the words a capability matrix needs, and the columns a build can test.

Verification status: every URL below was fetched in this pass and returned HTTP 200 at the canonical URL
shown. Quoted English is verbatim from the page cited. Items I could not confirm from a primary page are
marked **UNVERIFIED** — see §9.

---

## 1. VS Code

### 1.1 The contract is declared in a manifest, not in code

An extension is a directory with a `package.json` manifest declaring "its extension type(s), activation rules,
and runtime resources". <https://code.visualstudio.com/api/references/extension-manifest>

The fields that define the contract:

- `engines.vscode` — the host version required; the host refuses to load below it.
- `main` (Node extension host) or `browser` (web extension host, a WebWorker) — where the code runs.
- `contributes` — the *contribution points*: commands, languages, themes, menus, configuration keys.
- `capabilities.{untrustedWorkspaces, virtualWorkspaces}` — the extension's own statement of Restricted-Mode
  behaviour; `untrustedWorkspaces` takes `true | false | 'limited'`, and `restrictedConfigurations` names
  settings the extension may not read in Restricted Mode.
- `extensionKind` — `ui` / `workspace` / both: which side of the local/remote split the extension needs. A
  `ui` extension "must run close to the UI"; a web-only extension "will always run on the web extension host,
  regardless of the `extensionKind` setting".
  <https://code.visualstudio.com/api/references/extension-manifest>,
  <https://code.visualstudio.com/api/advanced-topics/extension-host>

The structural lesson: **declaration is separable from execution**. `contributes` is data the host interprets;
`main` is code the host runs. moh has no such split today — an extension is a module, so "declared capability"
and "executed effect" are the same object (`research-997/997-A-runtime-seams.md` §2).

### 1.2 Activation is a second, separate decision

The docs are explicit that the extension host exists so that "misbehaving extensions should not impact the user
experience", and that it "prevents extensions from: impacting startup performance, slowing down UI operations,
modifying the UI". Activation events exist alongside it: "VS Code lets extensions declare their Activation
Events and loads them lazily".
<https://code.visualstudio.com/api/advanced-topics/extension-host>

So VS Code separates three decisions that moh's single consent conflates:

1. **Install** — bytes on disk, no execution.
2. **Activate** — code is loaded into the host, against a declared trigger.
3. **Contribute** — the host reads declared data (no code execution needed).

### 1.3 The host is the enforcement point

Extensions never run in the UI process. There are three host configurations: `local` ("a Node.js extension host
running locally, on the same machine as the user interface"), `web` ("running in the browser or locally"), and
`remote` ("a Node.js extension host running remotely in a container or a remote location").
<https://code.visualstudio.com/api/advanced-topics/extension-host>

That is a stability boundary more than a security one: the page frames it in terms of UI stability and
performance, not permissions.

### 1.4 Workspace Trust: the honest limit

`capabilities.untrustedWorkspaces` + `restrictedConfigurations` are the manifest half.
<https://code.visualstudio.com/api/references/extension-manifest>

The documented limit is the sentence that matters most for moh — Workspace Trust **"can't prevent a malicious
extension from executing code and ignoring Restricted Mode"**.
<https://code.visualstudio.com/api/extension-guides/workspace-trust>

That is a platform admitting that a *declared* capability is only as good as the code's willingness to honour
it, absent a sandbox. moh's consent model makes the same admission explicitly ("no sandbox exists — consent is
the whole boundary"), so VS Code is a precedent for saying so out loud rather than a precedent for solving it.

### 1.5 Publisher trust: identity, not capability — and it is revocable

Per the 1.97 release notes: "When you install an extension from a publisher for the first time you will now see
a dialog to help you assess the trustworthiness of the extension publisher." Trusting a publisher also
implicitly trusts the publishers of bundled extensions; revoking is explicit — "This command allows you to
reset or revoke trust for publishers you have previously trusted."
<https://code.visualstudio.com/updates/v1_97>

This is an **identity** trust layer (who shipped it) sitting on top of, not replacing, **capability** trust
(what it may do). A publisher signature answers "same author as before", never "same capabilities as before".

---

## 2. Chrome and Firefox (WebExtensions)

### 2.1 Declared capabilities, split three ways

- `permissions` — API capabilities granted at install, e.g. `tabs`.
- `host_permissions` — which origins the extension may read/modify.
- `optional_permissions` / `optional_host_permissions` — capabilities the extension *may* ask for later, at
  runtime, declared "using the same format as the `permissions` field".
  <https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions>
  <https://developer.chrome.com/docs/extensions/reference/api/permissions>

The split is the vocabulary source for two distinct matrix columns: **how a capability is granted** (install vs
first use) and **what it covers** (API capability vs origin scope).

### 2.2 Install-time consent is a *warning list*, and some permissions cannot defer

"Some permissions are less intrusive and don't display a warning. Other permissions trigger a warning that
users have to allow." The warning list is published per permission, so the host — not the developer — authors
the user-visible text. <https://developer.chrome.com/docs/extensions/develop/concepts/permission-warnings>

Two further contract-level facts from the same page:

- Warnings can be *suppressed by combination*: "the `tabs` warning won't show if the extension also requests
  `<all_urls>`". A user-visible warning is therefore not a faithful projection of capability.
- Broad host access produces the `<all_urls>` warning, which the page singles out as one of the warnings
  "harder to understand than others".

Non-optional permissions (they cannot be deferred to a later request) are enumerated: `debugger`,
`declarativeNetRequest`, `devtools`, `geolocation`, `mdns`, `proxy`, `tts`, `ttsEngine`, `wallpaper`.
<https://developer.chrome.com/docs/extensions/reference/permissions-list>

A platform stating **capability severity tiers** in the contract itself, not in prose.

### 2.3 Deferred grant: typed as an advantage in the API docs

The `permissions` API page presents optional permissions with two named advantages that are exactly the
trade-off axes a matrix needs to record: "Better security: Extensions run with fewer permissions since users
only enable permissions that are needed" and "Better information for users: An extension can explain why it
needs a particular permission when the user enables the relevant feature".
<https://developer.chrome.com/docs/extensions/reference/api/permissions>

The same page supplies the revocation path (`permissions.remove()`) and change observation (`onAdded` /
`onRemoved`).

### 2.4 The update-widening rule — the crucial one for #997

Chrome's canonical wording, from the page that also documents how to *test* it:

> "When an extension adds a new permission that triggers a warning it may temporarily disable it. The extension
> will be re-enabled only after the user agrees to accept the new permission."
> — <https://developer.chrome.com/docs/extensions/develop/concepts/permission-warnings>

The same page frames it as a user-visible state ("An extension that is disabled until the user accepts the new
permission") and points at an "Extension Update Testing Tool" specifically so a developer can check this
behaviour before shipping. **That is the strongest hint in the whole survey for #997: the platform shipped a
test harness for the widening rule**, i.e. widening behaviour is treated as a *verifiable property* of the
contract, not a documented intention.

Chrome also states the inverse, which is the escape hatch: under optional permissions, "Chrome won't disable it
for your users if the upgrade adds optional rather than required permissions."
<https://developer.chrome.com/docs/extensions/reference/api/permissions>

Firefox goes further on the same axis:

> "if an extension update requires additional permissions the user is prompted to approve the permissions
> before the updated version is installed"
> "If the user chooses not to approve the permissions and cancels the update, the previous version remains
> installed and available for use."
> — <https://extensionworkshop.com/documentation/develop/request-the-right-permissions/>

Firefox's requests are also presented as all-or-nothing, and the guidance recommends runtime requests "in
context" with "a fallback if the user doesn't grant them", on the same page.
<https://extensionworkshop.com/documentation/develop/request-the-right-permissions/>

**The shape of the rule** (what #997 needs to copy): widening is a *diff event*, detected by the host by
comparing the new declared set against the granted set, and its consequence is one of exactly three outcomes —
disable-until-agreed (Chrome), prompt-before-install and keep-the-old-version on cancel (Firefox), or
re-review (Figma, §3.2). Note the design of the *key*: the comparison is on declared capability, so it is
computable without running anything.

Contrast with moh: today's key is path + SHA-256 of bytes (`extensions.ts:344-353`), so *any* edit re-asks —
including a comment-only change that widens nothing — while the question asked is still "enable it?", never
"it now wants X". The hash answers "changed", not "widened".

---

## 3. The sandbox spectrum

Three platforms, in descending order of enforcement strength.

### 3.1 Zed — real capability enforcement with per-capability scope

"The operations that Zed extensions are able to perform are governed by a capability system. As a user, you
have the option of restricting the capabilities that are granted to extensions. This is controlled via the
`granted_extension_capabilities` setting."

And the enforcement point, stated explicitly: **"Restricting or removing a capability will cause an error to be
returned when an extension attempts to call the corresponding extension API without sufficient capabilities."**
<https://zed.dev/docs/extensions/capabilities>

The three capabilities and, crucially, their **scopes**:

- `process:exec` — "grants extensions the ability to invoke commands", scoped by `command` and `args`
  (`{ kind = "process:exec", command = "gem", args = ["**"] }`).
- `download_file` — scoped by `host` and `path`
  (`{ kind = "download_file", host = "github.com", path = ["zed-industries", "zed", "**"] }`).
- `npm:install` — scoped by `package` (`{ kind = "npm:install", package = "typescript" }`).
<https://zed.dev/docs/extensions/capabilities>

The grant is also fully revocable in the strongest form — `granted_extension_capabilities: []` removes every
capability, with the honest caveat attached: "Note that this will likely make many extensions non-functional,
at least in their default configuration."
<https://zed.dev/docs/extensions/capabilities>

Extensions compile to `wasm32-wasip2`. <https://zed.dev/docs/extensions/developing-extensions>

**This is the single most useful row-template in the survey** for #997: a capability is a `kind` *plus scoped
parameters* (`command`/`args`, `host`/`path`, `package`), and the enforcement point is a typed error at the API
boundary. Note the enforcement is *negative and total* — there is no "unrestricted" default once the list is
set to empty.

Trade-off: capabilities must be enumerable in advance; anything the host has not modelled cannot be expressed.

### 3.2 Figma — declarative network scope + mandatory justification + re-review on widening

- `networkAccess.allowedDomains` — "match patterns for domains that your plugin is permitted to access"; if
  `networkAccess` is used, `allowedDomains` "must include at least one pattern" (including the explicit
  `["none"]`).
- `reasoning` — "a usually-optional string that describes why your plugin needs to access the allowed
  domains", and it is **required** when `allowedDomains` includes `"*"` or includes local/development servers.
- `devAllowedDomains` — an optional separate list "for development".
- `permissions?: PluginPermissionType[]` — `"currentuser" | "activeusers" | "fileusers" | "payments" |
  "teamlibrary"`.
  <https://developers.figma.com/docs/plugins/manifest/>

Two matrix-relevant ideas: the **enforcement point is a runtime error** rather than an install refusal (the
plugin keeps running; the violating access fails), and the **warning is partly authored by the developer**
(`reasoning`) rather than only generated by the host.

And the widening rule, which is a *release-gate* rather than a user prompt: **"Any material updates to your
plugin or widget are subject to re-review in accordance with this process. If the core functionality of your
plugin or widget substantially changes, you should create a new, separate plugin and submit it for review.
Figma may also require periodic reviews."**
<https://help.figma.com/hc/en-us/articles/360039958914-Plugin-security>

Trade-off: the strongest user-facing justification, but it depends on the author's honest `reasoning` and on a
reviewer for enforcement.

### 3.3 Obsidian — the honest no-sandbox

Restricted Mode is the loader gate: "By default, Obsidian runs in Restricted Mode to prevent third-party code
execution." The gate is at load, not at call — "Installed plugins remain in your vault even if you turn on
Restricted mode, but are ignored by Obsidian."

The capability statement, verbatim: **"Due to technical limitations, Obsidian cannot reliably restrict plugins
to specific permissions or access levels. This means that plugins will inherit Obsidian's access levels."** The
examples given are files, internet, and installing additional programs.

Mitigations, also from that page: automatic scanning of every plugin version for "security vulnerabilities,
code quality issues, and malware", with results published as a **safety scorecard**; manual review "for
popular, featured, and flagged plugins"; and the documentation itself recommends an independent audit for
sensitive data.
<https://help.obsidian.md/Extending+Obsidian/Plugin+security>

This is the closest analogue to moh's current state: no sandbox, no declared capabilities, consent on the whole
artifact. Its mitigations are what a no-sandbox platform can actually enforce: (1) a global off-switch gate at
the loader, (2) information placed at the point of human decision (scan + scorecard), (3) the user as the sole
enforcement point, stated plainly.

Trade-off: cheapest to build, weakest enforcement.

---

## 4. OS / package-manager trust

The model for *untrusted code that must run at install time* — the nearest neighbour to moh's "import the
module to know what it does".

### 4.1 Homebrew — a layered trust model, explicitly listed

The current page is "Homebrew Security and Supply Chain" (the older `docs.brew.sh/Security` URL now 404s). Its
own section list is the vocabulary of a mature supply-chain model: "No arbitrary code execution on install by
default", "Sandboxing", "Environment filtering", "Casks have a different trust model", "Cooldowns on riskier
ecosystems", "No trust in third-party repositories", "Signed JSON API metadata", "Bottle provenance
attestations", "Layered infrastructure with cross-checks", "Human review on all changes", "Maintainers, not
package owners", "Checksummed downloads pinned in reviewed metadata".
<https://docs.brew.sh/Homebrew-Security-and-Supply-Chain>

Two details worth carrying into the matrix:

- **Why a signed data API is the fix**: "casks are Ruby package definitions, and Ruby cannot be safely
  inspected without executing it. For default installs from official taps, Homebrew mitigates that by consuming
  precomputed JSON API metadata instead of evaluating core formula or cask Ruby locally." The API files
  (`formula.jws.json`, `cask.jws.json`) "are JWS-signed and verified by Homebrew before use."
  <https://docs.brew.sh/Homebrew-Security-and-Supply-Chain>
- **Why casks need a second boundary**: "Vendor installer scripts and macOS package installers run outside
  Homebrew's sandbox and may change files beyond Homebrew's directories." The compensating controls are Apple
  Developer ID signing, notarisation and Gatekeeper.
  <https://docs.brew.sh/Homebrew-Security-and-Supply-Chain>

This is the strongest argument in the survey for **splitting an artifact's dangerous parts out of the evaluated
code path** — exactly the split moh cannot make today, because a `.ts` extension's declaration and its effects
are the same file.

### 4.2 npm — install scripts run on install; provenance is explicitly not safety

Lifecycle order is documented as `preinstall → install → postinstall` (and on `npm install -g`).
<https://docs.npmjs.com/cli/v10/using-npm/scripts>

The privilege statement is concrete: **"When npm is run as root, scripts are always run with the effective uid
and gid of the working directory owner."** <https://docs.npmjs.com/cli/v10/using-npm/scripts>

And the honest limit of attestation: **"When a package in the npm registry has established provenance, it does
not guarantee the package has no malicious code. Instead, npm provenance provides a verifiable link to the
package's source code and build instructions, which developers can then audit and determine whether to trust it
or not."** Attestations are "signed by Sigstore public good servers and logged in a public transparency ledger".
<https://docs.npmjs.com/generating-provenance-statements>

The lesson: an **attestation column is not a capability column**. moh already implements the npm-side narrowing
(a declared npm `dependency` is refused with `deps_unauthorized` until installation exists), which is the same
conclusion reached from the other end.

---

## 5. Synthesis (a): the vocabulary

| Term | Definition | Demonstrated by |
| --- | --- | --- |
| **Declared capability** | The set of powers named in the artifact's own manifest, readable by the host *without executing the artifact*. | Chrome `permissions`/`host_permissions`; VS Code `contributes`; Zed `extension.toml`. |
| **Granted capability** | The subset the user has actually approved; the host owns this state, not the artifact. | Zed `granted_extension_capabilities`; `permissions.onAdded`/`onRemoved`. |
| **Observed capability** | What the artifact actually did at runtime, as recorded by the host. The declared↔observed gap is where auditing lives. | Zed returns an error when an API is called without the capability; Figma reports the violating access as an error. |
| **Install-time consent** | Approval asked once, covering the whole artifact, before any execution. | Chrome install warnings; VS Code publisher-trust dialog. |
| **First-use consent** | Approval asked at the moment a capability is first exercised, so the artifact may be loaded before the decision. | Chrome `optional_permissions` + a runtime request. |
| **Optional / deferred grant** | A capability the artifact may request later, not part of the install decision. | `optional_host_permissions`. |
| **Revocable grant** | The user can take a granted capability back; the host fires an event and the artifact must cope. | `permissions.remove()` + `onRemoved`; Zed's `granted_extension_capabilities: []`; VS Code "reset or revoke trust". |
| **Capability scope** | What the capability ranges over: a tool, a host, a domain, a path, an endpoint, a package. | Zed's `command`/`args`, `host`/`path`, `package`; Figma's `allowedDomains`; VS Code `restrictedConfigurations`. |
| **Enforcement point** | The single place the host makes a capability decision observable: a typed capability error, a CSP/access error, the extension disabled, or the install/update refused. | Zed = error at the API boundary; Chrome widening = disabled until accepted; Firefox widening = old version kept. |
| **Trust boundary** | What the platform states it *cannot* enforce. | VS Code: Workspace Trust "can't prevent a malicious extension from executing code and ignoring Restricted Mode"; Obsidian: plugins "will inherit Obsidian's access levels"; npm: provenance "does not guarantee the package has no malicious code". |
| **Widening event** | An update whose declared set is not a subset of the granted set — a set difference computable without running code. | Chrome's disable-until-agreed; Firefox's prompt-before-install; Figma's re-review. |
| **Activation trigger** | When the code is allowed to load at all, separate from whether it is installed. | VS Code `activationEvents`; Obsidian Restricted Mode. |

**The one sentence that ties it together:** a capability contract is a *declaration* the host can read without
executing code, an *enforcement point* where the host decides, and an *explicit trust boundary* stating what it
cannot enforce. Platforms without the declaration (Obsidian, moh today) end up with consent on the artifact and
the user as the sole enforcement point — and the three honest platforms in this survey (VS Code, Obsidian, npm)
each say so in print.

## 6. Synthesis (b): each mechanism's trade-off, one line

- **VS Code `contributes`** — separates inert declaration from executed code, so the user can see what an
  extension *offers* before it runs; but the declaration still comes from the artifact's own file.
  <https://code.visualstudio.com/api/references/extension-manifest>
- **VS Code extension host** — one process boundary that protects UI stability and load time; explicitly a
  stability boundary, not a permission boundary. <https://code.visualstudio.com/api/advanced-topics/extension-host>
- **VS Code Workspace Trust** — a coarse honest switch, cheap to implement, documented as bypassable by
  malicious code. <https://code.visualstudio.com/api/extension-guides/workspace-trust>
- **VS Code publisher trust (1.97+)** — answers "same author", never "same capabilities"; cheap identity layer
  that must not be mistaken for a capability layer, and is revocable.
  <https://code.visualstudio.com/updates/v1_97>
- **Chrome install warnings** — host-generated wording that is consistent across extensions; but warnings can
  be *suppressed by combination* (`tabs` hidden by `<all_urls>`), so the warning is not a faithful capability
  projection. <https://developer.chrome.com/docs/extensions/develop/concepts/permission-warnings>
- **Chrome optional permissions** — defers the decision to the moment of relevance, which is when the user can
  actually judge it, and skips the disable-on-upgrade path; but it requires the extension to degrade gracefully.
  <https://developer.chrome.com/docs/extensions/reference/api/permissions>
- **Chrome non-optional permission list** — encodes severity in the contract so some capabilities can never be
  deferred; but the list is a fixed host-side judgement that ages.
  <https://developer.chrome.com/docs/extensions/reference/permissions-list>
- **Chrome update-widening (disable-until-agreed)** — the extension stays installed but cannot run until
  answered, making widening impossible to slip through silently; it ships a testing tool, making the rule
  verifiable; cost is a user-visible regression for benign changes that merely add a warning-triggering key.
  <https://developer.chrome.com/docs/extensions/develop/concepts/permission-warnings>
- **Firefox update-widening (prompt-before-install; cancel keeps old version)** — strongest user agency and no
  half-installed state; cost is a permanently diverging installed version.
  <https://extensionworkshop.com/documentation/develop/request-the-right-permissions/>
- **Zed `granted_extension_capabilities`** — the only model where the grant is scoped per capability *and* per
  parameter, and where removing a capability produces a typed error at the call site rather than a vague
  failure; cost is that every capability must be modelled in the host ABI.
  <https://zed.dev/docs/extensions/capabilities>
- **Figma domain allowlist + mandatory `reasoning`** — forces the author to justify broad access inside the
  artifact, so both user and reviewer see the intent; cost is a free-text field no tool can verify.
  <https://developers.figma.com/docs/plugins/manifest/>
- **Figma material updates re-reviewed** — treats widening as a release gate rather than a user prompt; cost is
  review latency and a reviewer dependency. <https://help.figma.com/hc/en-us/articles/360039958914-Plugin-security>
- **Obsidian Restricted Mode + scorecard** — gates the loader and puts information at the point of decision;
  cost is that enforcement is the user's, and the docs say so.
  <https://help.obsidian.md/Extending+Obsidian/Plugin+security>
- **Homebrew signed JSON API + cooldowns + attestations** — removes executable package definitions and
  third-party repositories from the default path; cost is a build/publish pipeline the ecosystem must adopt.
  <https://docs.brew.sh/Homebrew-Security-and-Supply-Chain>
- **npm install scripts** — maximal convenience and maximal blast radius at the exact moment of install, with
  root-mode uid/gid inheritance documented as a code path; cost is that opting out breaks much of the ecosystem.
  <https://docs.npmjs.com/cli/v10/using-npm/scripts>
- **npm provenance** — a verifiable "where from" record that npm itself says "does not guarantee the package
  has no malicious code" — the cleanest statement in the survey of why attestation ≠ capability.
  <https://docs.npmjs.com/generating-provenance-statements>

## 7. Synthesis (c): what a testable capability matrix must contain, column by column

Each column is justified by a platform in which its presence (or absence) produced a known, observable behaviour.

| Column | Why it must exist | Demonstrating platform |
| --- | --- | --- |
| **capability** | The unit of the contract. If it is not a name, it cannot be diffed, granted, or revoked. Chrome and Zed both enumerate names; Obsidian's absence of names is exactly why it cannot restrict anything. | Chrome `permissions`; Zed capability `kind`. |
| **who declares it** | Determines whether the declaration is trusted input. A host-generated warning (Chrome) vs author-authored prose (Figma `reasoning`) vs absent (Obsidian) are three different trust levels for the *same* cell. | Chrome vs Figma vs Obsidian. |
| **how it is granted** | Install-time, first-use, or never (bundled/trusted-by-host). Each implies a different UI door and a different store. | Chrome install warnings vs `optional_permissions`. |
| **runtime enforcement point** | A row without one is a promise, not a capability. It must name exactly one of: a typed error at the API boundary, an access error, the extension disabled, or the install/update refused. Zed states this in one sentence; Obsidian states there is none. | Zed error-on-call; Chrome disable; Firefox keep-old-version. |
| **user-visible warning** | The consent decision needs the same vocabulary the enforcement uses, else the user cannot recognise the thing being asked about. Chrome also shows the failure mode of this column: warnings suppressed by combination. | Chrome permission warnings. |
| **revocation path** | A grant the user cannot undo is not a grant, it is a fact. | `permissions.remove()`; Zed's empty capability list; VS Code "reset or revoke trust". |
| **update-widening behaviour** | The column that turns "consent" into "consent that stays true over time". Must name the trigger (a set difference on declared capabilities) *and* the outcome (disable / refuse / re-review / no auto-update). | Chrome disable-until-accepted; Firefox prompt-before-install; Figma re-review. |
| **failure mode** | What happens when the capability is refused or absent, stated distinguishably from "the extension crashed", because that is what a test asserts on. moh already emits `extension_failed { reason: "consent" }` — the pattern to generalise. | Chrome's disabled-until-accepted state; Zed's capability error. |

Three columns are deliberately **not** proposed, because the survey shows they answer a different question:

- **signature / provenance** — Homebrew's attestations and npm's provenance both document that this answers
  "where from", and npm says in as many words that it is not a safety claim. It belongs beside the matrix.
- **sandbox strength** — Zed is the only surveyed platform where this is a meaningful per-capability cell;
  elsewhere it is a single platform-level statement that VS Code and Obsidian both make in prose.
- **publisher identity** — VS Code's publisher trust is explicitly revocable *identity* trust; conflating it
  with capability trust is the mistake the manifest/trust split exists to avoid.

## 8. What each platform does on update-widening — the consolidated answer

> **Read this section as the input to #997's "explicit capability consent" decision.**

| Platform | Trigger | Outcome on widening | Source |
| --- | --- | --- | --- |
| **Chrome** | An update adds a new permission that triggers a warning. | The extension **may be temporarily disabled**; it is **re-enabled only after the user agrees** to accept the new permission. Chrome ships an *Extension Update Testing Tool* so the developer can verify this behaviour. Adding **optional** permissions does not disable it. | <https://developer.chrome.com/docs/extensions/develop/concepts/permission-warnings>, <https://developer.chrome.com/docs/extensions/reference/api/permissions> |
| **Firefox** | An update requires additional permissions. | The user is **prompted to approve before the updated version is installed**; if the user **cancels the update, the previous version remains installed and available for use**. | <https://extensionworkshop.com/documentation/develop/request-the-right-permissions/> |
| **Figma** | A **material** update — "If the core functionality of your plugin or widget substantially changes". | Subject to **re-review** under the review process; Figma "may also require periodic reviews". Widening is a release gate, not a user prompt. | <https://help.figma.com/hc/en-us/articles/360039958914-Plugin-security> |
| **VS Code** | No capability-diff mechanism is documented on the pages surveyed. The manifest and extension-host pages do not mention re-consent; 1.97 adds *publisher* trust (revocable), which is identity-based. | **Nothing equivalent for capabilities.** The nearest lever is publisher trust + the recommendation to split capabilities across extension `kind`s and `restrictedConfigurations`. | <https://code.visualstudio.com/api/references/extension-manifest>, <https://code.visualstudio.com/updates/v1_97> |
| **Obsidian** | Every update, by construction. | The plugin's *safety scorecard* is regenerated per version ("Obsidian automatically scans **every plugin version**"), so information is refreshed on update; there is no capability diff because there are no declared capabilities. | <https://help.obsidian.md/Extending+Obsidian/Plugin+security> |
| **Zed** | Not documented as a diff; the grant is a user-owned list, so a new capability the user has not listed is simply refused. | Widening by the extension has no path — the *user's* list is authoritative and an unlisted capability yields an error. Widening happens only when the user adds it. | <https://zed.dev/docs/extensions/capabilities> |
| **Homebrew** | New package version reaching a tap. | Controls are evaluative rather than per-update prompts: "Cooldowns on riskier ecosystems", "Human review on all changes", "Checksummed downloads pinned in reviewed metadata". | <https://docs.brew.sh/Homebrew-Security-and-Supply-Chain> |

**The design space the survey yields, stated as three families:**

1. **Detect the diff, then act at the host level** — Chrome (disable until agreed), Firefox (refuse the update,
   keep the old version). Requires a *declared* capability set to diff against, and Chrome's testing tool shows
   the rule can be made testable.
2. **Make the grant authoritative instead of the manifest** — Zed (the user's list wins; anything unlisted
   errors). Widening becomes structurally impossible rather than detected.
3. **Remove the silent-update path or move it upstream** — Figma (re-review of material updates), Homebrew
   (cooldowns + review), Obsidian (per-version scan; no capability diff at all).

For moh, whose key today is path + file hash (`extensions.ts:344-353`), family 1 is the only one that preserves
the current shape: consent already re-fires on every byte change, but the *question* and the *diff* are missing.
The survey says the missing half is a declared capability set and a set-difference check, with the outcome
naming which capability was added — the exact thing the map's "explicit capability consent" decision asks for.

## 9. UNVERIFIED / gaps

- **UNVERIFIED — VS Code capability-widening.** I found no primary page documenting re-consent or a capability
  diff on VS Code extension *update*. The manifest reference, the extension-host page and the Workspace Trust
  guide do not mention it; the 1.97 notes describe publisher trust, which is identity-based. Treat the VS Code
  cell in §8 as "no documented mechanism", not as "verified to have no mechanism".
- **UNVERIFIED — `--ignore-scripts`.** The npm scripts page fetched here documents the lifecycle order and the
  root uid/gid behaviour but does not carry the `--ignore-scripts` opt-out text; that claim is therefore *not*
  repeated above. It belongs on the npm CLI config page, which was not fetched.
- **UNVERIFIED — VS Code `extensions.verifySignature`.** The settings docs URL cited for it in the earlier pass
  did not yield the setting text in this fetch; the signature-verification claim is therefore dropped from §1.
- **Not attempted (optional in the brief).** MCP authorization/consent, Chrome's enterprise `ExtensionSettings`
  policy layer, VS Code's extension-runtime-security page, the OpenAI Apps SDK and the Anthropic connector
  consent screens. None of the conclusions above depend on them.
- **Note on URL drift.** Two URLs from the prior pass 404 now and were replaced with the live canonical pages:
  Homebrew moved to `docs.brew.sh/Homebrew-Security-and-Supply-Chain`, and Chrome's widening rule lives on
  `concepts/permission-warnings` (not a `permissions-api` path). Zed's capability detail lives on
  `docs/extensions/capabilities`, not the developing-extensions page.
