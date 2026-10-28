#!/usr/bin/env python3
"""Validate OpenWorkgraph config v1 with no third-party dependencies.

Mirrors references/config.schema.json and additionally checks unique variable
names and duplicate JSON keys. Diagnostics contain locations, never values.
"""

import argparse
import json
from pathlib import Path
import re
import sys


class ConfigError(ValueError):
    pass


def unique_keys(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ConfigError("Duplicate JSON key")
        result[key] = value
    return result


def reject_constant(_value):
    raise ConfigError("Non-standard JSON number")


def check_object(value, required, optional, location):
    if not isinstance(value, dict):
        raise ConfigError(f"{location}: expected an object")
    if set(value) - required - optional:
        raise ConfigError(f"{location}: unsupported fields")
    if required - set(value):
        raise ConfigError(f"{location}: missing required fields")


def check_text(value, location):
    if not isinstance(value, str) or not value.strip():
        raise ConfigError(f"{location}: expected nonblank text")


def validate_config(config):
    check_object(config, {"version", "environment"}, set(), "config")
    if type(config["version"]) is not int or config["version"] != 1:
        raise ConfigError("config.version: expected integer 1")
    if not isinstance(config["environment"], list):
        raise ConfigError("config.environment: expected an array")
    names = set()
    for index, variable in enumerate(config["environment"]):
        location = f"config.environment[{index}]"
        check_object(variable, {"name", "label", "description", "required", "secret"},
                     {"default", "translations"}, location)
        name = variable["name"]
        if not isinstance(name, str) or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", name):
            raise ConfigError(f"{location}.name: invalid variable name")
        if name in names:
            raise ConfigError(f"{location}.name: duplicate variable name")
        names.add(name)
        for field in ("label", "description"):
            check_text(variable[field], f"{location}.{field}")
        for field in ("required", "secret"):
            if type(variable[field]) is not bool:
                raise ConfigError(f"{location}.{field}: expected boolean")
        if "default" in variable:
            if variable["secret"]:
                raise ConfigError(f"{location}.default: forbidden for secret inputs")
            if not isinstance(variable["default"], str):
                raise ConfigError(f"{location}.default: expected string")
        if "translations" in variable:
            translations = variable["translations"]
            if not isinstance(translations, dict):
                raise ConfigError(f"{location}.translations: expected an object")
            for locale, translation in translations.items():
                # Use positions rather than untrusted keys in diagnostics.
                translated_location = f"{location}.translations entry"
                if not re.fullmatch(r"[a-z]{2,3}(-[A-Za-z0-9]{2,8})*", locale):
                    raise ConfigError(f"{translated_location}: invalid language tag")
                check_object(translation, {"label", "description"}, set(), translated_location)
                for field in ("label", "description"):
                    check_text(translation[field], f"{translated_location}.{field}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("config", type=Path, help="Target config.json")
    args = parser.parse_args()
    try:
        config = json.loads(args.config.read_text(encoding="utf-8"),
                            object_pairs_hook=unique_keys, parse_constant=reject_constant)
        validate_config(config)
    except json.JSONDecodeError as error:
        print(f"Invalid JSON at line {error.lineno}, column {error.colno}", file=sys.stderr)
        return 1
    except (OSError, UnicodeError):
        print("Cannot read UTF-8 configuration file", file=sys.stderr)
        return 1
    except ConfigError as error:
        print(str(error), file=sys.stderr)
        return 1
    print("Configuration is valid for OpenWorkgraph repository format v1.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
