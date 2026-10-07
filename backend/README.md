# 拼豆小程序后端

> 本版不包含社区功能。活动路由、领域模型、仓库实现和专项测试已移除；历史迁移 0042–0046 仅为 checksum 兼容保留，0055 向前迁移会恢复相关项目生命周期并删除遗留表与函数。社区实现备份位于 `archive/community-feature-backup-20261005/`。0055 SHA-256：`15a1e156450ce7b78ab176fa15b08b24856383e89477c8a4f32cadb829fb05a1`。

Node.js 24 + Fastify 5 + PostgreSQL 后端。所有业务接口位于 `/api/v1`，项目网格使用稳定色号协议 `palette-code-v1`，写操作通过幂等键和乐观锁保护。

## 已实现能力

- 开发会话、Bearer Token 哈希存储、生产配置 fail-closed；`POST /auth/wechat-session` 已接入服务端 `code2session`，openid 仅保存在私有身份字段且不会返回客户端。微信重复登录会复用同一私有身份、清理该用户的过期会话，并将活跃会话限制为 5 个，超限时淘汰最旧会话。Web 端可公开创建五分钟有效的一次性挑战：创建响应分别返回只用于 `X-Web-Login-Token` 轮询的 `token`，以及只用于确认后 Bearer 登录的独立高熵 `sessionToken`；challenge create/current 响应均带 `Cache-Control: private, no-store`，数据库仅保存两个 token 的 SHA-256，确认事务只把 `session_token_hash` 写入会话。当前工作树 Web 已消费 `sessionToken`（`web/src/web-login.ts` / `adoptWebSession` / `web/test/web-login-session.test.ts`）；生产 Web 配对登录仍因真机确认与 `code2session` 实网而阻塞，不是前端未读 token。仅当非 production、绑定 loopback 且 `DEV_AUTH_ENABLED=true` 时，为兼容本地联调才会额外把 poll token 建为会话；其他环境 poll token 作为 Bearer 一律 401。由于 0047 前创建的 poll-token session 无法与普通 session 可靠区分，0048 会一次性删除全部既有 session，部署后所有端都必须重新登录，旧镜像不得重新连接。已确认挑战保留到原始过期时间，数据库约束保证 `pending`/`approved` 状态与用户、确认时间一致。创建按来源 IP 20 次/10 分钟限流，确认按来源 IP 40 次/10 分钟并叠加用户 20 次/10 分钟；匿名限流只持久化 SHA-256 键。
- `GET /me` 聚合当前用户、次数余额、作品状态、豆仓色号/豆数、活动生成任务和导出记录统计，供首页与个人页恢复展示；`stats.exports.total` 统计该用户当前仍保留的全部导出任务（不区分排队、处理中、成功、失败或取消），`succeeded` 是其中成功任务数。作品当前豆数和颜色数持久化在项目聚合字段中，列表和 `/me` 不扫描完整网格。
- 色卡、作品不可变 revision、重命名、复制、软删除、权威材料统计与版本绑定的制作进度；作品还持久化普通/像素/真人/情侣模式、独立的产品生命周期 `lifecycleStatus`、租户安全的原图/预览素材引用，以及白底/透明/指定纯色背景。既有列表字段 `status: draft|in_progress|completed` 继续只表示制作进度，未被生命周期字段替换。创建流程提交和候选采用会自动带入可推导元数据，复制保留元数据；当前 revision 导出成功自动进入 `exported`，新图纸 revision 回到 `editable` 并清除过期预览引用。`PATCH /projects/:projectId/metadata` 可不创建图纸 revision 地幂等更新这些字段，但必须同时提交 `baseRevision` 和独立的 `baseMetadataRevision`，避免两个客户端在图纸 revision 未变化时静默覆盖元数据。所有非空素材引用都要求同租户、用途匹配且已经 ready。制作进度持久化 `color`/`region`/`row-column` 导航模式、与模式匹配的可空 `navigationCursor`、已完成格子、累计制作秒数及服务端管理的开始/完成时间；游标可指向图纸中的色号、四个分区之一或合法的行/列索引，并与进度使用同一套 revision 乐观锁和幂等保存。旧客户端省略游标时，同模式更新保留原值，切换模式则清空；显式提交 `null` 也会清空。游标只用于恢复制作页位置；当前 revision 的全部非空格完成后，可用专用 `POST/GET/DELETE /projects/:projectId/completion-photos` 接口上传、分页读取和删除私有完工照。上传使用持久预约、稳定对象键和发布前二次校验，进程在对象写入后中断或同键并发时可安全重放；照片绑定精确 revision，不复用 AI 同意或临时过期时间。作品列表强制 `limit/offset` 分页并直接返回尺寸、颜色数、豆数、完成数和草稿/制作中/已完成状态，空白格不能误标为完成。编辑中的网格通过 `GET/PUT/DELETE /projects/:projectId/draft` 独立保存，只有 `POST /projects/:projectId/draft/commit` 才生成新的不可变 revision；草稿使用基础 revision 与草稿 revision 双重乐观锁，旧基础版本不会覆盖新版本。每个用户最多保留 100 个活动作品、500 个作品历史，每个作品最多 500 个 revision，所有保留 revision 合计最多 200 万格。创建先锁用户配额行，版本/名称更新按 user → project 顺序加锁，避免配额检查和并发保存采用相反锁序；软删除满 90 天的项目仅在没有活动导出和未清理导出制品时物理删除。
- 完工照的持久预约持有由数据库时钟裁决的 15 分钟上传租约，对象 `put` 另受可取消的 5 分钟超时约束。活动上传租约既阻止普通 purge 领取，也在预约/发布时用 token fencing 阻止过期 writer 提交；如果同一稳定键的迟到 writer 可能在清理后再次落盘，终止路径不会确认已 purge，而是保留 tombstone 与重试信息，待租约栅栏结束后由普通 purge 最终收敛。
- 内置色卡为版本化的 MARD 48/72/144/221/291 五档；API 同时返回品牌、系列、豆径、材质、来源版本和颜色表面类型。旧 `mard-basic-v1` 仅为历史迁移输入，已退休且禁止新建使用。`POST /palettes` 导入私有色卡时必须分别提供品牌与系列，跨品牌/系列不得按颜色名称自动替换。换卡及旧数据迁移使用 CIEDE2000，详细配置与审计阈值见 `docs/mard-palette-product-config.md`。
- 材料响应除逐色数量与价格外，还返回 `width`、`height`、`colorCount`、非空格的闭区间边界 `occupiedBounds`，以及毫米单位的 `physicalSize`。`physicalSize.canvas` 按完整网格宽高乘色卡 `beadSizeMm`；`physicalSize.occupied` 按非空有效边界计算，无豆图纸的边界和占用物理尺寸均为 `null`。`beadCount` 仍严格等于各材料行数量总和。
- 尚未建立项目时，`GET/PUT/DELETE /creation-draft` 保存每个用户唯一的创建流程草稿，包括模式、步骤、裁剪/生成选项、色卡、尺寸、可选私有源素材和可选网格。稳定草稿 ID 与 revision 同时参与乐观锁，防止清除后重建的另一条流程被旧请求覆盖；`POST /creation-draft/commit` 在一个事务中校验指定草稿版本、创建项目首个不可变 revision 并删除草稿，重复提交由幂等键回放同一项目。无网格草稿不可提交；素材引用受用户隔离约束，素材记录物理回收时只清空引用而保留其余设置。
- 私有 AI 素材上传：`POST /assets` 强制 8–128 字符的 `Idempotency-Key`；服务端先原子提交稳定素材行与 `asset_uploads` 预约，再写私有对象。相同用户/作用域/键和相同规范请求哈希在进程崩溃或跨 API 节点并发时重放同一素材 ID、存储键和有效租约，ready 重放返回 `Idempotency-Replayed: true`，同键异体返回 `409 IDEMPOTENCY_CONFLICT`。预约使用数据库时钟裁决的 15 分钟租约和 token fencing，过期 pending 可由新 token 接管，旧 token 无权发布；对象 `put` 另受可取消的 5 分钟超时约束，活动上传租约会阻止 purge 领取或确认。素材还会进行真实 MIME/像素校验、去 EXIF 重编码、AES-256-GCM 存储、稳定键冲突不覆盖原对象、`pending → ready` 两阶段发布和到期物理清理。统一存储工厂支持本机加密文件与 AWS S3/MinIO 兼容私有桶；S3 对象在离开进程前同样完成客户端加密，数据库存储键再经 SHA-256 派生对象路径，用户/素材身份只进入 GCM 附加认证数据，不进入桶路径。条件 `If-None-Match: *` 写入保证稳定键重试不会覆盖旧密文。未 ready 素材不可见、不可读且不能用于生成；发布与清理竞态只能有一方成功。删除或清理到期源素材时，会原子取消关联的可取消生成任务，并通过唯一账本事件至多返还一次预留次数。批量清理按已删除、发布超时、已过期三个索引分支及固定优先级选择候选，领取 5 分钟清理租约；失败从 30 秒起指数退避至最多 1 小时，让其他可用候选继续推进。物理数量与字节配额只在写入 `purged_at` 后释放；每用户素材元数据最多 5000 条，已清理超过 90 天且没有生成任务引用的记录在下一次素材写入时机会式删除。
- 异步 AI 生成任务：次数预留/结算/释放、租约 heartbeat、崩溃恢复、状态筛选恢复、退避重试、取消、AI“换一批”固定扣 1 次和方案采用；Provider 接收 `AbortSignal`。任务会持久化并校验裁剪、抠图、人物风格、情侣布局、限色、透明背景、仅库存配色，以及亮度/对比度/饱和度/抖动选项。后三个调色值都是 `-100..100` 的整数，抖动是布尔值；公共 API 可省略并补为 `0/0/0/false`，新持久化数据始终写入完整规范值。Worker 还会复核候选的色数、库存约束、1–100 字符 ID、全局连续的 1–4 `ordinal`、连续 `variantOrdinal`、方案所需 `outputSlot` 的完整性/唯一性、合法创建时间和单次最多 4 个候选；每用户保留候选累计最多 200 万格。开发/测试缺省使用确定性 Provider，也可用完整远程配置联调真实网关；生产 API 与 Worker 强制使用供应商中立的 HTTPS Generation Provider。Bearer API key 仅放在请求头中，并对超时、取消、非 2xx、响应体大小和候选结构 fail-closed。终态历史保留 90 天且每用户最多 5000 条。
- 普通/像素模式已改为真实本地 Raster Provider：解码 JPEG/PNG/WebP，应用 ratio/rotation/flip/scale/offset，`normal` 用 Lanczos、`pixel` 用 nearest-neighbor，透明像素输出 `null`。几何处理、缩放和可选背景移除完成后，先在独立 raw-to-raw 阶段应用亮度与饱和度，再应用以中灰为中心的对比度；中性 `0/0/0/false` 路径保持原输出。颜色使用全候选 Lab/CIEDE2000 色差映射，按图像内容选择 `maxColors` 子集并先施加可用色号/库存约束，不截取色卡前 N 项；启用抖动时只在该受限子集中按确定性从左到右逐行执行 Floyd–Steinberg，透明格既不接收也不传播误差，并逐行响应取消。真人/情侣才路由到 HTTPS AI Provider；生产缺原图明确失败，开发/测试仅对无原图旧 fixture 保留确定性兼容回退，一旦有源图必须真实转换。迁移 `0025_generation_preprocessing_options.sql` 会回填任务、创建草稿与生成幂等响应中的四个字段；滚动升级期间仍允许旧 JSON 缺失字段，但存在且类型/范围非法的字段会被稳定拒绝。
- 生成结果继续以扁平 `candidates` 兼容旧读取方，同时 `GET`/列表额外返回按 `variantOrdinal` 分组的 `variants`。普通/像素只有方案 1 的 `combined`；真人和情侣 `together` 至少两个 `combined` 方案；情侣 `split` 每个方案都有 `left`+`right`，`solo` 每个方案都有 `subject-1`+`subject-2`（同时保留 `subject: 1|2` 兼容投影）。`POST /generation-jobs/:jobId/variants/:variantOrdinal/accept` 在同一事务创建方案的一个或两个项目，返回逐输出材料和按色号合并的合计材料；幂等、并发、租户与项目配额失败均不会留下部分项目。旧 candidate 采用接口只接受恰好一个 `combined` 输出，多输出方案返回 `GENERATION_CANDIDATE_REQUIRES_VARIANT_ACCEPT`，防止 split/solo 被部分采用。候选用 `acceptedAt` 永久记录采用事实，`acceptedProjectId` 只是仍存续项目的可选链接，因此项目物理回收后也不能重复采用。
- 异步 PNG/PDF 导出：固定作品 revision、5/10 格分区线、PDF 拼接定位与套准标记、材料图例分页、租约 heartbeat、渲染/存储协作取消、重试、取消、私有下载、SHA-256 校验和到期物理清理。下载端以单进程全局 4、单用户 2 的默认并发门限制内存占用，对对象读取设 60 秒、响应发送设 120 秒绝对超时，并以 64 KiB 分块遵循网络背压；超限返回 429，读取超时/存储依赖异常返回带 `Retry-After` 的 503，断连或慢读会中止并释放许可。制品先登记 pending 元数据，再写入私有对象，最后原子发布；每用户未清理制品最多 100 个/512 MiB。素材和导出清理的领取、发布超时、失败退避全部使用数据库时钟。
- 服务端定价的次数商品、开发/测试 Fake Provider、生产微信支付 API v3 Provider 与 exactly-once 入账。微信 Provider 已实现 JSAPI 创建订单、按商户单号查单、请求签名、微信应答验签以及小程序 `requestPayment` 参数签名；`POST /wechat-pay/notifications` 在 JSON 解析前保留原始正文，完成通知验签、AES-256-GCM 解密、AppID/商户号/订单号/金额/币种校验，并通过唯一事件与账本约束幂等入账。支付创建和刷新会先检查幂等回放，再用带 token、续租、数据库时钟仲裁和过期接管的数据库短租约保护 Provider 调用；有效租约内同键单飞，但过期接管时旧外部调用仍可能重叠，因此由用户和幂等键稳定派生服务商侧订单 ID/商户单号，防止产生第二份业务效果。心跳丢失时不会提交 Provider 结果，而是返回可重试的 `PAYMENT_EFFECT_LEASE_LOST`。外部 `create/query` 调用不占用数据库事务，生产环境拒绝 Fake Provider。
- 支付创建在调用 Provider 前原子预占 `payment_order_slots`；未过期 slot 与 pending 订单合计每用户最多 5 个，同键重试始终复用同一本地订单身份。每次 Provider 身份写入不可变的 `payment_order_attempts` 审计链；保留的 attempt 最多 10000 条。slot 或恢复密文过期不再导致同 key 永久 409：尚未调用 Provider 的过期预约可直接轮换新 attempt；已调用或身份歧义的 attempt 必须先按原商户单号查单，`SUCCESS` 收敛入账，`NOTPAY` 只在关单并二次查单确认 `CLOSED` 后轮换，未收敛或 `NOT_FOUND` 返回可重试错误且不会盲目重下。订单成功持久化后删除对应 slot；`payment-orders:create` 的幂等锚点作为财务记录与订单同寿命，不受 90 天操作历史清理影响。
- 豆仓支持单色校准与带 revision 锁的原子批量 `calibrate`/`delta` 导入；批量最多 100 行，重复色号、停用色号、负库存或任一陈旧 revision 会让整批回滚。每次校准、手工增减和项目消耗都会逐色写入前后数量、delta、位置、幂等引用与可选项目 revision 的不可变流水，`GET /inventory/transactions` 提供租户隔离的 `limit/offset` 分页。作品缺货清单和替代色建议仍是只读操作，不会因打开或预览自动扣减；只有制作进度已完成且请求的是当前 revision 时，客户端才能显式调用 `POST /projects/:projectId/inventory-consumption` 原子扣减实际材料。同一项目 revision 至多消费一次，任一色号不足返回 409 且不部分扣减。
- 私有素材、生成任务和导出任务列表均支持 `limit/offset` 分页；素材还可按用途和是否包含清理历史筛选，响应永不暴露存储键。
- 用户级硬配额：最多 20 个、合计 100 MiB 的未物理清理 AI 素材；完工照片独立限制为每个 project revision 10 张、每用户 200 张/512 MiB；最多 4 个活动生成任务和 3 个活动导出任务。任务结束会释放任务槽位，但对象只有物理清理成功并写入 `purged_at` 后才释放对应数量与字节配额。
- 非财务操作历史采用 90 天保留期：生成最多 5000 条、导出最多 2000 条、非财务 API 幂等最多 10000 条；payment effect claim 每用户最多 10000 条，成功完成后删除，失败释放为过期记录并在超过 90 天后回收。`/me` 的导出总数反映这一运维保留窗口内当前实际存在的任务行，不是永久导出账本。软删除项目和已清理素材元数据也只在该用户后续写入时机会式回收。这些 90 天规则是活跃用户写触发的运维保留策略，不是全局后台扫描或合规删除期限。支付订单、attempt 审计链、到账事件、账本和 `payment-orders:create` 幂等锚点不按该策略删除；支付事件来源区分 `fake`、`wechat-query` 和已实现通知入口写入的 `wechat-notify`。
- PostgreSQL 持久化的固定窗口限流：AI 素材在 multipart/Sharp 前先执行 80 次/10 分钟的尝试限流，新建持久预约再在同一事务中执行 20 次/10 分钟的产品限流（同键回放与冲突不重复计入产品窗口）；完工照对应窗口为 120 次/10 分钟和 30 次/小时。生成或换一批 60 次/小时，导出 30 次/小时，支付创建 10 次/小时、刷新 60 次/小时，Web 登录确认每用户 20 次/10 分钟，结构性作品写操作（含自定义色卡导入）120 次/小时，创建流程草稿、作品工作草稿和制作进度保存各 1800 次/小时，库存写操作 240 次/小时。匿名 Web 登录限流也持久化在 `auth_rate_limits`，超限响应均给出可用于 `Retry-After` 的剩余等待时间；超过 24 小时的匿名行由后续消费按数据库时钟机会式清理，并由专用索引支持回收。
- 请求体实行分层硬边界：普通 JSON 为 2 MiB；只有 `POST /projects`、`PUT /projects/:projectId/grid`、`PUT /projects/:projectId/draft`、`PUT /creation-draft` 四个 GridSchema 接口在 preParsing 完成 Bearer 认证后才允许 16 MiB，以覆盖最坏紧凑网格约 15.48 MB。通用素材 multipart 严格流式限制为一个文件、两个字段、三个 part，文件上限取 `ASSET_MAX_BYTES`，字段上限 256 字节；完工照只允许一个文件、零字段、一个 part，采用相同文件与字段上限。两路上传都在读取 part 前完成认证及尝试/幂等限流，文件、字段、part 数量或字段截断超限统一返回 `413 ASSET_TOO_LARGE`；全局 2 MiB JSON 上限不用于阻断这两路流式 multipart。
- 所有会同时触碰用户、作品、素材或生成任务的 PostgreSQL 事务统一采用 user → project → asset 与 generation accept 的 user → job 锁序。真实 PostgreSQL 强制交错回归已 1/1 通过且没有 `40P01`；这仍不替代更高并发和长时间锁等待压测。

