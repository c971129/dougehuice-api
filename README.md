# dougehuice-api

豆格绘册 Fastify `/api/v1` 源码。运行时部署在腾讯云 CloudBase 云函数；本仓库只托管源码与打包配置。

## 架构

- Web：GitHub Pages（`www.dougehuice.icu` / `c971129.github.io`）
- API：CloudBase HTTP 函数（`dougehuice.icu`）
- 源码：本仓库；由 GitHub Actions 构建并部署到 CloudBase（工作流待接入）

## 目录

- `backend/` — Fastify API、migrations、CloudBase 打包脚本
- `cloudbase/` — 云函数探针 / HTTP POC / 一次性 migration 相关目录
- `cloudbaserc.json` — CloudBase CLI 清单（无密钥）

## 本地

```bash
cd backend
pnpm install
cp .env.production.example .env   # 填入本地/私有凭据，勿提交
pnpm type-check
pnpm test
```

## 安全

- 禁止提交 `.env`、私钥、数据库 URL、微信/支付/AI 密钥
- 线上密钥只放在 CloudBase 函数环境变量或 GitHub Actions secrets
