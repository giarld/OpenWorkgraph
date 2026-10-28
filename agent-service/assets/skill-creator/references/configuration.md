# Configuration format v1

## Status and purpose

The owner confirmed that no existing configuration schema is available and requires `config.json` for all OpenWorkgraph configuration declarations. Structured declarations support configuration UI: labels, descriptions, required flags, and sensitive-input handling. **The format below is a new repository contract, not a claim about an existing OpenWorkgraph parser.** Application-side parsing, locale selection, and environment injection need integration against this contract.

`config.json` declares inputs; it does not store configured secret values. [config.schema.json](config.schema.json) is the machine-readable schema. The bundled `scripts/validate_config.py` checks this format and extra semantic constraints without third-party dependencies.

## Fields

| Field | Type | Meaning |
| --- | --- | --- |
| `version` | integer | Required. Currently `1`; a consumer must reject unsupported versions. |
| `environment` | array | Required. Environment-variable declarations; use `[]` when none are needed. |
| `environment[].name` | string | Required. Exact portable variable name: `[A-Za-z_][A-Za-z0-9_]*`; unique within the file. |
| `environment[].label` | string | Required. English user-facing label. |
| `environment[].description` | string | Required. English purpose and any mode-specific requirement. |
| `environment[].required` | boolean | Required. Whether the whole skill needs the input; use `false` for mode-specific inputs and explain the condition. |
| `environment[].secret` | boolean | Required. Whether this input is sensitive and should be masked by a consumer. |
| `environment[].default` | string | Optional. Documented non-secret default only; forbidden when `secret` is `true`. Empty means an explicitly empty string, not an omitted value. |
| `environment[].translations` | object | Optional. Language-tag keys mapped to translated `label` and `description`. Consumers use the English fields when no translation matches. |

All environment values are strings. Numeric or boolean semantics belong to the consuming tool. Unknown fields are rejected in v1; extend the contract deliberately rather than teaching agents to invent UI controls.

An empty configuration:

```json
{"version": 1, "environment": []}
```

A configuration example (fictional skill; these are not inputs to this creator):

```json
{
  "version": 1,
  "environment": [
    {
      "name": "EXAMPLE_API_KEY",
      "label": "API key",
      "description": "Required for requests to the example service.",
      "required": true,
      "secret": true,
      "translations": {
        "zh-CN": {
          "label": "API 密钥",
          "description": "调用示例服务时必须提供。"
        }
      }
    },
    {
      "name": "EXAMPLE_OUTPUT_FORMAT",
      "label": "Output format",
      "description": "Format consumed by the example export tool.",
      "required": false,
      "secret": false,
      "default": "json"
    }
  ]
}
```

## Inventory and conversion

Trace variables from source instructions, scripts, references, and examples. Distinguish user-configurable inputs from ordinary system variables and internal temporary variables. For each input determine the exact name, consumer, purpose, sensitivity, required modes, documented default, and credential acquisition instructions when known. Map only demonstrated facts; do not expose every variable found in the source.

Preserve runtime names. A variable may be mandatory for a specific mode while `required` is false for the skill overall; document that condition in `description` and the README. Add translations for the languages included in the README when useful to the configuration UI.

If an existing `config.json` uses this format, merge declarations without removing unrelated entries or changing supported settings. If it uses another format, inspect consumers before mapping. For separate-destination conversion, retain the original configuration under an explicitly documented non-conflicting resource path when safe, and update consumers if the user authorizes the necessary change. For in-place conversion, do not overwrite the original blindly: propose a migration or obtain a choice when both consumers need the root filename. Report unresolved conflicts instead of presenting the package as complete.

Do not copy raw configured credentials or `.env` files into the package. Unknown fields may contain values rather than declarations; inspect their meaning before preserving them in distributable files. The `secret` flag is a declaration for consumers, not encryption or access control.

## Configuration artifact

Always use `config.json`. Do not generate an `env.example` as an alternative. During conversion, identify dependencies on existing dotenv examples or loaders and preserve necessary runtime behavior without treating those files as OpenWorkgraph configuration declarations. Do not claim the declaration file itself sets environment variables; injection is a responsibility of the application consuming it.
