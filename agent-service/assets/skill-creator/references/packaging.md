# OpenWorkgraph packaging

## Required files

OpenWorkgraph skills retain the standard `SKILL.md` entrypoint and add English `README.md`, localized `README.<language-tag>.md` files when applicable, and `config.json` for configuration declarations. English is the fallback for unmatched languages. `README.zh-CN.md` is the Simplified Chinese variant.

For this official repository, new skills live in `skills/<skill-name>/` and include English and Simplified Chinese READMEs. These layout and localization defaults are repository conventions; a user-selected destination or set of languages takes precedence.

Example structure:

```text
example-skill/
├── SKILL.md
├── README.md
├── README.zh-CN.md
├── config.json
└── scripts/           # Only when executable helpers are needed
```

Keep optional `agents/openai.yaml`, references, assets, and scripts when useful. Do not generate placeholders for unused resources.

## Human-facing README

Describe what the skill does, when to use it, prerequisites, realistic invocation examples, required and optional configuration, outputs, and material limitations. Keep agent workflow details in `SKILL.md` to avoid two competing instruction sources.

Localized READMEs describe the same behavior in another language. Do not translate executable names, environment-variable identifiers, paths, or API identifiers. Update affected translations when configuration or prerequisites change. Localized files are documentation, not alternate agent entrypoints.

When converting a non-English default README, preserve its useful content under the corresponding language filename before writing the English fallback. Check for existing localized files before replacement and merge useful content rather than losing it.

## Conversion boundaries

Compare the source and destination to ensure resources and relative paths still work. Preserve supported frontmatter, licenses, attribution, and existing invocation policies. Conversion adds product packaging; workflow changes need a concrete compatibility reason or user request.

Use the configuration reference to inventory environment variables and handle schema conflicts. All OpenWorkgraph configuration declarations use `config.json`; do not generate an `env.example` as an alternative configuration artifact.

## Validation checklist

1. `SKILL.md` and English `README.md` are nonempty; `config.json` and requested localized READMEs exist with exact filenames.
2. YAML frontmatter contains nonempty `name` and `description`. The name matches the directory and satisfies naming rules. Preserve supported optional fields and remove unfinished initializer placeholders.
3. Relative links and referenced scripts/assets resolve or document external dependencies. Run new or changed scripts with representative inputs.
4. Configuration conforms to [config.schema.json](config.schema.json) and passes the bundled validator, including unique variable names and the rule against secret defaults.
5. All actual user-configurable variables are accounted for; declarations, runtime consumers, and README examples use identical names. Do not print candidate secret values during checks.
6. English and localized READMEs agree on capabilities, prerequisites, configuration, and examples. English remains the fallback.
7. Conversion preserves source resources, attribution, metadata, policies, and unrelated settings. Inspect intentional behavior changes and report unresolved conflicts.
8. Report checks that could not run. Repository validation does not prove application loading, environment injection, or successful execution of the skill workflow.