## 存储与下载故障语义

本机加密存储以同目录硬链接完成“仅创建、不覆盖”的原子发布；写入中的临时文件按一分钟刷新 mtime，超过 30 分钟才可由跨进程 rename claim 的清理器回收。清理器只识别两级哈希分片中的 `.pdae-<32hex>.tmp`/`.pdae-gc-<32hex>.tmp` 私有命名空间，每五分钟运行一次；Provider `close()` 会停止定时器并等待在途清理，因此应用重启必须为同一持久目录创建新的 Provider 实例。

私有对象读取会同时核对认证密文、数据库记录的明文长度与 SHA-256：普通素材永久损坏返回 `410 ASSET_CONTENT_CORRUPTED`，完工照返回 `410 COMPLETION_PHOTO_CONTENT_CORRUPTED`，导出制品返回 `410 EXPORT_ARTIFACT_CORRUPTED`；生成源素材损坏则以不可重试的 `GENERATION_SOURCE_ASSET_CORRUPTED` 终止任务。若对象引用的历史 key ID 暂未配置，则视为可恢复的依赖配置问题并返回带重试语义的 503，生成任务也保留重试，避免把补回 keyring 即可恢复的对象误判为永久损坏。生成 Worker 会把租约 heartbeat 的 `AbortSignal` 传入源素材读取，失去租约时中止读取且不调用生成 Provider。导出文件名会先修复异常 Unicode 代理项、按 Unicode code point 截断，再以 RFC 5987 编码写入 `Content-Disposition`。

