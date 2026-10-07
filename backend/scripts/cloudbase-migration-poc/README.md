# CloudBase PostgreSQL migration POC (optional server-contract study)

> **当前迁移路线已由管理者选定：本地破坏性迁移验证使用 Docker PostgreSQL；`dghc-d4glx42yj3c96bc06` 是实际迁移目标。无需另建 CloudBase POC 环境，本目录的远端 CLI 故障注入不属于当前迁移前置门槛。**

Status: optional static preparation. No SQL, CloudBase CLI command, test, deployment, or database connection has been run from this directory. 本目录只用于将来确有必要时单独研究 CloudBase CLI 服务端事务/history/repair 合同；不能把其结果与本机 Docker 验证混为一谈，也不能对 `dghc` 执行这里的故障夹具。

## 当前采用的迁移/验证路径

- 所有破坏性迁移脚本回归、失败回滚、重跑幂等及 schema 检查，先在受限 localhost 端口、无持久卷、设置内存上限的临时 Docker PostgreSQL 中完成；迁移 SQL 的唯一规范来源仍为 `backend/migrations/`。
- 实际迁移目标是用户指定的 CloudBase PostgreSQL 环境 `dghc`。只有 Docker 回归通过、目标身份/地域及空库状态复核、函数侧 TLS 与受限迁移身份就绪、恢复/回滚步骤和迁移摘要完成验收后，才由管理者执行正式迁移与 seed。
- 应用迁移 runner 的 `public.schema_migrations` 是当前选定的唯一权威账本；不在目标上并行使用 CloudBase CLI migration history/repair，不做目标环境故障注入或测试性 DDL。
- 另建 CloudBase POC、查询其专属价格/续费/超限或执行本目录 fixtures 都是**可选研究**，不会阻断 Docker 本地验证或既定 `dghc` 正式迁移路线。若未来要执行，需另开任务、明确费用与目标授权，并且只在全新隔离环境操作。

## Hard boundary

- Use only a newly created, disposable CloudBase environment whose PostgreSQL service was selected at creation. Do not use the project/production environment `dghc-d4glx42yj3c96bc06`.
- Before **each** command that can write migration history or database state, independently verify the new POC EnvId and region in the CloudBase console and compare the EnvId against the production ID above. Require both `-e "$POC_ENV_ID"` and `-r "$POC_REGION"` on every command. Do not inherit a default environment or region.
- Set `POC_ENV_ID` only to the newly provisioned POC EnvId and `POC_REGION` only to its console-confirmed region. No account credentials or connection strings belong in this directory.
- `tcb db pg migration up --dry-run` is **not local-only**: CLI 3.8.5 calls the remote migration Preview API. It must use the same EnvId/region guard and is forbidden until the isolated environment is approved.
- A CLI success message is only a client result. Capture task ID, wait for terminal status, then independently inspect history and the disposable database. On failure or timeout, capture RequestId/TaskId and stop; do not blind-retry.
- Keep these fixtures outside `backend/migrations/` and do not copy them into the production migration tree. Each workspace below has its own `cloudbaserc.json` and `cloudbase/migrations/`, so the CLI's cwd-relative scanner is scoped to that fixture workspace.
- Never run the real 58 migrations as a fault-injection set. In particular, `0047`, `0048`, and `0055` have destructive/session/community-data effects. A later complete-ledger POC requires its own approved, empty, disposable environment.

## （可选）隔离 CloudBase POC 成本参考

以下费用资料只适用于未来另行决定创建 CloudBase POC 的场景。它不是 `dghc` 正式迁移的费用核算，也不是当前迁移任务的前置门槛；当前路线无需新建 CloudBase 环境或为此查询账号专属价格。若未来另开 CloudBase POC 研究任务，本节的核算和创建前费用确认仍适用。

腾讯官方资源点价格页当前列出的 **Singapore PostgreSQL** 公开费率为：CPU 使用量 587 点/(核·小时)，即 ¥0.587/(核·小时)；数据库容量 3.68 点/(GB·小时)，即 ¥0.00368/(GB·小时)。该页的个人版公开套餐信息为 ¥19.9/月、40,000 点/月。套餐公开标价和点数只是产品页面信息，不能证明当前账号可购资格、优惠适用、实际套餐余额、订单实付、POC 总费用或最终账单。

按公开资源点费率估算时，先取得计费周期内实际/计划用量：

```text
PG CPU 点数       = 587 × 计费 CPU 核小时
PG 容量点数       = 3.68 × 计费容量 GB小时
其他资源点数     = Σ（其他资源的计费数量 × 对应官方点单价）
预计总用量点数   = PG CPU 点数 + PG 容量点数 + 其他资源点数
预计套餐外点数   = max(0, 预计总用量点数 - 已确认可用于本账期的套餐点数 - 已确认适用的资源包点数)
资源点折算参考额 = （预计总用量点数 ÷ 1,000）元（仅作公开费率参考）
```

