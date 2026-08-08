# Persona templates

`template.zh.md` and `template.en.md` are public, generic starting points. Copy one to a new file in this directory, personalize the copy, and point `persona_path` at it.

All other `personas/*.md` files are ignored by default because deployment prompts may contain private identity, relationship, or operating context. The repository does not treat a tracked template as a secret store.

Existing Git history may still contain files removed from the current HEAD. Removing those historical objects would require a separate, explicitly coordinated history rewrite and credential/privacy review.