常驻 Generation、Export 和 Payment Reconciliation Worker 会把 SIGTERM/SIGINT 转换为进程级 `AbortSignal`，停止领取新任务并协作取消在途源素材读取、渲染/对象写入、AI 或微信调用，然后再关闭存储与数据库连接。生产编排仍必须为 API 排空和资源关闭预留足够的 termination grace，具体计算与命令示例见生产运行手册。

## 本地启动

```powershell
pnpm install
Copy-Item backend/.env.example backend/.env
pnpm infra:up
pnpm backend:migrate
pnpm backend:seed
pnpm backend:dev
```

默认地址为 `http://127.0.0.1:8787/api/v1`，OpenAPI JSON 位于 `http://127.0.0.1:8787/openapi.json`。生成文档由契约层补齐，并在测试中通过标准 OpenAPI 3.0.3 schema 与 `$ref` 校验：每个操作都显式标注 Bearer、`X-Web-Login-Token`、内部 Worker 或公开安全边界；所有持久幂等写入都声明 `Idempotency-Key`、全部 2xx 的 `Idempotency-Replayed` 及 409 冲突；multipart 上传、私有二进制下载、微信回调头和运行时实际状态码也进入契约。

Docker 暂不可用时，可运行 `pnpm backend:dev-memory` 启动同进程 API + 确定性或 Ark 生成/导出 Worker。该模式使用进程内易失对象存储，确保元数据与素材字节在重启时一起消失，不会遗留无法追踪的本地文件；它仅供本地联调，且 production 会拒绝启动。

