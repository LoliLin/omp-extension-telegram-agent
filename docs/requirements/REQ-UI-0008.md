# REQ-UI-0008: 为 `/tg` 提供原生分级命令补全

- **Status:** Proposed（2026-08-08 已调查，未实现）
- **Priority:** P2
- **Source:** 用户新增 REQ-LIST：「Pi 支持命令二级/多级菜单；tg 现在没有自动补全，很难用」
- **依赖:** REQ-UI-0004；与 REQ-UI-0005/0007 的新子命令协同

## 问题

extension 只注册一个 `/tg`，handler 手工解析 `args.split()`；description 虽列出子命令，但没有 `getArgumentCompletions`。输入 `/tg ` 时 Pi 无法提示 attach/more/panel 等，bot id 与 `off` 也只能靠记忆。

## 调查结论

- Pi `registerCommand` 原生支持 `getArgumentCompletions(argumentPrefix)`，可同步或异步返回 `{value,label,description}`。
- callback 收到 `/tg` 后的**完整 argument prefix**，Pi 选择后会替换这段完整 prefix。因此多级补全可用一个命令树实现：一级返回完整 `attach`，二级返回完整 `attach A`，未来三级同理。
- 不需要 `addAutocompleteProvider`、custom editor 或额外 overlay；用 command 原生 API 才能与 Pi slash menu/fuzzy matching 共存。
- bot id 是配置动态数据，completion 必须从已验证 config 取 id/name，不能写死 A/B。

## 目标

用户输入 `/tg `、`/tg att`、`/tg attach `、`/tg panel ` 等前缀时，Pi 原生命令菜单逐级给出合法子命令、bot id 与特殊值；选择后产生可直接执行的完整参数串。

## 非目标

- 不建立自己的 popup/menu、键盘处理或 fuzzy matcher。
- 不改变 command handler 的业务语义。
- 不为非法自由文本自动猜 bot id。

## 需求

- **R1 — 声明式命令树：** 以一个共享表定义 subcommand、description、参数节点与 handler dispatch；补全和 usage/help 从同一表派生，避免三份命令清单漂移。
- **R2 — 一级补全：** 空/部分 prefix 返回 attach、more、detach、panel、status、start、stop、status-daemon；实现 UI-0005/0007 后追加 compose 等新节点。
- **R3 — 动态二级：** `attach|status|compose` 返回配置 bot ids（label 含 name）；`panel` 返回 bot ids + off；无参数命令在完整匹配后不建议伪参数。
- **R4 — 任意深度：** parser 根据完整 argument prefix 定位当前 tree node，item.value 必须是替换后完整参数串（如 `panel A`），以适配 Pi 的 replace-entire-argument semantics。
- **R5 — 错误与性能：** config 不可读时 completion 返回安全的静态一级项或 null，不抛错、不显示 secret/path；回调不做网络/DB/LLM I/O。
- **R6 — 原生兼容：** 只使用 `registerCommand.getArgumentCompletions`；不得替换 editor 或覆盖基础 autocomplete provider。
- **R7 — help 一致：** `/tg` 空执行时显示同一命令树生成的简洁 help；新增/删除子命令的测试必须同时锁 handler、completion 与 help。

## 验收标准

- **AC1:** prefix `""`/`"att"`/`"attach "`/`"panel o"` 分别返回正确一级、attach bot 清单与 `panel off`；value 是完整可执行 args。
- **AC2:** 三 bot fixture A/B/C 自动出现在 attach/status/compose，未知 id 不出现；id/name 不泄露 token env value。
- **AC3:** 叶子命令 `more`/`detach`/`start` 不产生无意义次级项。
- **AC4:** completion 每个建议喂给同一 handler parser都可执行或只因外部 daemon 状态失败，不因语法漂移失败。
- **AC5:** config error、前后空格、连续空格、partial bot id、future third-level node 有纯函数测试。
- **AC6:** 真实 Pi TTY 输入 `/tg ` 可看到原生菜单并逐级 Tab/选择；`bun test`、`bun run check`、cache golden 通过。

## 约束

- Cache impact: **NONE**。autocomplete/help 是 TUI-only deterministic code，不进入 provider context。
- Token impact: 0；completion 不能触发模型调用。
- command tree 是唯一语法源，避免为了“菜单”注册大量顶级 `/tg-*` 命令污染 Pi command list。

## 例子与边界 case

- `/tg p` → `panel`；选中后 `/tg panel ` → `A (小雪)`、`B (小雨)`、`off`。
- `/tg attach C` 在 C 被移除后：completion 不再建议，handler 仍给出明确 invalid id。
- future `/tg config bot A`：tree 可以返回完整 `config bot A`，无需修改 editor。

## 可观察性

无生产 telemetry 必要；测试覆盖 command tree 的所有叶子与动态节点即可。

## 文档影响

`docs/runbooks/daemon.md`、extension command help、`docs/testing.md`。

## 待决问题

无；Pi 原生 API 足够表达当前 N-level 需求。

## 追溯

- Plans: 实现前建立
- Commits: 从 `Requirement:` git trailer 查
