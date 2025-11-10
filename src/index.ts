// src/index.ts

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';

export interface Env {
  B2_BUCKET_NAME: string;
  B2_S3_ENDPOINT: string;
  B2_ACCESS_KEY_ID: string;
  B2_SECRET_APPLICATION_KEY: string;
}

// 2. S3 客户端初始化函数
let s3: S3Client;

function getS3Client(env: Env): S3Client {
  if (!s3) {
    s3 = new S3Client({
      endpoint: `https://${env.B2_S3_ENDPOINT}`,
      region: 'auto', // B2 S3 API 需要一个 'region'
      credentials: {
        accessKeyId: env.B2_ACCESS_KEY_ID,
        secretAccessKey: env.B2_SECRET_APPLICATION_KEY,
      },
    });
  }
  return s3;
}

// 3. Worker 的主入口
export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const s3Client = getS3Client(env);
    const url = new URL(request.url);

    let path = url.pathname; // 示例: "/my-b2-bucket/image.png"

    // S3 客户端在 "路径格式" 下会发送 "/BUCKET_NAME/KEY"
    const bucketPathPrefix = '/' + env.B2_BUCKET_NAME; // 示例: "/my-b2-bucket"

    let key: string;

    if (path.startsWith(bucketPathPrefix + '/')) {
      // 1. 这是 S3 客户端的 "文件" 请求
      // 路径是 "/my-b2-bucket/image.png"
      key = path.substring(bucketPathPrefix.length + 1); // 提取 "image.png"
    } else if (path === bucketPathPrefix || path === bucketPathPrefix + '/') {
      // 2. 这是 S3 客户端的 "桶" 验证请求
      // 路径是 "/my-b2-bucket" 或 "/my-b2-bucket/"
      // S3 客户端会发送 HEAD 或 GET 请求来 "检查桶是否存在"
      if (request.method === 'HEAD' || request.method === 'GET') {
        return new Response('Bucket exists (Proxy Validation)', { status: 200 });
      }
      return new Response('Bucket-level ops not supported.', { status: 405 });

    } else {
      key = path.substring(1); // 提取 "image.png" (移除开头的 "/")
    }

    if (!key) {
      // 如果计算出的 key 是空的 (例如 /)
      return new Response('Invalid path or key.', { status: 400 });
    }
    // --- 路径处理逻辑结束 ---

    // 下面的 try/catch 块和 switch 语句
    // 它只使用我们上面计算出的 `key` 变量。
    try {
      switch (request.method) {
        case 'PUT': // --- 处理上传 ---
          const putCommand = new PutObjectCommand({
            Bucket: env.B2_BUCKET_NAME,
            Key: key,
            Body: request.body ?? undefined,
            ContentType: request.headers.get('content-type') ?? undefined,
          });
          await s3Client.send(putCommand);
          return new Response(`File ${key} uploaded successfully.`, {
            status: 200,
          });

        case 'GET':
          const getCommand = new GetObjectCommand({
            Bucket: env.B2_BUCKET_NAME,
            Key: key,
          });
          const s3Object = await s3Client.send(getCommand);

          return new Response(s3Object.Body as ReadableStream, {
            headers: {
              'Content-Type': s3Object.ContentType ?? 'application/octet-stream',
              'Content-Length': s3Object.ContentLength?.toString() ?? '',
              'Etag': s3Object.ETag ?? '',
            },
          });

        case 'DELETE':
          const deleteCommand = new DeleteObjectCommand({
            Bucket: env.B2_BUCKET_NAME,
            Key: key,
          });
          await s3Client.send(deleteCommand);
          return new Response(`File ${key} deleted successfully.`, {
            status: 200,
          });

        default:
          return new Response('Method Not Allowed', { status: 405 });
      }
    } catch (error: any) {
      if (error.name === 'NoSuchKey') {
        return new Response('File not found.', { status: 404 });
      }
      console.error('Error proxying to S3:', error);
      return new Response('Internal Server Error: ' + error.message, { status: 500 });
    }
  },
};