生产 `DATABASE_URL` 必须显式包含 host、user、1–65535 的 port 和唯一数据库 path，password 可省略；缺少这些字段时即使存在 `PGPORT`/`PGUSER`/`PGDATABASE` 也会 fail closed。query 与 fragment 同样被拒绝，TLS 只由 `DATABASE_SSL` 控制。

`NODE_ENV` 必须显式设为 `development`、`test` 或 `production`。生产环境的所有数据库角色必须显式配置非空 `DATABASE_URL`，缺失时拒绝启动而不会回退本地开发 DSN；生产 `DATABASE_URL` 禁止携带 query 或 fragment，防止 `host`/`database` 等覆盖 authority/path 绕过连接边界，TLS 只能通过独立的 `DATABASE_SSL` 启用，远程数据库必须开启。pool max、连接/空闲、statement、lock 与 idle-in-transaction 超时均可按角色配置。开发登录默认关闭；只有同时设置 `DEV_AUTH_ENABLED=true` 且绑定 loopback 地址，才可调用 `POST /api/v1/auth/dev-session`。同一 gate 还会在非 production 且缺少完整微信登录凭据时，为原有 `POST /api/v1/auth/wechat-session` 注入固定本地账号 Provider；该 Provider 只校验 code 非空且不超过 128 字符，openid 不由 code 派生。开发身份只在首次创建时按 `DEV_STARTING_CREDITS` 写入一笔 `dev_welcome_credit`，既有用户重新登录不重复赠送，真实 Provider 也不会传入开发初始余额。若 `WECHAT_APP_ID` 和 `WECHAT_APP_SECRET` 同时存在，则始终优先使用真实 `code2session`。生产环境禁止开发 Provider，配置或注入该 Provider 都会 fail closed。开发/测试环境未配置远程网关时使用确定性 Generation Provider，完整配置三项后可直接联调 HTTP Provider。生产 API 必须关闭开发登录、用 `TRUSTED_PROXIES` 明确列出实际可信代理 IP/CIDR，并完整配置 `WECHAT_APP_ID`/`WECHAT_APP_SECRET`、微信支付商户号与签名/验签/API v3 密钥/通知地址；生产 Generation Worker 必须完整配置 `GENERATION_PROVIDER_URL`、`GENERATION_PROVIDER_API_KEY`、`GENERATION_PROVIDER_TIMEOUT_MS`，或使用内置火山方舟 Provider 配置 `ARK_API_KEY`（可选 `ARK_IMAGE_MODEL`，默认 `doubao-seedream-5-0-pro-260628`；可选 `ARK_VISION_MODEL` 用于先做图片理解）。两种 Provider 只能配置一种。生成 URL 在生产环境必须使用 HTTPS，超时有效范围为 1000–600000 毫秒；对应进程所需配置缺失时会拒绝启动，API 不需要获取 AI Provider 密钥。Ark API Key 只由 Generation Worker 读取，Web 和微信小程序继续共用 `/api/v1/generation-jobs`，不需要重复实现模型调用。生产 `CUSTOM_PALETTES_ENABLED` 默认 `false`。从无私有色卡状态上线时，必须先迁移 `0031`/`0032`，以关闭 gate 的方式部署 owner-aware 新节点，等待全部 ready，排空全部旧节点并确认 0 副本，最后才开启；库内若已有任何私有色卡，严禁与旧应用混跑，必须先排空旧节点。首张私有色卡产生后，回滚下限是具备 owner-scoped 查询、feature gate 和 `0031`/`0032` 兼容性的安全镜像；关闭 gate 不会让 pre-owner-filter 旧镜像变安全，schema 无需回滚。

