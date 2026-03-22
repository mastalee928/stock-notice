# stock-notice

从 masta.ee（Dujiao-Next 店铺）拉取商品列表与库存，**每 5 秒检查一次**；**仅当检测到库存变化时**推送到 Telegram 频道，消息带 inline 按钮（商品名 - 价格 - 剩余库存，点击跳转商品页）。

若店铺 API 返回 `stock_status: occupied`（仅有未支付预占、可售为 0），按钮文案会显示为 **`库存:占用×n`**，而不会当成普通「剩余:0」售罄。

**仅提供 Docker 部署，在 Linux 服务器上运行。**

上游仓库：<https://github.com/mastalee928/stock-notice>

---

## 一键命令部署（推荐）

```bash
git clone https://github.com/mastalee928/stock-notice.git && cd stock-notice && cp .env.example .env
```

编辑 `.env`，填写 `SITE_URL`、`TELEGRAM_BOT_TOKEN`、`TELEGRAM_CHAT_ID`（多频道用英文逗号分隔）后，在项目根目录执行：

```bash
docker compose up -d --build
```

---

## Docker Compose 部署

**克隆项目**

```bash
git clone https://github.com/mastalee928/stock-notice.git
cd stock-notice
```

**配置环境变量**

```bash
cp .env.example .env
# 编辑 .env，填写 SITE_URL、TELEGRAM_BOT_TOKEN、TELEGRAM_CHAT_ID（必填；多频道用英文逗号分隔），INTERVAL_SECONDS 可选，默认 5 秒
```

**启动**

```bash
docker compose up -d --build
```

**查看状态 / 日志**

```bash
docker compose ps
docker compose logs -f
```

**停止**

```bash
docker compose down
```

**更新（拉取最新代码并重新构建启动）**

```bash
cd stock-notice
git pull
docker compose up -d --build
```

或一行命令：

```bash
git pull && docker compose up -d --build
```

（需在项目根目录 `stock-notice` 下执行。）

---

## 环境变量说明

`.env` 放在项目根目录。

| 变量 | 说明 |
|------|------|
| `SITE_URL` | 店铺根地址，如 `https://masta.ee`（不要以 `/` 结尾） |
| `TELEGRAM_BOT_TOKEN` | Telegram Bot Token（@BotFather 创建） |
| `TELEGRAM_CHAT_ID` | 频道/群组 ID；多个频道用英文逗号分隔，如 `-1001234567890` 或 `-100111,-100222` |
| `INTERVAL_SECONDS` | 轮询间隔（秒），默认 5；仅库存变化时发送通知 |

获取 `TELEGRAM_CHAT_ID`：将 Bot 拉入频道/群组为管理员，向频道发一条消息，访问
`https://api.telegram.org/bot<TOKEN>/getUpdates` 查看 `chat.id`。

---

## 仅发一次（不轮询）

```bash
docker compose run --rm stock-notice node index.js --once
```

或本地：`npm run run-once`。
