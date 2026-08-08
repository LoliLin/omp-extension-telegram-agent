# Persona templates

`template.zh.md` and `template.en.md` are public, generic starting points. Copy one to a new file in this directory, personalize the copy, and point `persona_path` at it.

`/tg config` performs that copy for a first bot and writes the result to an ignored `personas/<id>.local.md`. Pi's native credential inputs are visible, so run onboarding in a private terminal and avoid screen sharing.

中文：`template.zh.md` / `template.en.md` 是公开通用模板。首次运行 `/tg config` 会把所选模板写入被忽略的 `personas/<id>.local.md`；请在本机副本中填写身份和边界，不要把真实 deployment persona 提交到 Git。

All other `personas/*.md` files are ignored by default because deployment prompts may contain private identity, relationship, or operating context. The repository does not treat a tracked template as a secret store.

Existing Git history may still contain files removed from the current HEAD. Removing those historical objects would require a separate, explicitly coordinated history rewrite and credential/privacy review.