生产环境中，API、Generation/Export Worker 和两个 Purge 角色必须显式设置非空 `ASSET_STORAGE_PROVIDER`，不再从缺失值静默回退到本机目录。多副本生产部署应使用 `s3`，并让这些角色共享完全相同的 bucket、region、endpoint、prefix 与完整素材加密 keyring。`local` 只保留给受控单实例：必须显式配置绝对且非文件系统根目录的 `ASSET_STORAGE_ROOT`、将该目录挂载到可备份/恢复的持久卷，并严格设置 `ASSET_LOCAL_STORAGE_PRODUCTION_ACKNOWLEDGED=true`；缺少任一项都会拒绝启动。S3 模式至少配置 `ASSET_S3_BUCKET`、`ASSET_S3_REGION`，AWS S3 可省略 endpoint，MinIO 通常需配置 `ASSET_S3_ENDPOINT` 和 `ASSET_S3_FORCE_PATH_STYLE=true`。非 loopback endpoint 必须使用 HTTPS；显式 access/secret 必须成对出现，也可完全省略以使用 AWS SDK 默认凭据链（实例角色、容器角色等）。服务不会把 access key、secret、原始存储键、用户 ID 或素材 ID 写入对象路径或接口响应。桶必须关闭公开访问，并授予运行身份桶级 `s3:ListBucket` 以及限定 prefix 的 `s3:GetObject`、`s3:PutObject`、`s3:DeleteObject` 权限。Migration、Seed 和 Payment Reconciliation Worker 不使用对象存储，不需要这些变量。

