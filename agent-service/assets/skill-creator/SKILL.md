---
name: openworkgraph-skill-creator
description: Create or update OpenWorkgraph skills, or convert existing OpenAI and agents/skills-compatible skills into OpenWorkgraph packages with localized READMEs and environment-variable configuration. Use when the requested output is an OpenWorkgraph skill.
---

# OpenWorkgraph Skill Creator

Create useful, self-contained skills that retain OpenAI and agents/skills compatibility while adding OpenWorkgraph's human-facing documentation and configuration. Support new skills, updates, and conversion of existing skills.

## Package contract

Each skill is a directory named after its frontmatter `name` and contains:

- `SKILL.md`: agent instructions with YAML frontmatter containing `name` and `description`.
- `README.md`: English documentation and fallback when no README matches the user's language.
- `config.json`: configuration declarations using the repository's versioned format.
- `README.<language-tag>.md`: localized documentation when requested. Use `README.zh-CN.md` for Simplified Chinese; new skills in this official repository include both English and Simplified Chinese.

Keep optional `agents/openai.yaml`, scripts, references, and assets only when they serve the skill. README files and configuration are packaging requirements here even though generic skills may not require them. They do not replace `SKILL.md`.

Read [references/packaging.md](references/packaging.md) before writing or converting a package. For configuration fields and examples, read [references/configuration.md](references/configuration.md). The JSON schema is [references/config.schema.json](references/config.schema.json).

## Shared design rules

- Assume the agent is capable. Include domain knowledge and decisions that change its behavior; omit generic advice and repeated policies.
- Preserve the user's intent, requested scope, and existing authorization. A skill does not grant permission for external actions.
- Keep descriptions concise and discriminating. Put substantial conditional guidance in linked references, loaded only when needed.
- Name new skills with lowercase letters, digits, and single hyphens, under 64 characters. Avoid leading or trailing hyphens.
- Respect the requested output directory. In this official repository use `skills/<skill-name>/`; elsewhere follow the destination repository's layout. Personal installation is a separate task.
- Keep automatic skill selection enabled by default. Preserve existing invocation policies unless the user requests a change.
- Never include actual credentials in instructions, READMEs, configuration, examples, or validation output.

## Create a skill

Infer inputs, outputs, dependencies, and necessary environment variables from the request and project evidence. Ask only for missing information that materially affects the result; continue independent work while waiting.

Write `SKILL.md` around the actual workflow and useful decision criteria. Add executable helpers when repeated deterministic work justifies them; run new or changed helpers. Add references for substantial conditional guidance and assets when they belong in generated output. Remove unfinished scaffolding and empty resource directories.

Write English and requested localized READMEs for human users: capabilities, prerequisites, invocation examples, configuration, outputs, and material limitations. Keep operational instructions authoritative in `SKILL.md`. Declare only variables actually needed by the skill or its tools. A skill without configuration still has `config.json` with `version: 1` and an empty `environment` array.

For optional `agents/openai.yaml`, use supported interface fields, quote string values, and include `$<skill-name>` in a supplied default prompt. Preserve unrelated policy and dependency fields on updates. Do not make the generated skill depend on a separately installed skill-creator or its scripts.

## Convert an existing skill

Inspect source instructions, resources, README variants, metadata, license, and environment-variable usage before changing anything. Read relevant scripts and linked references to identify dependencies. Do not copy private `.env` files, credentials, caches, or unrelated files.

Default to a separate destination package; convert in place when requested. Resolve destination conflicts within existing authorization, or ask before overwriting conflicting work. Preserve licenses and attribution; report incompatible reuse conditions instead of silently removing them.

Preserve working instructions, supported frontmatter, resource paths, script behavior, and existing `agents/openai.yaml` policies and dependencies. Add packaging files and make only necessary compatibility changes. Do not rename a working skill or rewrite its workflow merely to apply a preferred style. If a rename is necessary, update affected references and invocations consistently.

Preserve useful existing README content. Ensure `README.md` is English; retain a non-English default README under its matching language filename before replacing it. Add missing requested translations and align prerequisites, variable names, and examples across languages.

Map existing configuration to the target format only when field semantics are understood. Preserve unrelated settings; do not silently discard unsupported fields or overwrite a differently structured `config.json`. Follow the conflict handling in [references/configuration.md](references/configuration.md). Do not change an API key's runtime variable name to suit the packaging.

If a dependency cannot run in the target environment, document the limitation. Adding README/configuration files does not establish runtime compatibility.

## Validate and deliver

Use the checklist in [references/packaging.md](references/packaging.md). Run the bundled configuration validator:

```bash
python3 scripts/validate_config.py /path/to/target-skill/config.json
```

The script path is relative to this creator's directory. It validates repository configuration invariants, not YAML or application execution. If upstream `quick_validate.py` is available, run it for frontmatter; otherwise validate YAML with available tooling and check naming, required fields, and unfinished scaffolding directly. Do not assume upstream tooling is bundled here.

Check resources, localization filenames, variable coverage, and preservation of the source. Exercise new scripts and changed behavior with representative inputs. A documentation-only conversion does not require executing external operations.

Report the destination, changed files, checks performed, and unresolved runtime or integration limitations. Distinguish repository validation from successful loading and environment injection in OpenWorkgraph. Do not commit, publish, install, or perform a generated skill's external actions unless requested.
