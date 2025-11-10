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
    const region = env.B2_S3_ENDPOINT.split('.')[1];

    s3 = new S3Client({
      endpoint: `https://${env.B2_S3_ENDPOINT}`,
      region: region,
      credentials: {
        accessKeyId: env.B2_ACCESS_KEY_ID,
        secretAccessKey: env.B2_SECRET_APPLICATION_KEY,
      },
    });
  }
  return s3;
}

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

    const proxyS3GetResponse = async (s3Response: any): Promise<Response> => {
      const headers = new Headers();
      if (s3Response.ContentType) headers.set('Content-Type', s3Response.ContentType);
      if (s3Response.ContentLength) headers.set('Content-Length', s3Response.ContentLength.toString());
      if (s3Response.ETag) headers.set('Etag', s3Response.ETag);
      return new Response(s3Response.Body as ReadableStream | null, {
        status: s3Response.$metadata?.httpStatusCode ?? 200,
        headers: headers,
      });
    };


    try {
      switch (request.method) {
        case 'PUT':
          if (url.searchParams.has('partNumber') && url.searchParams.has('uploadId')) {
            const uploadPartCommand = new UploadPartCommand({
              Bucket: env.B2_BUCKET_NAME, Key: key,
              UploadId: url.searchParams.get('uploadId')!,
              PartNumber: parseInt(url.searchParams.get('partNumber')!, 10),
              Body: request.body,
            });
            const result = await s3Client.send(uploadPartCommand);
            const headers = new Headers();
            if (result.ETag) headers.set('Etag', result.ETag);
            return new Response(null, { status: 200, headers: headers });
          } else {
            const putCommand = new PutObjectCommand({
              Bucket: env.B2_BUCKET_NAME, Key: key,
              Body: request.body ?? undefined,
              ContentType: request.headers.get('content-type') ?? undefined,
            });
            await s3Client.send(putCommand);
            return new Response(`File ${key} uploaded successfully.`, { status: 200 });
          }

        case 'POST':
          if (url.searchParams.has('uploads')) {
            const createUploadCommand = new CreateMultipartUploadCommand({
              Bucket: env.B2_BUCKET_NAME, Key: key,
              ContentType: request.headers.get('content-type') ?? undefined,
            });
            const s3Response = await s3Client.send(createUploadCommand);
            const jsonResponse = {
              UploadId: s3Response.UploadId, Key: s3Response.Key, Bucket: s3Response.Bucket,
            };
            return new Response(JSON.stringify(jsonResponse), {
              status: 200, headers: { 'Content-Type': 'application/json' },
            });

          } else if (url.searchParams.has('uploadId')) {
            const xmlBody = await request.text();
            const parsedXml = xmlParser.parse(xmlBody);
            let partsArray = parsedXml.CompleteMultipartUpload?.Part;
            if (partsArray && !Array.isArray(partsArray)) partsArray = [partsArray];
            const partsForSdk = partsArray.map((part: any) => ({
              ETag: part.ETag, PartNumber: part.PartNumber,
            }));

            const completeUploadCommand = new CompleteMultipartUploadCommand({
              Bucket: env.B2_BUCKET_NAME, Key: key,
              UploadId: url.searchParams.get('uploadId')!,
              MultipartUpload: { Parts: partsForSdk, },
            });
            const s3Response = await s3Client.send(completeUploadCommand);
            const jsonResponse = {
              Location: s3Response.Location, Bucket: s3Response.Bucket,
              Key: s3Response.Key, ETag: s3Response.ETag,
            };
            return new Response(JSON.stringify(jsonResponse), {
              status: 200, headers: { 'Content-Type': 'application/json' },
            });
          }
          return new Response('Invalid POST request', { status: 400 });

        case 'GET':
          const getCommand = new GetObjectCommand({ Bucket: env.B2_BUCKET_NAME, Key: key });
          const s3Object = await s3Client.send(getCommand);
          return proxyS3GetResponse(s3Object);

        case 'DELETE':
          if (url.searchParams.has('uploadId')) {
            const abortCommand = new AbortMultipartUploadCommand({
              Bucket: env.B2_BUCKET_NAME, Key: key,
              UploadId: url.searchParams.get('uploadId')!,
            });
            await s3Client.send(abortCommand);
            return new Response('Multipart upload aborted.', { status: 204 });
          } else {
            const deleteCommand = new DeleteObjectCommand({ Bucket: env.B2_BUCKET_NAME, Key: key });
            await s3Client.send(deleteCommand);
            return new Response(`File ${key} deleted successfully.`, { status: 200 });
          }

        default:
          return new Response('Method Not Allowed', { status: 405 });
      }
    } catch (error: any) {
      console.error('S3 Proxy Error:', error);

      const errorMessage = `S3 Error: ${error.name || 'UnknownError'} - ${error.message || 'No details'}`;

      return new Response(JSON.stringify({
        message: errorMessage,
        code: error.name || "UnknownError",
      }), {
        status: error.$metadata?.httpStatusCode ?? 500, // 尝试获取 S3 状态码
        headers: {'Content-Type': 'application/json'}
      });
    }
  },
};
