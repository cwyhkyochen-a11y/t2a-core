# v0.1.0 接力指南 — 跨 session 交接

> **写于 2026-05-02 18:47，飞书 session 卡死后由微信 session 交接**
> **目的**：让新 session 无缝接住 Phase B 剩余工作，不重复踩坑。

---

## 一、当前状态快照

**项目根目录**：`/home/admin/.openclaw/workspace/projects/t2a-core/`

**已提交 commit（master）：**
- `d9d7815` v0.1.0: 设计文档与版本目录初始化
- `f8fb6f8` feat: scaffold v0.1.0 with tsup/vitest + types.ts
- `1d37895` docs: rename to @t2a/core scope + add interrupted column + async-by-event usage

**未提交的改动（git status --short）：**
```
 M src/index.ts
?? src/agent-loop.ts       (390 行)
?? src/event-bus.ts        (125 行)
?? src/interlude-provider.ts (112 行)
?? src/message-builder.ts  (95 行)
?? src/session.ts          (330 行)
?? src/tool-registry.ts    (108 行)
```

合计 ~1160 行新增核心实现代码 + types.ts（625 行，已在前一次 commit）。

---

## 二、已完成（Phase A + Phase B 主体）

**Phase A（docs，已 commit `1d37895`）：**
- DESIGN.md / EXAMPLES.md / README 里所有 `t2a-core` 包名改成 `@t2a/core`
- SCHEMA.md 双 DDL 新增 `interrupted` 列（BOOLEAN / TINYINT(1)）
- DESIGN 增补 async-by-event 模式使用说明

**Phase B（代码，未 commit）：**
- 6 个核心模块写完（上面 git status 里列的 ??）
- 由 subagent 24aff14d 产出，中途被 kyo abort，未验证

---

## 三、未完成 & 立即待办

### 1. 验证未 commit 代码能跑
**必须先做，不要直接信任 subagent 的产出：**

```bash
cd /home/admin/.openclaw/workspace/projects/t2a-core
npx tsc --noEmit       # 期望：零错误
npm run build          # 期望：dist/ 产出 esm + cjs + dts
npm test               # 期望：测试骨架至少能跑起来
```

如果 typecheck 有错：
- 常见原因：subagent 不完全符合 types.ts 的 readonly / strict 约束
- 常见原因：`MultiPart` 传字面量数组需要 `as const`
- 逐个修，不要大改接口（接口签名已在 types.ts 敲定）

### 2. 补单测（如缺）
PLAN.md 里 v0.1.0 勾选门槛是「主类实现 + 单测覆盖」。至少要覆盖：
- EventBus：订阅/发布/tool_ 前缀强校验
- ToolRegistry：register/invoke/未知 tool 报错
- MessageBuilder：system_event 降级注入（方案 A）
- Session：状态机转换（6 状态）
- AgentLoop：基础一轮对话（需 mock LLMClient）

覆盖率目标 80%（vitest config 已设）。

### 3. 新增 src/index.ts 的导出
`src/index.ts` 目前只在 scaffold 阶段有过改动（status 里的 M）。需要导出：
- 类：Session / EventBus / ToolRegistry / DefaultInterludeProvider
- 类型：所有 types.ts 里的 public 类型
- 保持 tree-shakable（named exports，不要 default export 整个模块）

### 4. Commit + push
验证通过后统一 commit：
```bash
git add -A
git commit -m "feat(v0.1.0): core implementation — EventBus/ToolRegistry/Session/AgentLoop"
```

### 5. 发布准备（不急）
- npm org `t2a` **kyo 已注册**（2026-05-02 18:47 确认）
- npm token 存在 `~/.npmrc`（chmod 600）
- 发布命令：
  ```bash
  npm publish --access public --registry=https://registry.npmjs.org/
  ```
- 注意：全局 registry 是淘宝镜像，发包必须显式指定 npmjs
- 发布前先 `npm pack` 本地看 tarball 内容

---

## 四、已决策（不要推翻）

| # | 事项 | 决策 |
|---|------|------|
| 1 | 包名 | `@t2a/core`（有 scope，不要 `t2a-core`） |
| 2 | 存储 | Storage 接口注入，SDK 不自带 |
| 3 | system_event 降级 | A：进 LLM 时降级为 user role，前缀 `[SYSTEM EVENT from xxx]` |
| 4 | ctx.pushSystemEvent | **砍掉**，handler 从 sessionPool 取 session 调（回归 DESIGN 原意；显式 > 便利） |
| 5 | overflow | v0.1 只 reject；`/compact` 占位但不实现 |
| 6 | async-by-event | tool handler 立即返 task_id，业务用 pushSystemEvent 回写 |
| 7 | tool emit 前缀 | 强制 `tool_` 前缀，违规抛 Error |
| 8 | abort 粒度 | 只 abort LLM streaming/thinking，不 cancel 已发起异步 tool |
| 9 | AssistantMessage.interrupted | 加了，SCHEMA 同步 |
| 10 | AssistantMessage.content | 显式 `string \| null`（OpenAI 协议允许 content=null when tool_calls） |

---

## 五、踩坑提醒

- **DB schema 不要给 content 字段加 NOT NULL**（imagine v2.4 踩过）
- **abort 不 cancel 异步 tool**（generate_image/video 花了钱就让它跑完）
- **`/compact` v0.1 只占位**，识别后 emit system_notice 即可
- **tool emit 必须 `tool_` 前缀**，register 时校验，违规直接抛 Error
- **system_event 降级 prompt 要让 LLM 明确知道这是系统事实**，严格按 DESIGN § 5 模板
- **MultiPart readonly array**：业务方传字面量可能要 `as const`，审阅时留意

---

## 六、验证过的路径（不用重新探索）

- `tsup` 构建 OK：ESM + CJS + dts 三件套，dts 约 17KB
- `npx tsc --noEmit` 在 types.ts 阶段零错误
- `@t2a/core` npm 名可用（需 org，kyo 已建）
- `t2a-core` 无 scope 名也可用（但已决策放弃）

---

## 七、飞书 session 失败原因（参考）

- 上下文累积 + routetokens Opus 4.7 返回空 content
- 18:22 那轮用户问"之前的问题是什么情况？"，LLM 返回 content:[]，session 卡 done
- **教训**：长 session 不要硬扛，及时 `/new` 并用 HANDOFF.md 接力

---

_接力节点由微信 session 2026-05-02 18:47 补档，飞书 session 请直接 `/new` 从这里接住。_
