# Third-party notice — bundled skills

The skills bundled in this directory (`grilling`, `domain-modeling`, `wayfinder`,
and the remaining first-party workflow skills) are ported from Matt Pocock's
skills repository:

- Source: https://github.com/mattpocock/skills
- Upstream commit at port time: `5b15a47f2d7150f545fbcacbfe381787fc0230dc`
- License: MIT — Copyright (c) 2026 Matt Pocock

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Intentional deviations from upstream

Per the license check in `docs/research/pocock-skills-license.md` the ports
stay verbatim except for:

- `minMohVersion` frontmatter added for the moh version gate.
- `disable-model-invocation` frontmatter dropped (not a moh concept).
- "Call the Skill tool with X" phrasing adapted to moh's mechanism
  (skills are loaded by reading their SKILL.md from the skills index).
- `grilling`: a "Routing questions through ask_user" section added
  (moh's ask_user tool, #68).
- `diagnosing-bugs`: `scripts/hitl-loop.template.sh` flattened to the
  skill root (the installer bundles top-level files only); SKILL.md
  references updated to match.
- Upstream's `agents/openai.yaml` sidecar files are not bundled.
