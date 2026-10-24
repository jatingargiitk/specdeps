# specdeps

Update your AI-generated specs without erasing the decisions you wrote yourself.

`specdeps` is a small local build system for Markdown you already have. A chain such as source document → summary → implementation spec is declared in `specdeps.yaml`. When a source or prompt changes, specdeps tells you which outputs are stale, runs your generator only for the affected sections, and writes a proposal. Applying that proposal replaces generated sections and leaves every other byte alone.

Preserving a sentence does not mean it is still consistent with the changed source. specdeps checks freshness and ownership. It does not check meaning.

## Out of scope

specdeps is not a wiki, an agent memory store, a vector database, a semantic checker, an autonomous documentation agent, or a chat UI. It does not call a hosted API, open an account, send telemetry, or start a database. Version 0.1 does not fetch remote URLs.

## Requirements

The package targets Node.js 22 and newer, which covers the Node 22 and Node 24 LTS lines. It was developed on the Node.js 25.4.0 Current release installed on this machine and does not use Current-only APIs. The only runtime dependency is `yaml`. TypeScript is strict.

Install and run it from this repository:

```bash
npm install
npm run build
npx specdeps --help
```

The engine, the process runner, and the CLI are separate. `src/core` never spawns a process. `src/exec` is the only place that does. `src/cli` prints reports.

## Ownership

Generated text lives between explicit markers. The section id must be unique in the file:

```markdown
<!-- specdeps:generated summary:start -->
Generated text here.
<!-- specdeps:generated summary:end -->
```

The marker occupies the entire line: no indentation and no extra spaces. Everything outside those interiors belongs to the human, including decisions written between two generated sections. A checkout spec can say this with no extra syntax:

```markdown
Client exception: refunds require manual approval above $500.
```

Rules the engine enforces:

- Human-owned bytes are copied through unchanged. A rebuild never rewrites the whole file when only a section is managed.
- Human-owned bytes are not sent to the generator. A source that points at another target receives that target's generated section only.
- Missing, duplicate, nested, overlapping, and mismatched markers are errors. The token `specdeps:generated` on a marker line must be a well-formed marker.
- Generator stdout that contains an ownership marker is rejected.
- A manual edit inside a generated section becomes a conflict. Build will not run the generator for that target, and nothing is overwritten. There is no force flag.
- A non-empty generated section with no ownership record must be adopted explicitly (`specdeps adopt <target>`) before a rebuild can replace it. Adoption records the current bytes as a conflict baseline. It does not mark the target current.

## Freshness

Every target gets a SHA-256 fingerprint of:

- the exact bytes of each declared path source
- the generated section of each upstream target
- the prompt bytes
- the runner command and arguments
- the protocol version (`1`)
- the target's `generatorVersion`, when you set one

State and status reports store those hashes. They do not store prompt text, runner arguments, or environment variables. The runner inherits the parent environment so that a local `node` can be found, and that environment is not written into `.specdeps/`.

| State | Meaning |
| --- | --- |
| `current` | The section matches the last apply, the fingerprint matches, and every upstream target is current. |
| `stale` | An input changed, an upstream target is stale, or the section was adopted and has not been generated yet. |
| `unbuilt` | specdeps has no ownership record for an empty section. |
| `conflict` | The generated section differs from the last applied or adopted bytes. |
| `blocked` | A marker, path, or upstream failure makes a safe rebuild impossible. |

A prompt change marks that target stale. A stale upstream target keeps its dependents from being current, even when their own section bytes have not moved. During a build, a downstream generator receives the upstream proposal from this run, not the older text still on disk. Independent targets keep their relative order stable: dependencies first, then alphabetical order.

## Manifest

`specdeps.yaml` at the repository root:

```yaml
version: 1

targets:
  payment-summary:
    sources:
      - path: sources/payments.md
    output:
      path: docs/payments-summary.md
      section: summary
    prompt: prompts/summarize.md
    generatorVersion: fake-1
    runner:
      command: node
      args:
        - scripts/generate.mjs

  checkout-spec:
    sources:
      - target: payment-summary
      - path: sources/checkout-policy.md
    output:
      path: specs/checkout.md
      section: payment-requirements
    prompt: prompts/spec.md
    generatorVersion: fake-1
    runner:
      command: node
      args:
        - scripts/generate.mjs
```

A target has one managed section. Several targets may own different sections of the same file. The prototype does that: `checkout-spec` and `checkout-risk` both write `specs/checkout.md`. Two targets may not claim the same path and section.

Validation rejects unknown targets, dependency cycles, a target that lists its own output as a source, a path source that is some target's managed output, absolute paths, `..`, symlink escapes, and URI or remote paths. Errors include the manifest file, line, and column. Unknown fields are rejected so a typo does not silently drop a dependency.

