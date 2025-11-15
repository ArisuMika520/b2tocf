# B2 to Cloudflare Worker Proxy

一个基于 Cloudflare Workers 的 Backblaze B2 存储代理服务，提供高速、安全的文件下载服务。

可以对接基于S3标准的第三方存储挂载，针对B2进行了URL请求标准转换

专门用作图床用途的话建议使用imagehost的分支branch

## 功能

- **直接流式传输** - 使用 AWS S3 SDK 直接流式传输，下载流畅无卡顿（受cpu limited影响，可能有些波动，但不影响整体速度）
- **安全访问控制** - 基于时间戳的 Token 验证机制（1小时有效期）
- **智能缓存** - 支持两种模式：直接代理和缓存代理
- **断点续传** - 完整支持 HTTP Range 请求
- **全球加速** - 利用 Cloudflare 全球 CDN 网络加速访问
- **易于部署** - 简单配置即可部署到 Cloudflare Workers

## 前置

- [Node.js](https://nodejs.org/) 18+
- [Cloudflare 账号](https://dash.cloudflare.com/sign-up)
- [Backblaze B2 账号](https://www.backblaze.com/b2/sign-up.html)

## 开始

### 1. 克隆项目

```bash
git clone <your-repo-url>
cd b2tocf
```

### 2. 安装依赖

```bash
npm install
```

### 3. 配置 Backblaze B2

1. 登录 [Backblaze B2 控制台](https://secure.backblaze.com/user_signin.htm)
2. 创建一个 Bucket（或使用现有的）
3. 创建 Application Key：
   - 进入 **App Keys** 页面
   - 点击 **Add a New Application Key**
   - 记录 `keyID` 和 `applicationKey`
4. 获取 S3 Endpoint：
   - 在 Bucket 详情页找到 **Endpoint**
   - 格式类似：`s3.us-west-004.backblazeb2.com`

### 4. 配置 Cloudflare Worker

#### 方式一：使用 wrangler.toml（推荐用于开发）

```bash
# 复制配置模板
cp wrangler.toml.example wrangler.toml

# 编辑 wrangler.toml，填入你的信息
```

#### 方式二：使用命令行设置 Secrets（推荐用于生产）

```bash
# 设置 B2 Bucket 名称
wrangler secret put B2_BUCKET_NAME
# 输入: your-bucket-name

# 设置 B2 S3 Endpoint
wrangler secret put B2_S3_ENDPOINT
# 输入: s3.us-west-004.backblazeb2.com

# 设置 B2 Access Key ID
wrangler secret put B2_ACCESS_KEY_ID
# 输入: your-key-id

# 设置 B2 Secret Application Key
wrangler secret put B2_SECRET_APPLICATION_KEY
# 输入: your-application-key

# 设置 URL 加密密钥（自定义一个随机字符串）
wrangler secret put URL_SECRET_KEY
# 输入: your-random-secret-key
```

### 5. 本地开发

```bash
npm run dev
```

访问 `http://localhost:8787/your-file-path` 测试

### 6. 部署到 Cloudflare （我推荐你使用git部署，cf会自动拉取最新版本）

```bash
npm run deploy
```

部署成功后，你会得到一个类似 `https://b2-download-worker.your-subdomain.workers.dev` 的 [object Object] 使用方法

### 基本用法

```
https://your-worker.dev/path/to/file.zip
```

### 两种代理模式

#### 1. 直接代理模式（默认）

```
https://your-worker.dev/path/to/file.zip
```

- 实时从 B2 获取文件
- 适合不常访问的大文件
- 缓存时间：4小时

#### 2. 缓存代理模式

```
https://your-worker.dev/path/to/file.zip?mode=cache
```

- 首次访问后缓存到 Cloudflare
- 适合频繁访问的文件
- 缓存时间：24小时

### Token 验证

系统会自动生成基于时间戳的 Token（1小时有效期），无需手动添加。

如果需要验证特定 Token：

```
https://your-worker.dev/path/to/file.zip?token=your-token
```

### 断点续传

支持标准的 HTTP Range 请求：

```bash
curl -H "Range: bytes=0-1023" https://your-worker.dev/path/to/file.zip
```

## API 参数

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `mode` | string | `proxy` | 代理模式：`proxy`（直接）或 `cache`（缓存） |
| `token` | string | - | 可选的验证 Token |

## 响应头说明

| 响应头 | 说明 |
|--------|------|
| `X-Token` | 当前有效的 Token |
| `X-Cache-Status` | 缓存状态：`HIT`（命中）或 `MISS`（未命中） |
| `CF-Cache-Status` | Cloudflare 缓存状态 |
| `Content-Disposition` | 文件下载名称 |
| `Accept-Ranges` | 支持断点续传 |


## 安全性

- ✅ 使用时间戳 Token 验证（1小时有效期）
- ✅ 支持 CORS 跨域访问
- ✅ 不暴露 B2 凭证
- ✅ 支持自定义 URL 加密密钥

## 使用场景

- 软件分发下载
- 视频/音频流媒体
- 文档资料共享
- 图片资源加速
- 大文件下载服务

## 技术栈

- [Cloudflare Workers](https://workers.cloudflare.com/) - 边缘计算平台
- [AWS SDK for JavaScript v3](https://github.com/aws/aws-sdk-js-v3) - S3 客户端
- [TypeScript](https://www.typescriptlang.org/) - 类型安全
- [Backblaze B2](https://www.backblaze.com/b2/) - 对象存储

## 开发命令

```bash
# 安装依赖
npm install

# 本地开发
npm run dev

# 部署到 Cloudflare
npm run deploy

# 查看部署日志
wrangler tail

# 删除 Worker
wrangler delete
```

## 高级配置

### 自定义缓存时间

编辑 `src/index.ts`：

```typescript
// 直接代理模式缓存时间（秒）
headers.set('Cache-Control', 'public, max-age=14400'); // 4小时

// 缓存代理模式缓存时间（秒）
headers.set('Cache-Control', 'public, max-age=86400'); // 24小时
```

### 自定义 Token 有效期

编辑 `src/index.ts` 中的 `generateHourlyToken` 函数：

```typescript
// 修改时间戳精度（毫秒）
const hourTimestamp = Math.floor(Date.now() / 3600000).toString(); // 1小时
// 改为 1800000 = 30分钟
// 改为 7200000 = 2小时
```

## 常见问题

### Q: 提示 "Invalid or expired token"？

A: Token 有效期为1小时，请刷新页面获取新的 URL（系统会自动生成新 Token）

### Q: 文件无法下载？

A:
1. 检查文件路径是否正确
2. 确认 B2 Bucket 权限设置
3. 查看 Worker 日志：`wrangler tail`

## 开源声明 / 开源协议

本项目遵从 `MIT` 开源协议, 玩的开心！

## 贡献

欢迎提交 Issue 和 Pull Request！

## 联系方式

如有问题或建议，请通过以下方式联系：

- 提交 [Issue](https://github.com/ArisuMika520/b2tocf/issues)

---

⭐ 如果这个项目对你有帮助，请给个 Star！