以下情景按 **1 核 CPU + 1 GB 计费容量，且两项都只计相同的情景时长**估算；1000 点≈¥1：

| 情景时长 | CPU 点数 | 容量点数 | 合计点数 | 点数折算参考额 |
|---:|---:|---:|---:|---:|
| 1 小时 | 587 | 3.68 | 590.68 | 约 ¥0.59 |
| 6 小时 | 3,522 | 22.08 | 3,544.08 | 约 ¥3.54 |
| 24 小时 | 14,088 | 88.32 | 14,176.32 | 约 ¥14.18 |

计算为：`CPU 点数 = 587 × 1 核 × 小时数`；`容量点数 = 3.68 × 1 GB × 小时数`；`参考额 = 合计点数 ÷ 1,000`。此表仅是公开费率情景，假设 CPU 与 1 GB 计费容量同一时长；不代表实际存储留存时长或停止计算资源后容量是否仍持续计费，也未计其他资源。它不等于账号实付、账号可用额度、最终账单或预算批准；创建前仍须由管理者按本节费用门槛核实实际计费输入及账号套餐/点数。

其中计费 CPU 核小时要用实际计费核数与活跃计费小时计算/汇总；共享 PostgreSQL 按使用量计量，独享实例按实例规格和运行时长计量。容量 GB小时要用实际计费容量与计费小时计算/汇总；共享容量按实际存储空间计量，独享容量按分配空间计量。估算套餐外点数时，还必须扣除管理者在账户账单/购买页确认的当期可用套餐点数和适用资源包余额，不能默认公开的 40,000 点可用于该 POC。点数折算额不等于订单价或账单金额。POC 的最终费用还取决于云函数/存储/流量等其他资源用量、套餐购买价格/周期、适用的抵扣与超限规则及其他独立收费项。**目前这些 POC 参数和账号账单数据不齐，因此本手册不计算或声称任何 POC 总额。**个人版公开 ¥19.9/月及 40,000 点/月不得代入为该账号的实付价格或可用余额。腾讯的新手计费说明把资源点折算比例列为 1,000 点=¥1；只有在适用计费模式和账户规则已确认后，才可将其作为资源消耗参考换算。

**仅当未来另行决定创建隔离环境时，创建前必须由管理者完成并留存以下费用确认：**

- 核对腾讯控制台/购买页当前对该账号、地域和 PostgreSQL 环境实际展示的套餐、购买周期、应付价格及账单规则；不得仅用公开套餐宣传信息代替订单证据。
- 确定本次 POC 的费用上限和观察/存续时长，并记录 CPU 核数或实例规格、预计计费小时、容量及计费小时、其他资源用量、当期可用于本环境的套餐点数/资源包余额，以及预计超限部分如何计费。
- 在创建确认前核实自动续费是开启还是关闭并记录选择；核实超限/按量开关当前状态及超过套餐余额后的实际行为。若无法确认其开关状态或费用后果，停止，不创建环境。
- 将预计总费用与管理者批准的上限逐项比较；控制台最终应付金额、账户可用点数、资源规格、计费口径或超限规则任一缺失/不符，均视为费用门槛未通过。

**费用门槛未通过时不得创建该可选 CloudBase POC 环境或 PG 资源。**本 Task 仅补充公开费率和核算方法，不登录账号、不查询私有账单、不购买或创建资源，也不代表费用门槛已通过。该要求不阻断 Docker 本地迁移验证或按当前计划对 `dghc` 执行正式迁移。

官方来源：