Paths are relative to the repository root. specdeps resolves each path component, refuses a symlink that leaves the root, and reads the file itself. It never follows a source into a URL.

## Commands

Global options: `--root <dir>`, `--manifest <path>`, `--json`, `--help`, `--version`.

| Command | What it does | Exit |
| --- | --- | --- |
| `specdeps init` | Writes `specdeps.yaml` with an empty target map. Refuses if that file exists. | 0, or 2 if it would overwrite |
| `specdeps init --example` | Writes the prototype fixture. Refuses if any of those files exist. | 0, or 2 |
| `specdeps status` | Prints each target's state and the reasons. `--strict` exits 1 unless every target is current. | 1 when a target is `conflict` or `blocked` |
| `specdeps plan [target]` | Read-only. Shows what `build` would do. Does not run a generator. | 0 |
| `specdeps build [target]` | Runs stale and unbuilt targets in dependency order, including upstream targets that the selection needs. Writes a proposal under `.specdeps/proposals/`. Does not edit live documents. | 1 if any selected target fails, conflicts, or is blocked |
| `specdeps diff <proposal-id>` | Unified diff plus the target ids, files, and reasons. | 1 if the id is unknown |
| `specdeps apply <proposal-id>` | Applies a proposal only when every recorded file hash still matches and the manifest shape is unchanged. Does not run the generator. | 1 if the proposal is stale |
| `specdeps adopt <target>` | Records the current non-empty section as the conflict baseline. | 1 if the section is empty or already recorded |
| `specdeps doctor` | Checks markers, manifest references, cycles, missing files, symlink escapes, and state integrity. Stale and unbuilt targets are warnings. | 1 on errors |

`--json` prints one JSON document to stdout for CI. Usage errors are JSON on stdout too, with `"ok": false`.

`build checkout-spec` also rebuilds upstream targets that are not current. It does not rebuild unrelated targets. A second build, after a successful apply and no input changes, runs zero generators.

An upstream generator failure blocks dependents in that run. Other targets that do not depend on it still build. Apply is all-or-nothing for the proposal: if any precondition file changed after the proposal was written, no file is modified.

## Generator protocol

specdeps spawns `runner.command` with `runner.args` and no shell. The working directory is the repository root. Stdin is a single JSON object:

```json
{
  "protocolVersion": 1,
  "target": "payment-summary",
  "section": "summary",
  "prompt": "contents of the declared prompt file",
  "sources": [
    { "id": "sources/payments.md", "kind": "path", "content": "full source file" },
    { "id": "payment-summary", "kind": "target", "content": "generated section only" }
  ]
}
```

Stdout must be JSON of the form `{ "content": "markdown interior" }`. A non-zero exit, a timeout (30 seconds), or more than 1 MiB of stdout fails that target. Content is normalized to `\n` line endings. A non-empty section is stored with a trailing newline so the end marker stays on its own line. The interior is what gets hashed and compared; the marker lines stay put.

`examples/prototype/scripts/generate.mjs` is a deterministic stand-in. It turns source bullets into section text and exits 1 when a source contains `SIMULATE_UPSTREAM_FAILURE`. It does not read the output document and it does not use the network.

## Layout and state

```text
specdeps.yaml
sources/payments.md
docs/payments-summary.md
specs/checkout.md
.specdeps/state.json
.specdeps/proposals/<sha256>.json
```

The prototype also has a shipping document and a checkout risk section so an unrelated target can stay current, plus `docs/unrelated.md`, which is not a target at all. `specdeps init --example` creates that tree. The example `.gitignore` ignores `.specdeps/`.

Proposal ids are the SHA-256 of the canonical proposal body. Applying a proposal updates state only after the files are written. Running apply again fails because the output hashes no longer match the proposal's preconditions.

## Proof

`npm test` runs the engine against the prototype and the deterministic generator. The tests assert all of the following:

1. Editing `sources/payments.md` makes `payment-summary` and `checkout-spec` stale.
2. `shipping-note` stays current, and `docs/unrelated.md` is byte-identical.
3. Rebuild writes new generated text for the affected sections.
4. `Client exception: refunds require manual approval above $500.` and the surrounding human-owned bytes survive byte-for-byte, including the trailing spaces on the owner-note line.
5. Editing inside a generated section yields `conflict`, runs no generator, and leaves the file untouched.
6. Changing a file after a proposal is created makes `apply` refuse. Neither the edited file nor the other files in the proposal are written.
7. A failing payment generator does not run `checkout-spec`.
8. A second build with no input changes invokes no generator.

The same suite rejects cycles, unknown targets, output collisions, self-dependencies, remote paths, path escapes, symlink escapes, and generated ownership markers. A scan of `src/` fails if the implementation starts fetching over HTTP.
