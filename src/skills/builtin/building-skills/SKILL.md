---
name: building-skills
description: Create Coven Code skills for a codebase or workflow
---

# Building Skills

Use this skill when the user asks to create a new Coven Code skill for a codebase,
workflow, service, or repeated task.

## Workflow

1. Identify the task the skill should help with and where it should live.
2. Create a skill directory with a `SKILL.md` file.
3. Add YAML frontmatter with a unique `name` and concise `description`.
4. Write clear instructions, examples, and any resource paths the agent should use.
5. Keep the skill focused so it is loaded only when its description matches.

Project skills live in `.agents/skills/<name>/`. User-wide skills live in
`~/.config/agents/skills/<name>/`.
