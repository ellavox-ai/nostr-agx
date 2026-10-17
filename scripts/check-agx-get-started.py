"""Validate the shared skill and its local references; no network or agent calls."""
import json
import re
import sys
from pathlib import Path
from urllib.parse import unquote

import yaml


def check(root):
    text = (root / "SKILL.md").read_text()
    match = re.match(r"\A---\n(.*?)\n---", text, re.S)
    if not match:
        raise ValueError("Missing skill frontmatter")
    data = yaml.safe_load(match[1])
    if not isinstance(data, dict) or not {"name", "description"} <= data.keys():
        raise ValueError("Skill requires name and description")
    if data.keys() - {"name", "description", "license", "allowed-tools", "metadata"}:
        raise ValueError("Unexpected skill metadata")
    name, description = data["name"], data["description"]
    if not isinstance(name, str) or len(name) > 64 or not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", name):
        raise ValueError("Invalid skill name")
    if not isinstance(description, str) or not description.strip() or len(description) > 1024 or re.search(r"[<>]", description):
        raise ValueError("Invalid skill description")
    links = files = 0
    for path in root.rglob("*"):
        relative = path.relative_to(root)
        if "node_modules" in relative.parts:
            continue
        if ".agx-test" in relative.parts or path.name == "request-plan.json":
            raise ValueError(f"Runtime identity/request state in skill: {relative}")
        if not path.is_file():
            continue
        files += 1
        if path.suffix == ".json":
            json.loads(path.read_text())
        if path.suffix != ".md":
            continue
        content = path.read_text()
        if re.search(r"^\s*\[TODO:[^\n]*\]\s*$", content, re.M):
            raise ValueError(f"Unfinished scaffold: {relative}")
        fence = None
        for line in content.splitlines():
            found = re.match(r"^\s*(`{3,}|~{3,})(.*)$", line)
            if found:
                marker, suffix = found.groups()
                if fence is None:
                    fence = (marker[0], len(marker))
                elif marker[0] == fence[0] and len(marker) >= fence[1] and not suffix.strip():
                    fence = None
        if fence:
            raise ValueError(f"Unclosed code fence: {relative}")
        for raw in re.findall(r"\[[^\]]+\]\(([^)]+)\)", content):
            raw = raw.strip().strip("<>")
            if re.match(r"[a-zA-Z][\w+.-]*:", raw):
                continue
            target, _, anchor = unquote(raw).partition("#")
            resolved = (path.parent / target).resolve() if target else path
            if not resolved.is_relative_to(root) or not resolved.exists():
                raise ValueError(f"Missing or external local reference in {relative}: {raw}")
            if anchor and resolved.suffix == ".md":
                headings = {
                    re.sub(r"[^\w\- ]", "", line.lstrip("#").strip().lower()).replace(" ", "-")
                    for line in resolved.read_text().splitlines() if line.startswith("#")
                }
                if anchor not in headings:
                    raise ValueError(f"Missing anchor in {relative}: {raw}")
            links += 1
    print(f"Valid skill: {files} source files, {links} local references; no runtime state")


if __name__ == "__main__":
    try:
        check(Path(sys.argv[1]).resolve())
    except (IndexError, ValueError, OSError, yaml.YAMLError) as error:
        sys.exit(f"Skill validation failed: {error}")
