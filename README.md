# EzRadar — 本地加密 OI 异动监控台

本地运行的真实数据监控台：Express API + Next.js 前端，数据来自 Binance 公开合约接口（U 本位永续）。核心链路是 **OI / 价格异动扫描 → 热榜 → 异动后观察池 → 双向入场计划**，用于复盘和研究，不构成投资建议。

## 快速启动

需要 Node.js 18+（当前验证环境 Node 22）。

```powershell
npm run setup
npm run dev:api
```

另开一个终端：

```powershell
npm run dev:frontend
```

- API（本地 dev）：`http://localhost:3101`（`npm run dev:api` 固定 `PORT=3101`，避免与常见占用 3001 的其他 dev 服务冲突）
- 前端：`http://localhost:3000`
- 若 3000 被其他项目占用：`npm run dev:frontend:alt`（**3002**），或直接 `cd frontend; npm run dev:alt`

前端通过 Next.js rewrite 把浏览器里的 `/api/*` 转到 `NEXT_PUBLIC_API_URL`（本地默认 `http://localhost:3101`）。Docker / 生产仍为容器内 `3001`。

自定义 API 端口时同步设置：

```powershell
$env:PORT='3101'; npm run dev --prefix api
$env:NEXT_PUBLIC_API_URL='http://localhost:3101'; npm run dev:frontend
```

## 功能

### 雷达（Radar）
- 实时异动流：价格急涨/急跌、OI 急增/急减，5 分钟桶去重，按幅度排序。
- 三列工作台：异动流 / 热榜（全球、宏观、资金三组榜单）/ 币种速览。
- 每个异动带时间、窗口涨跌幅、OI 变化额、估算主动买卖流、交易所分布。

### 观察池（Watchlist）
OI 异动只说明杠杆在进场/离场，**不直接说明方向**。观察池把“异动事件”变成一条可跟踪的状态机：

`刚侦测 → 确认中 → 构筑中 → 待触发 → 已触发 / 已失效 / 已过期`

每个币种给出：
- 阶段、0–100 评分与 A/B/C 分级；
- OI 结构保留比例、箱体上下沿、ATR、VWAP 偏离、资金费率、量比、24h 成交额；
- 多空两套计划：触发位、止损、T1（2R）、T2（3R）、止损距离、是否已离开触发位；
- 触发量能带：信号 bar / 前 20 根均量必须在 0.9–1.5x，过滤无量假突破和情绪高潮；
- 失效条件清单（OI 回吐、价格破坏、超时、触发后止损）；
- 阶段时间线与触发后的 MFE/MAE 跟踪；
- 一键移出观察池。

规则细节见 [WATCHLIST_STRATEGY.md](./WATCHLIST_STRATEGY.md)。

### 回测（91 天真实历史 / 51 币）

- 30 天旧结果备份：[backtest-results/30d](./backtest-results/30d)
- 91 天扩容报告：[EXPANDED_BACKTEST_91D.md](./EXPANDED_BACKTEST_91D.md)
- 基线报告：[BACKTEST_REPORT.md](./BACKTEST_REPORT.md)
- 优化报告：[OPTIMIZATION_REPORT.md](./OPTIMIZATION_REPORT.md)
- 形态/量能报告：[MORPHOLOGY_REPORT.md](./MORPHOLOGY_REPORT.md)
- 盈亏比实验：[RR_OPTIMIZATION.md](./RR_OPTIMIZATION.md)
- 数据：Binance USD-M 官方日归档，5m K 线 + 5m OI
- 区间：2026-08-24 ～ 2026-11-22 UTC，91 个完整交易日；下载从 2026-08-23 开始预热
- 币种：51 个山寨永续 + BTC 过滤；`TONUSDT` 因 OI 缺 42 天被剔除
- 基线：6150 个异动信号 → 930 笔触发；T1 42.2%，止损率 57.8%，平均 -0.142R
- 优化档：577 笔；T1 35.9%，T2 26.4%，止损率 64.1%，平均 -0.018R
- 默认量能档：286 笔；T1 37.0%，T2 25.0%，止损率 63.0%，平均 +0.018R，总 +5.03R，最大回撤 -35.55R
- `rr` 档：271 笔；T1 36.1%，平均 -0.013R，总 -3.43R；91 天里没有优于 0.45 ATR 量能档
- 分段：量能档前 60 天 -0.037R/笔，最后 31 天 +0.246R/笔；正期望集中在最后一个月