生产环境变量总目录见 [`.env.production.example`](.env.production.example)；完整的分角色密钥、备份、迁移/Seed/启动顺序、对象桶权限、清理调度、健康检查与回滚流程见 [`../docs/backend-production-runbook.md`](../docs/backend-production-runbook.md)。

Generation Provider 接口为 `POST` JSON。请求使用 `Authorization: Bearer <API key>` 和 `Idempotency-Key: <job id>`；请求与响应的 `schemaVersion` 均为严格的 `pindou-generation-v3`。v3 请求中的生成 options 必须包含规范化后的 `brightness`、`contrast`、`saturation` 和 `dither`；旧 v1/v2 响应都会被拒绝，避免网关静默忽略调色/抖动或误读方案/槽位语义。请求只包含任务 ID/kind/seed、生成 options、目标宽高、色卡、可用库存色号，以及存在时经 Base64 编码的源图，不发送用户 ID、素材 ID、次数余额或内部租约。响应的扁平候选必须返回 `id`、`ordinal`、`variantOrdinal`、`outputSlot`、可选兼容人物归属和 `palette-code-v1` grid；`jobId` 与 `createdAt` 由本服务补齐。候选之外的供应商响应正文不会写入日志或错误详情，API key 与源图也不得由调用方日志记录。

AI 素材仅支持 JPG、PNG 与 WebP。客户端可在登录或上传前调用公开的 `GET /api/v1/privacy/ai-processing-consent`，读取当前同意版本、上传字节上限、默认留存小时数以及服务端支持的 MIME/purpose；该响应不包含存储路径、密钥或供应商凭据，并使用 `Cache-Control: no-store` 防止复用过期同意版本。上传必须声明当前 `ASSET_CONSENT_VERSION` 并携带每个逻辑上传唯一且可重试复用的 `Idempotency-Key`；服务端解码、移除元数据并重新编码后才预约稳定素材身份并加密落盘，对象写入成功后才将元数据标为 ready。客户端超时后必须用原键和原文件重试，不能为同一次业务动作换键。素材默认 23 小时过期，为“24 小时内删除”保留调度窗口。素材被显式删除、发布超时或被清理任务判定到期时，数据库会先原子标记删除、取消关联的仍可取消生成任务并幂等退款，再清理密文；对象删除失败会写入下次可用时间并指数退避，避免同一失败项持续占据批次。删除或过期本身不会释放物理配额，只有成功删除对象并写入 `purged_at` 后才释放。生产环境必须配置独立的 `ASSET_ENCRYPTION_KEY_BASE64` 与 `INTERNAL_WORKER_KEY`。新写对象使用带 `ASSET_ENCRYPTION_ACTIVE_KEY_ID` 的 PDAE2 信封；`ASSET_ENCRYPTION_READ_KEYS_JSON` 保留历史/预置只读密钥，`ASSET_ENCRYPTION_LEGACY_KEY_ID` 明确指定无 key ID 的 PDAE1 应使用哪把密钥。只配置原 `ASSET_ENCRYPTION_KEY_BASE64` 的环境仍以 `default` ID 写入并兼容历史 PDAE1。key ID 一经使用不得绑定另一把密钥；完整两阶段轮换和退役条件见生产运行手册。

## Worker 与清理任务

开发环境分别运行：

```powershell
pnpm backend:generation-worker
pnpm backend:exports-worker
pnpm backend:payments-reconcile
pnpm --dir backend assets:purge:dev
pnpm backend:exports-purge
```

生产构建后对应命令为 `generation:worker`、`exports:worker`、`payments:reconcile`、`assets:purge` 和 `exports:purge`；前三者均应作为独立常驻进程运行。Generation Worker 只从自身进程环境读取生产 HTTP Provider 配置，不再回退到确定性实现，API 进程无需持有该凭据。支付对账 Worker 直接访问 PostgreSQL，不需要素材存储或 `INTERNAL_WORKER_KEY`；当前它复用 API 的 payment Provider factory，因此即使查单/关单本身不需要全部字段，也必须注入完整的 AppSecret、API v3 key、通知 URL、商户私钥和验签材料，否则会 fail closed。素材与导出文件清理任务建议至少每 30 分钟调度一次；候选必须先条件领取，5 分钟清理租约内其他清理进程会跳过，候选、超时和失败退避均由数据库时钟裁决，失败记录按 30 秒、60 秒逐步退避并封顶 1 小时。导出清理除到期 ready 制品外，也只接管 15 分钟仍未发布且没有活动 job lease 的 pending 制品。失败或达到批次上限时以非零状态退出，调度器应重试并告警。内部 HTTP 入口也受 `X-Internal-Worker-Key` 保护：

支付发布必须先排空旧 API 写入者，再迁移并部署新 API；在启动对账 Worker 和恢复支付创建前，查询 `pending` 支付订单中没有 `payment_reconciliation_jobs` 的数量必须为 0。0038/0039 的每批有界自愈与终态收敛是运行期安全网，不能替代 drain 与 orphan=0 门禁。队列积压、最近错误和已过期的 `running` 租约需要持续监控；暂停、补建孤儿任务、恢复与回滚顺序见生产运行手册。

首次应用 `0040`/`0041` 必须按生产运行手册进入完整写维护窗口：普通事务内 `CREATE INDEX` 期间需排空 API 并暂停全部 Worker/Purge，迁移后确认两个 lease 复合索引有效再恢复。不得在仍有 generation/export writer 的普通滚动发布中直接执行。

