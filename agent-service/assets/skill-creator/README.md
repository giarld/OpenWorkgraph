# OpenWorkgraph Skill Creator

[简体中文](README.zh-CN.md)

Create or update OpenWorkgraph skills, or convert existing OpenAI and agents/skills-compatible skills into OpenWorkgraph packages.

## Capabilities

- Write focused agent instructions and add resources when useful.
- Add English fallback and localized READMEs and structured `config.json` declarations.
- Preserve existing workflows, resources, licenses, metadata, and invocation policies during conversion.
- Identify environment-variable requirements and validate repository packaging.

## Usage

Invoke the skill in an agent that supports `SKILL.md`, supplying a task or source directory and destination:

```text
Use $openworkgraph-skill-creator to create a skill that summarizes local CSV files.
Save it in skills/csv-summary with English and Simplified Chinese READMEs.
```

```text
Use $openworkgraph-skill-creator to convert ./existing-skill into
./skills/existing-skill for OpenWorkgraph. Preserve the source workflow.
```

The official repository uses `skills/<skill-name>/`. Conversion defaults to a separate destination; request in-place conversion explicitly when needed.

## Requirements and configuration

The agent needs filesystem access to the source and destination. This creator requires no API keys, environment variables, network access, or separately installed skill-creator. Python 3 runs the bundled configuration validator without third-party dependencies; upstream frontmatter validation tooling is optional.

Its `config.json` declares version `1` and an empty `environment` array. All configuration declarations use `config.json`. See [configuration format](references/configuration.md) for environment-variable fields, localization, and secret handling.

The configuration format is newly defined in this repository because no existing product schema was supplied. OpenWorkgraph application parsing and environment injection still need integration; repository validation does not prove application compatibility.

## Output and validation

A skill directory contains `SKILL.md`, English `README.md`, `config.json`, requested localized READMEs, and justified resources. New skills in this official repository include `README.zh-CN.md`. Publishing and installation require a separate request.

From this creator's directory, validate a target configuration with:

```bash
python3 scripts/validate_config.py /path/to/target-skill/config.json
```

The completion report describes files changed, validation, and unresolved integration requirements. See [SKILL.md](SKILL.md) for agent instructions and [packaging reference](references/packaging.md) for the checklist.
