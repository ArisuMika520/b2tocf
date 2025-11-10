// src/index.ts

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
} from '@aws-sdk/client-s3';
// 导入 XML 解析器
import { XMLParser } from 'fast-xml-parser';

// 1. 环境变量接口
export interface Env {
  B2_BUCKET_NAME: string;
  B2_S3_ENDPOINT: string;
  B2_ACCESS_KEY_ID: string;
  B2_SECRET_APPLICATION_KEY: string;
}

// 2. S3 客户端初始化
let s3: S3Client;
function getS3Client(env: Env): S3Client {
  if (!s3) {
    s3 = new S3Client({
      // env.B2_S3_ENDPOINT 已经包含了 "s3." (例如: s3.us-west-005.backblazeb2.com)
      endpoint: `https://{env.B2_S3_ENDPOINT}`,
      region: 'auto',
      credentials: {
        accessKeyId: env.B2_ACCESS_KEY_ID,
        secretAccessKey: env.B2_SECRET_APPLICATION_KEY,
      },
    });
  }
  return s3;
}

//创建一个 XML 解析器实例
const xmlParser = new XMLParser();

// 3. Worker 主入口
export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const s3Client = getS3Client(env);
    const url = new URL(request.url);

    let path = url.pathname;
    const bucketPathPrefix = '/' + env.B2_BUCKET_NAME;
    let key: string;

    if (path.startsWith(bucketPathPrefix + '/')) {
      key = path.substring(bucketPathPrefix.length + 1);
    } else if (path === bucketPathPrefix || path === bucketPathPrefix + '/') {
      if (request.method === 'HEAD' || request.method === 'GET') {
        return new Response('Bucket exists (Proxy Validation)', { status: 200 });
      }
      return new Response('Bucket-level operations (like List) not implemented.', { status: 405 });
    } else {
      key = path.substring(1);
    }

    if (!key && !url.searchParams.has('uploadId')) {
      return new Response('Invalid path or key.', { status: 400 });
    }

    const proxyS3Response = async (s3Response: any): Promise<Response> => {
      const headers = new Headers();
      if (s3Response.ContentType) headers.set('Content-Type', s3Response.ContentType);
      if (s3Response.ContentLength) headers.set('Content-Length', s3Response.ContentLength.toString());
      if (s3Response.ETag) headers.set('Etag', s3Response.ETag);

      if (s3Response.$metadata?.headers) {
          for (const [key, value] of Object.entries(s3Response.$metadata.headers)) {
              if (key.startsWith('x-amz-')) {
                  headers.set(key, value as string);
              }
          }
      }
      return new Response(s3Response.Body as ReadableStream | null, {
        status: s3Response.$metadata?.httpStatusCode ?? 200,
        headers: headers,
      });
    };


    try {
      switch (request.method) {
        case 'PUT':
          if (url.searchParams.has('partNumber') && url.searchParams.has('uploadId')) {
            // --- 2. 处理分块上传 (单个块) ---
            const uploadPartCommand = new UploadPartCommand({
              Bucket: env.B2_BUCKET_NAME,
              Key: key,
              UploadId: url.searchParams.get('uploadId')!,
              PartNumber: parseInt(url.searchParams.get('partNumber')!, 10),
              Body: request.body,
            });
            const result = await s3Client.send(uploadPartCommand);

            const headers = new Headers();
            if (result.ETag) headers.set('Etag', result.ETag);
            return new Response(null, { status: 200, headers: headers });

          } else {
            // --- 处理简单上传 ---
            const putCommand = new PutObjectCommand({
              Bucket: env.B2_BUCKET_NAME,
              Key: key,
              Body: request.body ?? undefined,
              ContentType: request.headers.get('content-type') ?? undefined,
            });
            await s3Client.send(putCommand);
            return new Response(`File ${key} uploaded successfully.`, { status: 200 });
          }

        case 'POST':
          if (url.searchParams.has('uploads')) {
            const createUploadCommand = new CreateMultipartUploadCommand({
              Bucket: env.B2_BUCKET_NAME,
              Key: key,
              ContentType: request.headers.get('content-type') ?? undefined,
            });
            const s3Response = await s3Client.send(createUploadCommand);
            return proxyS3Response(s3Response);

          } else if (url.searchParams.has('uploadId')) {

            // a. 读取客户端发来的 XML body
            const xmlBody = await request.text();

            // b. 解析 XML
            const parsedXml = xmlParser.parse(xmlBody);

            // c. 转换成 S3 SDK v3 需要的格式
            // S3 客户端发送的 <Part> 可能是一个对象（如果只有1块）或一个数组
            let partsArray = parsedXml.CompleteMultipartUpload?.Part;
            if (partsArray && !Array.isArray(partsArray)) {
              // 如果只有一块，强行转成数组
              partsArray = [partsArray];
            }

            const partsForSdk = partsArray.map((part: any) => ({
              ETag: part.ETag,
              PartNumber: part.PartNumber,
            }));

            // d. 创建 *正确* 的命令
            const completeUploadCommand = new CompleteMultipartUploadCommand({
              Bucket: env.B2_BUCKET_NAME,
              Key: key,
              UploadId: url.searchParams.get('uploadId')!,
              // 我们传递解析后的 JS 对象，而不是 'Body'
              MultipartUpload: {
                Parts: partsForSdk,
              },
            });

            const s3Response = await s3Client.send(completeUploadCommand);
            return proxyS3Response(s3Response);
          }
          return new Response('Invalid POST request', { status: 400 });

        case 'GET':
          const getCommand = new GetObjectCommand({
            Bucket: env.B2_BUCKET_NAME,
            Key: key,
          });
          const s3Object = await s3Client.send(getCommand);
          return proxyS3Response(s3Object);

        case 'DELETE':
          if (url.searchParams.has('uploadId')) {
            const abortCommand = new AbortMultipartUploadCommand({
              Bucket: env.B2_BUCKET_NAME,
              Key: key,
              UploadId: url.searchParams.get('uploadId')!,
            });
            await s3Client.send(abortCommand);
            return new Response('Multipart upload aborted.', { status: 204 });
          } else {
            const deleteCommand = new DeleteObjectCommand({
              Bucket: env.B2_BUCKET_NAME,
              Key: key,
            });
            await s3Client.send(deleteCommand);
            return new Response(`File ${key} deleted successfully.`, { status: 200 });
          }

        default:
          return new Response('Method Not Allowed', { status: 405 });
      }
    } catch (error: any) {
      console.error('Error proxying to S3:', error);
      if (error.$metadata) {
        return new Response(error.message, {
          status: error.$metadata.httpStatusCode ?? 500,
          headers: {'Content-Type': 'application/xml'}
        });
      }
      return new Response('Internal Server Error: ' + error.message, { status: 500 });
    }
  },
};
