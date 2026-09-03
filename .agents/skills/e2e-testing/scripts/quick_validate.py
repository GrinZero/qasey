#!/usr/bin/env python3

import re
import sys
from pathlib import Path

import yaml


def validate(skill_directory: Path) -> None:
    skill_file = skill_directory / "SKILL.md"
    if not skill_file.is_file():
        raise ValueError("SKILL.md not found")

    content = skill_file.read_text(encoding="utf-8")
    frontmatter_match = re.match(r"^---\n(.*?)\n---", content, re.DOTALL)
    if not frontmatter_match:
        raise ValueError("invalid YAML frontmatter")

    frontmatter = yaml.safe_load(frontmatter_match.group(1))
    if not isinstance(frontmatter, dict):
        raise ValueError("frontmatter must be a mapping")

    allowed = {"name", "description", "license", "allowed-tools", "metadata"}
    unexpected = set(frontmatter) - allowed
    if unexpected:
        raise ValueError(f"unexpected frontmatter keys: {', '.join(sorted(unexpected))}")

    name = frontmatter.get("name")
    if not isinstance(name, str) or not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", name):
        raise ValueError("name must use lowercase hyphen-case")

    description = frontmatter.get("description")
    if not isinstance(description, str) or not description.strip():
        raise ValueError("description must be a non-empty string")
    if len(description) > 1024 or "<" in description or ">" in description:
        raise ValueError("description is invalid")

    body = content[frontmatter_match.end():]
    if re.search(r"(?m)^\s*\[TODO:[^\n]*\]\s*$", body):
        raise ValueError("Skill contains an unfinished TODO")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("Usage: quick_validate.py <skill-directory>")
    try:
        validate(Path(sys.argv[1]))
    except (OSError, ValueError, yaml.YAMLError) as error:
        raise SystemExit(f"Skill validation failed: {error}") from error
    print("Skill is valid!")