- [云开发 CloudBase 资源点价格文档](https://cloud.tencent.com/document/product/876/127357)（包含 Singapore PostgreSQL CPU/容量费率、公开套餐行及计费口径；页面标示最近更新 2026-09-08）。
- [云开发 CloudBase 新手指引：资源点计费](https://cloud.tencent.com/document/product/876/56375)（公开资源点折算比例及资源点计费说明）。
- [云开发 CloudBase 套餐及资源包说明](https://cloud.tencent.com/document/product/876/136006)（套餐账期、套餐操作和超限/欠费说明；账号实际适用项仍以管理者在控制台/购买页核验为准）。

## Full canonical mirror (not a fault-injection fixture)

`generate-mirror.mjs` reuses `createMigrationMirror` and `verifyMigrationMirror` from the existing adapter. It reads only `backend/migrations/` and writes to the fixed, POC-only workspace `mirror/migrations/`; it does not read environment variables, make network requests, run SQL, or invoke CloudBase. The output directory must not exist. The generator refuses to overwrite an existing mirror, and the adapter's byte comparisons use the canonical source as the authority. The full mirror is kept separate from the four failure-test workspaces.

Run the local generator only when the output path `mirror/migrations/` is absent:

```sh
node backend/scripts/cloudbase-migration-poc/generate-mirror.mjs
```

It prints the 58-entry source-to-CloudBase filename mapping, per-source raw-byte and application checksums, plus an aggregate SHA-256 of the exact map manifest after byte verification. The generated `mirror/cloudbaserc.json` selects PostgreSQL and points the CLI scanner at `./migrations`; it is retained only for a future, optional CloudBase CLI compatibility study. **Do not use the full mirror for atomicity, failure, retry, lock, or repair fault injection, and never apply it to `dghc`.** It contains the production migration SQL, including 0047 (challenge deletion and new required column), 0048 (session deletion), and 0055 (community removal and project lifecycle changes). Any optional remote study requires a separately reviewed, empty, disposable PostgreSQL environment; this preparation does not authorize CLI Preview or `up` and is not a prerequisite for the selected app-runner migration route.

## CLI contract used to prepare the fixtures

The locally inspected official `@cloudbase/cli` package is 3.8.5. Its `migration up` scanner reads `database.migrations` (default `./cloudbase/migrations`) relative to the CLI working directory, accepts `{14-digit-version}_{lowercase_underscore_name}.sql`, sorts by filename, and sends the complete file text as one migration `Query`. The command requires an EnvId. Its `up` path calls remote Preview, then Push, and polls the task. `repair` is documented by the client as changing migration history without executing SQL; the `applied` repair request includes the local Query. These facts describe the client only; they do not prove server transaction, history, lock, repair, or retry semantics.

### CLI target resolution guard

Tencent's [global CLI options documentation](https://docs.cloudbase.net/cli-v1/global-options) states for CLI v3 that EnvId resolution is `global default < project cloudbaserc.json < command-line -e/--env-id`; the default config file is `cloudbaserc.json` in the current directory, and a parent config must be selected explicitly with `--config-file`. Therefore every future fixture operation must run from its named fixture directory and include the already verified disposable POC EnvId with `-e`; never rely on root/project defaults. The [region documentation](https://docs.cloudbase.net/cli-v1/region) defines `-r/--region` as a global option. Every operation must include the console-confirmed POC region with `-r` as well. The root config and current planned POC region are both `ap-singapore`, but the command still pins it explicitly.

This documents parameter resolution only. It does **not** mean a POC environment exists, its EnvId has been approved, account billing gates passed, or any command is authorized. Preview remains a remote request; `up` and `repair` mutate remote state and remain behind their individual environment, fee, and manager gates.

Each workspace config declares only the PostgreSQL migration type and its local fixture directory. These new config files are confined to this directory; the repository's root `cloudbaserc.json` is untouched.

## POC matrix and fixture mapping

| Task 23 case | Prepared input | Observation and acceptance | Reset/cleanup |
|---|---|---|---|
| Single-file atomicity / partial execution | `fixtures/atomicity/` contains one file with a visible marker written before a deterministic runtime error. | After a failed terminal task, inspect marker and remote history. Atomicity passes only if neither marker nor successful history remains. Marker retained, success history, or ambiguous state fails; stop before retry. | Save sanitized task/history/marker evidence, then restore a pristine snapshot or destroy this POC environment. |
| Failure history and retry | Reuse the **identical** atomicity file only after recording its first failure state. Separately use `fixtures/success-retry/` for a successful application and repeat `up` to observe skip behavior. | Failed task must not be represented as successful; retry must not duplicate effects. Successful repeat should leave one effect and a single applied record. Partial effects, conflicting history, or unknown retry semantics fail closed. | Do not repair/delete history to make the retry pass. Restore or destroy the isolated environment after evidence capture. |
| Lock / concurrent push | `fixtures/concurrency/` has one slow, visible marker migration to widen the overlap window. Start two independently guarded `up` invocations against the same approved POC EnvId and workspace. | Record both TaskIds, terminal states, history, marker count, and any lock/timeout evidence. Pass only if one logical application occurs and no duplicate success/effect appears. This does not establish that the CLI lock is shared with the app runner's advisory lock. | Wait for both tasks to terminate; if either is still running or status is uncertain, stop and do not clean concurrently. Then restore/destroy the POC environment. |
| Repair then subsequent `up` | `fixtures/repair/` increments a marker on each execution. First apply successfully; capture state; then use the guarded `repair --status reverted` operation and separately run guarded `up`. | Observe repair's history-only effect, marker count, and whether `up` reruns the file. Do not infer SQL rollback from a `reverted` status. Unexpected marker changes during repair, wrong target identity, or unclear subsequent behavior fails. | Repair is a ledger mutation. Preserve before/after evidence and destroy/restore the isolated environment; never use repair on the project target. |
| Double-ledger full alignment | After all server contracts pass, prepare a separate empty POC environment and use the generated exact 58-source mirror at `mirror/migrations/` and its `cloudbase-migration-map.json`. | Compare remote history and `public.schema_migrations` version/checksum rows as continuous prefixes. POC-only fixtures are not adapter mappings: the adapter requires a continuous `0001`-based source prefix and computes CloudBase names/checksums from source files. | Preserve sanitized mapping and ledger snapshots, then restore/destroy the POC environment. No repair or full migration is authorized by this preparation. |
| Double-ledger interruption / recovery | **Manual-only placeholder:** inject/observe the boundary after remote success but before app-ledger synchronization, using the generated 58-entry mapping and a separately approved procedure. | Review the adapter's plan-only result. It must fail closed on unknown versions, checksum mismatch, non-prefix history, or app-ledger-ahead/divergent state. Any repair write requires separate manager authorization after remote success is independently established. | Capture both ledgers and task evidence; do not automatically rerun migration SQL. Restore/destroy only after tasks have terminated and manager confirms the recovery record is retained. |

## Guarded command templates (future use only; not executed here)

These examples intentionally require an operator to supply a newly provisioned POC EnvId and console-confirmed region. Stop if either is missing, the environment is not independently confirmed disposable, or the EnvId equals the production ID. Run from the named fixture workspace so CLI scanning remains scoped. The exact shell/binary invocation mechanism is an operator setup step; this document does not invoke it.

Read-only migration preview still makes a remote request:

```sh
: "${POC_ENV_ID:?Set the newly provisioned isolated POC EnvId}"
: "${POC_REGION:?Set the console-confirmed POC region}"
test "$POC_ENV_ID" != 'dghc-d4glx42yj3c96bc06' || { echo 'STOP: production EnvId'; exit 2; }
# From fixtures/atomicity, after independently confirming the POC environment:
tcb db pg migration up -e "$POC_ENV_ID" -r "$POC_REGION" --dry-run
```

Any later `up` (database/history write), including the two concurrent invocations, must repeat the same checks immediately before each invocation and omit `--dry-run` only with explicit manager approval:

```sh
: "${POC_ENV_ID:?Set the newly provisioned isolated POC EnvId}"
: "${POC_REGION:?Set the console-confirmed POC region}"
test "$POC_ENV_ID" != 'dghc-d4glx42yj3c96bc06' || { echo 'STOP: production EnvId'; exit 2; }
# From the specifically approved fixture workspace; this writes remotely:
tcb db pg migration up -e "$POC_ENV_ID" -r "$POC_REGION"
```

The repair operation also changes remote migration history. It must be separately approved and guarded in the same way, using the exact observed POC version and a recorded reason:

```sh
: "${POC_ENV_ID:?Set the newly provisioned isolated POC EnvId}"
: "${POC_REGION:?Set the console-confirmed POC region}"
test "$POC_ENV_ID" != 'dghc-d4glx42yj3c96bc06' || { echo 'STOP: production EnvId'; exit 2; }
# From fixtures/repair; the version and reason require manager review:
tcb db pg migration repair '<OBSERVED_14_DIGIT_POC_VERSION>' --status reverted --reason '<MANAGER_APPROVED_REASON>' -e "$POC_ENV_ID" -r "$POC_REGION"
```

No destroy/delete command is included: environment destruction is irreversible and requires a separate review of EnvId, backup disposition, resource inventory, billing, and the CloudBase deletion contract. Do not improvise a teardown command from this runbook.

## Evidence ledger for a future approved run

For each case, retain: UTC start/end; CLI version; reviewed EnvId and region; fixture path/name and SHA-256; command with secrets removed; Preview result if requested; RequestId/TaskId; terminal task status/reason; before/after history; before/after marker state; independent observer identity/method; pass/fail decision; and restore/destroy disposition. Do not store credentials, connection strings, API keys, or unsanitized environment dumps.

## Remaining uncertainty

- The CLI's local scanning format is source-confirmed. The server's multi-statement transaction boundary, partial-commit behavior, failure-history timing, retry contract, lock scope, repair semantics, history object name, and interaction with application advisory locks remain server-side questions.
- `migration repair --dry-run` is not evidence of remote history state. For `up --dry-run`, CLI 3.8.5 explicitly calls remote Preview.
- The adapter only produces a `writesExecuted: false` ledger-reconciliation plan. It does not execute ledger repair, and POC-only fixture files do not satisfy its production source-prefix contract.
- The future read-only method for observing marker tables and exact CloudBase history rows must be chosen by the manager for the isolated environment. No observer query or database connection method is guessed here.