- `POST /api/v1/privacy/delete-expired`
- `POST /api/v1/internal/generation-jobs/process-next`
- `POST /api/v1/internal/export-jobs/process-next`
- `POST /api/v1/internal/export-artifacts/purge-expired`

## 验证

```powershell
pnpm backend:type-check
pnpm backend:test
pnpm backend:build
# 真实 PostgreSQL 发布门禁；目标必须是可被测试独占、允许写入和清理数据的专用库。
$env:PINDOU_TEST_POSTGRES_URL="postgresql://test_user@127.0.0.1:5432/pindou_test_regression_20261005"
$env:PINDOU_TEST_POSTGRES_CONFIRM_DATABASE="pindou_test_regression_20261005"
$env:PINDOU_TEST_POSTGRES_ALLOW_MUTATION="true"
pnpm backend:release:postgres

# 当前 schema 的 HTTP + 独立 Worker E2E；目标必须是已存在的全空专用库。
$env:PINDOU_E2E_DATABASE_URL="postgresql://test_user@127.0.0.1:5432/pindou_e2e_release_20261005"
$env:PINDOU_E2E_CONFIRM_DATABASE="pindou_e2e_release_20261005"
$env:PINDOU_E2E_ALLOW_EMPTY_DATABASE_MIGRATION="true"
pnpm backend:release:current-schema-e2e
```

正式候选验收不能使用默认源码模式：构建镜像时以 `PINDOU_BUILD_REVISION` 和
`PINDOU_SOURCE_DIGEST` build args 写入完整提交 ID 与
`node backend/scripts/compute-release-source-digest.mjs` 计算的构建输入摘要，然后为
`release:current-schema-e2e` 或 `release:postgres:full` 同时设置
`PINDOU_RELEASE_IMAGE=<tag-or-digest>`、`PINDOU_RELEASE_REQUIRE_IMAGE=true`、
`PINDOU_RELEASE_EXPECTED_REVISION=<exact-value>` 与
`PINDOU_RELEASE_EXPECTED_SOURCE_DIGEST=<exact-value>`。门禁先要求两项期望与当前 checkout 的
Git HEAD/确定性 source digest 完全一致，再把 tag 解析为不可变 `sha256` image ID，精确核对
label/镜像环境与两项期望，并让 migration、seed、API、Generation Worker、Export Worker 和
Payment Reconciliation Worker 全部以 `NODE_ENV=production` 从该 image ID 启动；镜像模式
还会在摘要计算前后拒绝 staged、unstaged 或未跟踪文件，并在 standalone/full 门禁成功前
再次终检 provenance 与 clean 状态；镜像模式不会重新编译宿主 `dist`。本地 Windows Docker Desktop 的 loopback 数据库会仅在按角色最小化的临时容器 env-file 中改写为
`host.docker.internal`，凭据不进入 argv/日志；容器、随机端口和共享临时 volume 在成功、
失败或中断时都会清理。不得在发布作业省略 `PINDOU_RELEASE_REQUIRE_IMAGE=true`。

Docker context 使用 allowlist，只发送根 `.dockerignore`/三个包管理文件与 `backend/` tree，
并从中排除 backend 根目录全部 `.env*`、`private.*.key` 与任意层级 PEM；build stage 在完整
COPY 后还会重算同一 source digest，并拒绝与非 `unknown` build arg 不一致的输入，避免镜像
只携带一份与实际构建内容无关的 provenance 声明。

两类门禁 URL 都必须显式包含 host、user、1–65535 的 port 和唯一数据库 path（password 可省略），并拒绝 query/fragment。passwordless URL 可通过 `PGPASSWORD` 提供认证；current-schema wrapper 只把这一项认证值传给子进程并纳入日志脱敏，不传递 `PGHOST`、`PGPORT`、`PGUSER`、`PGDATABASE`、`PGSERVICE` 等目标选择变量。这样父进程预检与测试、migration、seed、API、Worker 子进程不会因 ambient PostgreSQL 目标配置指向不同实例。

`release:postgres` 只读取专用的 `PINDOU_TEST_POSTGRES_URL`，不会回退使用普通 `DATABASE_URL`。URL 库名必须带独立的 `e2e`/`test` 标记、不得带可能改变连接目标的 query 参数，`PINDOU_TEST_POSTGRES_CONFIRM_DATABASE` 必须与 URL 解码后的库名逐字一致，并且 `PINDOU_TEST_POSTGRES_ALLOW_MUTATION` 必须严格为 `true`。非 loopback host 必须显式设置 `PINDOU_TEST_POSTGRES_DATABASE_SSL=true`；ambient `PGSSLMODE` 不能替代该确认。在创建测试数据、临时 trigger/function 或执行清理前，wrapper 会连接并复核服务端 `current_database()`，同时拒绝存在其他活动连接的共享库；随后每个专项测试进程还会在创建自己的业务连接池前重新执行相同的实际库身份与零其他连接预检，避免把父 wrapper 较早的检查当作持续保证。仅当服务端报告“存在其他活动连接”时，子进程才以 50 ms 间隔在 2 秒有界窗口内短暂重试，以容纳刚退出的上一子进程完成 PostgreSQL 会话回收；库身份不匹配、连接/配置错误不重试，持续共享连接会在窗口耗尽后 fail closed。wrapper 的首次预检仍是单次快速失败。连接或最终预检失败不会进入业务 SQL，错误日志会脱敏连接 URL 与密码。五个专项子进程及单独支付锁序门禁各有 10 分钟硬截止，超时在 POSIX 上先向私有进程组发送 `SIGTERM`，2 秒宽限后再以 `SIGKILL` 强制清理；Windows 上立即调用受 1 秒截止保护的 `taskkill /T /F` 并保留直接终止 fallback，均安全返回非零。POSIX 嵌套 wrapper 继承外层私有进程组，外层 leader 提前退出也会清理残留后代。单独运行 `backend:release:payment-lock-order` 时复用完全相同的安全参数和双层预检，不存在弱化的旁路入口。