```powershell
python scripts\backtest\fetch_history.py --workers 45
npm run backtest:repair
npm run backtest:replay
npm run backtest:replay:optimized
npm run backtest:replay:volume
npm run backtest:replay:rr
npm run backtest:period
npm run backtest:optimize
npm run backtest:validate
npm run backtest:morphology
npm run backtest:morphology:validate
npm run backtest:morphology:windows
```

观察池默认继续使用 `VOLUME_STRATEGY`（0.45 ATR，0.9–1.5x 触发量能带）；如需对照：
```powershell
$env:WATCH_STRATEGY_PROFILE='optimized'   # 91 天 577 笔，负期望
$env:WATCH_STRATEGY_PROFILE='rr'          # 91 天 271 笔，未复现 30 天优势
$env:WATCH_STRATEGY_PROFILE='legacy'      # 旧规则
```

### 币种详情
`/coin/[symbol]`：OI 序列、5m K 线、VWAP、资金费率、多空比、清算分布、分交易所 OI。

## API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/` | 健康检查，含数据源、币种数、观察池活跃数 |
| GET | `/api/v1/overview` | 市场总览 |
| GET | `/api/v1/anomalies` | 异动流（支持窗口/类型/搜索） |
| GET | `/api/v1/oi-moves` | OI 异动专用流 |
| GET | `/api/v1/hot-boards` | 热榜（全球 / 宏观 / 资金） |
| GET | `/api/v1/rankings` | VIP 榜单（`VIP_REQUIRED=true` 时需 token） |
| GET | `/api/v1/coins` | 币种列表 |
| GET | `/api/v1/coins/:symbol` | 币种详情 |
| GET | `/api/v1/watchlist?stage=&q=&limit=` | 观察池列表；`stage=active/all/detected/...` |
| GET | `/api/v1/watchlist/:symbol` | 单个观察条目 |
| POST | `/api/v1/watchlist/:symbol/dismiss` | 手动移出观察池 |
| POST | `/api/auth/login` | 演示登录 |
| GET | `/api/v1/config` | 前端配置（轮询、榜单窗口、观察池阶段） |

`VIP_REQUIRED=false`（默认）时全部开放；设为 `true` 时非 VIP 的观察池只返回前 3 条。

## 数据与运行机制

- 数据源：Binance Futures 公开接口（ticker、5m/1h/4h/1d OI、5m K 线、资金费率、多空比、清算等）。网络不可用时降级到内置演示数据，前端会显示 `dataSource`。
- 轮询：ticker 8s、OI/K 线 40s、榜单与观察池 20s；前端轮询 10s。
- 观察池持久化：`api/data/watchlist.json`，每 60s 落盘，重启后恢复 6 小时内未过期条目。
- 配置：复制 `.env.example` 为 `.env` 可选；`JWT_SECRET`、`VIP_REQUIRED`、可选的 `WATCH_STORE_PATH`，以及 `WATCH_STRATEGY_PROFILE`（默认 `volume`，可设 `optimized` 或 `legacy`）。
- 若健康检查返回 `dataSource=seed`，说明本机访问 `fapi.binance.com` 失败（常见于网络限制）。启动前设置可达的镜像/代理地址：`$env:BINANCE_FAPI='https://your-mirror.example.com'`。服务会先启动、后台重试，不会因为数据源不可达而打不开。

## 验证

```powershell
# 观察池引擎单测（合成 K 线/OI，不依赖网络）
npm run test:watch

# 接口自检（API 已启动）
npm run verify

Invoke-RestMethod http://localhost:3101/ | ConvertTo-Json -Compress
Invoke-RestMethod "http://localhost:3101/api/v1/watchlist?stage=active" | ConvertTo-Json -Depth 6
```

前端构建：

```powershell
cd frontend
npm run build
```

## 目录

```
api/src/index.js          Express、数据源、异动扫描、热榜、币种详情、路由
api/src/watchlist.js      异动后观察引擎（阶段机/评分/双向计划/失效/持久化）
api/data/                 观察池落盘（运行时生成）
frontend/app/page.jsx     雷达 / 观察池 / 全球 页面
frontend/app/coin/        币种详情
frontend/app/globals.css  暗色主题与全部布局
scripts/test-watchlist.js 观察引擎单测
scripts/verify.js         接口自检
WATCHLIST_STRATEGY.md     观察与入场策略说明
```

## 已知边界

- 观察池基于 5m K 线与 40s OI 轮询，**不是逐笔/逐档数据**；小市值币种的插针、滑点和假突破无法只靠这些数据完全过滤。
- 资金费率、多空比、清算数据来自公共接口，存在延迟；极端行情下接口可能限流。
- 评分用于排序和“值不值得继续看”，不是胜率预测。
- 本项目仅用于本地研究与技术学习，不提供任何投资建议。
