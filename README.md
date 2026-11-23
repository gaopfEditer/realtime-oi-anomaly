# 本地行情监控脚手架
 
这是一个**本地学习用**的加密行情监控最小实现：Express API + Next.js 前端 + 内存假数据。它只借鉴「公开列表 + VIP 榜单」这个产品形状，**不会抓取、镜像或对接任何第三方线上站点**。

Postgres / Redis / Docker 都是可选的。默认路径只用 npm。

## 本地运行（推荐）

需要 Node.js 18+。

```bash
cp .env.example .env   # 可选；不复制时 API 使用内置开发密钥
npm run setup
npm run dev:api
```

另开一个终端：

```bash
npm run dev:frontend
```

- API：http://localhost:3001
- 前端：http://localhost:3000

前端通过 Next.js rewrite 把浏览器里的 `/api/*` 转到 `NEXT_PUBLIC_API_URL`（默认 `http://localhost:3001`）。一般不用改。若 API 不在 3001：

```bash
NEXT_PUBLIC_API_URL=http://localhost:3001 npm run dev:frontend
```

## 演示账号

| 字段 | 值 |
|------|----|
| 邮箱 | `demo@local.dev` |
| 密码 | `demo123` |
| 权限 | 登录后签发 VIP JWT |

## 验证

API 起来之后：

```bash
curl -s http://localhost:3001/
curl -s http://localhost:3001/api/v1/coins
curl -s -o /tmp/rankings.json -w "%{http_code}\n" http://localhost:3001/api/v1/rankings
curl -s -X POST http://localhost:3001/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"demo@local.dev","password":"demo123"}'
```

带 token 看榜单（把 `TOKEN` 换成登录返回值）：

```bash
curl -s http://localhost:3001/api/v1/rankings -H "Authorization: Bearer TOKEN"
```

或一次跑完：

```bash
npm run verify
```

期望：

- `GET /` → `{ "message": "Mercu Clone API", "status": "online" }`
- `GET /api/v1/coins` → `{ "coins": [ ... ] }`
- `GET /api/v1/rankings` 无 token → `403 { "error": "VIP required" }`
- `POST /api/auth/login` 演示账号 → `{ "token", "vip": true, "email" }`
- 同上，带 `Authorization: Bearer <token>` → `{ "rankings": [ ... ] }`

## API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/` | 健康检查 |
| GET | `/api/v1/coins` | 公开假币种列表 |
| POST | `/api/auth/login` | 演示登录，返回 VIP JWT |
| GET | `/api/v1/rankings` | VIP 假榜单；否则 403 |

JWT 密钥只读 `JWT_SECRET`，见 `.env.example`。未设置时使用 `dev-secret-change-me`。中间件解析 `Authorization: Bearer`，并把 `req.vip` 设成 token 里的 `vip` 声明。

## 可选 Postgres

API **不会**在 Phase 1 连库。`database/init.sql` 只是合法 schema + 种子，给你以后接库用：

```bash
createdb mercu_clone
psql -d mercu_clone -f database/init.sql
```

## 可选 Docker

`docker-compose.yml` 已补上 Redis，并为 `api` / `frontend` 加了 Dockerfile。本地开发请优先用上面的 npm 命令。Compose 仅在你明确要容器时使用：

```bash
docker compose up --build
```

## 目录

```
api/src/index.js      Express + JWT + 内存数据
frontend/app/         Next.js App Router 页面
database/init.sql     可选 Postgres
scripts/verify.js     接口自检
MVP_GAP.md            需求草图 vs 本仓库实现
```

## 修复归档

干净副本：`artifacts/mercu-clone-full-fixed.tar.gz`。