`release:current-schema-e2e` 不读取普通 `DATABASE_URL`，也不继承 `backend/.env`；连接 URL、库名确认、TLS、空库预检、临时凭据与进程清理均采用 fail-closed 规则。组合门禁为四项真实 PostgreSQL 回归设置统一截止，再运行 current-schema HTTP 与独立 Worker E2E。

历史 `0050` 候选曾用两个隔离的 PostgreSQL 17.11 库实跑完整六项 wrapper：五项专项门禁各 1/1，current-schema E2E 校验 50 个 checksum，得到 99 字节完工照、3 行库存流水、材料总数 38、34,250 字节 PNG 与最终余额 19；退出后两个库相关会话为 0，两个库已删除。该结果以及 0047/0048 的 PNG 数字都只属于历史证据，不能证明当前工作树的 `0058` 候选。冻结提交 `a7d0949be403e85427750ea677b0bf7eb28e674a` 已在两个全新隔离库完成四项真实 PostgreSQL 回归与 current-schema E2E，精确校验 55 个 checksum、当时最新的 `0055_remove_community_feature.sql`，并通过 production API、Generation/Export/Payment Worker 启动与外部进程 E2E；两库随后会话归零并删除。这些结果仅证明该冻结提交及其候选；复用已填充的同类 E2E 库仍会 fail closed。

API 和本地 PostgreSQL 启动后，仍可运行 `pnpm backend:e2e-smoke` 回归已有环境的 HTTP/数据库链路。当前工作树源码要求完整保留 `0001`–`0058`，发布前必须确认最新记录为 `0058_credit_product_pricing.sql`、共 58 条且全部 checksum 与源码 manifest 一致；runner 还会在任何业务迁移或旧 checksum 回填前拒绝未知版本、checksum 漂移和非连续前缀。0050 与冻结提交 `a7d0949...` 的本地迁移/seed 及门禁结果仅为历史基线，不能替代当前 0058 候选的重新验证。

双 API + 双 Generation Worker 的真实 PostgreSQL 并发冒烟使用 `pnpm backend:concurrency-smoke`。此前较早 schema 的历史样本中，12 个逻辑生成请求全部唯一完成，同一素材幂等上传在两个 API 节点得到相同素材 ID，并观察到 `Idempotency-Replayed: true`，余额由 20 精确降至 8，总耗时约 1,205 ms，且两个 Worker 都实际领取并完成任务。运行 `pnpm backend:performance-smoke` 可在当前环境重新回归 200×200 项目创建、PNG/PDF 导出与鉴权下载；这些较早 schema 的样本不代表当前 0058 候选的性能结果。并发与性能实测环境、阈值和尚未覆盖项见 [`../docs/backend-performance-baseline.md`](../docs/backend-performance-baseline.md)。


冻结提交 `a7d0949be403e85427750ea677b0bf7eb28e674a` 已从确定性源码摘要 `sha256:e1a1501be4c4b8c41ca6702ef6f9865474332727d4d010cb05e40eb837b9ae2e` 构建本地候选 `pindou-release:a7d0949-e1a1501b-20261005t105106-r2`，immutable image ID 为 `sha256:46de38bf9942deba9f0329aa66338b136eb6a95083eab7b6fa03d6973fe7d111`，并已完成 `migration_count=55`、最新迁移 0055、生产角色启动、health/readiness、OpenAPI 和完整真实 PostgreSQL 门禁。旧 image ID `sha256:a92606c3dad1fa5676a19fab766ca078e128e49f99083f945446a892b181033a` 及此前任何只含 0050 或更早 manifest 的镜像都属于历史制品，不可回连 0055 数据库。正式发布须在 CI 中对确切提交重新执行门禁并锁定 registry digest，同时把 expected revision/source digest 与当前 `HEAD`/本地构建输入摘要进行精确比对。
## 当前外部边界

### CloudBase PostgreSQL 迁移镜像（离线）

运行 `node backend/scripts/cloudbase-pg-smoke.mjs` 可从 `backend/migrations/` 生成独立的 CloudBase CLI 文件名镜像，并逐字节校验每个 SQL 文件与来源一致；默认输出到系统临时目录，也可通过 `--output-dir <新目录>` 指定一个尚不存在的目录。`--epoch-utc YYYYMMDDHHmmss` 可显式指定确定性映射起点。脚本只读迁移源码，不读取环境变量、不连接数据库，也不调用 CloudBase。它不会执行迁移或修改 `public.schema_migrations`。

`backend/scripts/cloudbase-pg-migration-adapter.js` 的账本规划器只接受显式标记为已验证的 CloudBase 历史表、版本/校验和语义、单文件事务、失败记录时序、锁行为及应用账本修复事务契约；任一项未验证时立即拒绝生成修复计划。即使契约全部传入，它也只返回待审查的 JSON 操作，不执行写入。CloudBase 历史表名称与内容、CLI 对单文件事务/失败重试的实际行为、锁与权限等仍须在目标环境外部核实，不能将离线镜像或模拟测试当作 CloudBase 验收。
