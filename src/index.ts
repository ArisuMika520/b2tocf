// src/index.ts

import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';

import { DOMParser } from '@xmldom/xmldom';
// @ts-ignore
globalThis.Node = {
  ELEMENT_NODE: 1, ATTRIBUTE_NODE: 2, TEXT_NODE: 3, CDATA_SECTION_NODE: 4,
  PROCESSING_INSTRUCTION_NODE: 7, COMMENT_NODE: 8, DOCUMENT_NODE: 9,
  DOCUMENT_TYPE_NODE: 10, DOCUMENT_FRAGMENT_NODE: 11,
};
// @ts-ignore
globalThis.DOMParser = DOMParser;


// 1. 环境变量接口
export interface Env {
  B2_BUCKET_NAME: string;
  B2_S3_ENDPOINT: string;
  B2_ACCESS_KEY_ID: string;
  B2_SECRET_APPLICATION_KEY: string;
  URL_SECRET_KEY: string;
}

// 2. S3 客户端初始化
let s3: S3Client;
function getS3Client(env: Env): S3Client {
  if (!s3) {
    if (!env.B2_S3_ENDPOINT) {
      throw new Error("B2_S3_ENDPOINT secret is not set in Cloudflare Worker!");
    }
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

// 3. 生成 1 小时有效的 token
async function generateHourlyToken(key: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  // 精确到小时，token 1 小时内有效
  const hourTimestamp = Math.floor(Date.now() / 3600000).toString();
  const data = encoder.encode(key + secret + hourTimestamp);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

function getContentDisposition(filename: string, contentType?: string): string {
  if (contentType) {
    const lower = contentType.toLowerCase();
    const inlinePrefixes = ['image/', 'text/', 'audio/', 'video/'];
    const inlineTypes = ['application/pdf', 'application/json'];

    if (inlinePrefixes.some(prefix => lower.startsWith(prefix)) || inlineTypes.includes(lower)) {
      return `inline; filename="${filename}"`;
    }
  }

  return `attachment; filename="${filename}"`;
}

// 4. 验证 token
async function verifyToken(key: string, token: string, secret: string): Promise<boolean> {
  const currentToken = await generateHourlyToken(key, secret);
  return token === currentToken;
}

// 5. Worker 主入口
export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {

    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS, POST',
      'Access-Control-Allow-Headers': '*',
    };

    try {
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: corsHeaders });
      }

      if (request.method === 'POST') {
        return await handleUpload(
          request,
          env,
          ctx,
          corsHeaders
        );
      }

      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return new Response('Method Not Allowed', {
          status: 405,
          headers: corsHeaders
        });
      }

      const s3Client = getS3Client(env);
      const url = new URL(request.url);

      let key = url.pathname.substring(1);

      if (!key) {
        return new Response('Invalid path', { status: 400, headers: corsHeaders });
      }

      try {
        key = decodeURIComponent(key);
      } catch (e) {
        console.log('Key decode failed, using original key:', key);
      }

      // 自动生成 token
      const autoToken = await generateHourlyToken(key, env.URL_SECRET_KEY);

      // 检查 URL 参数
      const mode = url.searchParams.get('mode') || 'proxy'; // proxy | cache
      const userToken = url.searchParams.get('token');
      const filename = key.split('/').pop() || 'download';

      // 验证 token
      if (userToken && userToken !== autoToken) {
        return new Response('Invalid or expired token', {
          status: 403,
          headers: corsHeaders
        });
      }

      // 缓存模式
      if (mode === 'cache') {
        return await handleCachedProxy(
          s3Client,
          env,
          key,
          filename,
          request,
          corsHeaders,
          ctx,
          autoToken
        );
      }

      // 直接代理
      return await handleDirectProxy(
        s3Client,
        env,
        key,
        filename,
        request,
        corsHeaders,
        autoToken
      );

    } catch (error: any) {
      console.error('S3 Download-Proxy Error:', error);

      if (error.name === 'NotFound' || error.name === 'NoSuchKey' || error.$metadata?.httpStatusCode === 404) {
        return new Response('Not Found', {
          status: 404,
          headers: corsHeaders,
        });
      }

      return new Response(`S3 Error: ${error.name || 'UnknownError'}`, {
        status: error.$metadata?.httpStatusCode ?? 500,
        headers: corsHeaders
      });
    }
  },
};

// 缓存代理模式 - 使用 SDK 直接流式传输
async function handleCachedProxy(
  s3Client: S3Client,
  env: Env,
  key: string,
  filename: string,
  request: Request,
  corsHeaders: Record<string, string>,
  ctx: ExecutionContext,
  token: string
): Promise<Response> {
  const cacheUrl = new URL(request.url);
  cacheUrl.searchParams.delete('token');
  const cacheKey = new Request(cacheUrl.toString(), request);
  const cache = (caches as any).default;

  let response = await cache.match(cacheKey);

  if (!response) {
    const range = request.headers.get('range');

    const getCommand = new GetObjectCommand({
      Bucket: env.B2_BUCKET_NAME,
      Key: key,
      Range: range || undefined,
    });

    const s3Response = await s3Client.send(getCommand);

    const headers = new Headers(corsHeaders);
    headers.set('Cache-Control', 'public, max-age=86400');
    headers.set('Accept-Ranges', 'bytes');
    const disposition = getContentDisposition(encodeURIComponent(filename), s3Response.ContentType || undefined);
    headers.set('Content-Disposition', disposition);
    headers.set('X-Cache-Status', 'MISS');
    headers.set('X-Token', token);

    if (s3Response.ContentType) {
      headers.set('Content-Type', s3Response.ContentType);
    }
    if (s3Response.ContentLength !== undefined) {
      headers.set('Content-Length', s3Response.ContentLength.toString());
    }
    if (s3Response.ContentRange) {
      headers.set('Content-Range', s3Response.ContentRange);
    }
    if (s3Response.ETag) {
      headers.set('ETag', s3Response.ETag);
    }
    if (s3Response.LastModified) {
      headers.set('Last-Modified', s3Response.LastModified.toUTCString());
    }

    const status = range ? 206 : 200;

    response = new Response(s3Response.Body as ReadableStream, {
      status,
      headers,
    });

    // 只缓存完整响应（非 range 请求）
    if (status === 200) {
      ctx.waitUntil(cache.put(cacheKey, response.clone()));
    }
  } else {
    const headers = new Headers(response.headers);
    headers.set('X-Cache-Status', 'HIT');
    headers.set('X-Token', token);
    response = new Response(response.body, {
      status: response.status,
      headers: headers,
    });
  }

  return response;
}

// 上传处理
async function handleUpload(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  corsHeaders: Record<string, string>,
): Promise<Response> {
  const url = new URL(request.url);
  const headers = new Headers(corsHeaders);
  headers.set('Content-Type', 'application/json');

  const authHeader = request.headers.get('Authorization');
  const expectedToken = `Bearer ${env.URL_SECRET_KEY}`;
  if (!authHeader || authHeader !== expectedToken) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers,
    });
  }

  let key = url.pathname.substring(1);
  if (!key) {
    return new Response(JSON.stringify({ error: 'Missing upload key in URL path' }), {
      status: 400,
      headers,
    });
  }

  try {
    key = decodeURIComponent(key);
  } catch (error) {
    return new Response(JSON.stringify({ error: 'Invalid key encoding' }), {
      status: 400,
      headers,
    });
  }

  const contentType = request.headers.get('content-type') || 'application/octet-stream';
  const contentLength = request.headers.get('content-length');

  const s3Client = getS3Client(env);

  const putCommand = new PutObjectCommand({
    Bucket: env.B2_BUCKET_NAME,
    Key: key,
    Body: request.body,
    ContentType: contentType,
  });

  if (contentLength) {
    // @ts-ignore - 将 ContentLength 追加到请求
    putCommand.input.ContentLength = Number(contentLength);
  }

  await s3Client.send(putCommand);

  const cache = (caches as any).default;
  const cacheRequest = new Request(`${url.origin}${url.pathname}`);
  ctx.waitUntil(cache.delete(cacheRequest));

  const token = await generateHourlyToken(key, env.URL_SECRET_KEY);

  return new Response(JSON.stringify({
    message: 'Upload successful',
    key,
    token,
    contentType,
  }), {
    status: 200,
    headers,
  });
}

// 直接代理 - 使用 SDK 直接流式传输
async function handleDirectProxy(
  s3Client: S3Client,
  env: Env,
  key: string,
  filename: string,
  request: Request,
  corsHeaders: Record<string, string>,
  token: string
): Promise<Response> {
  const range = request.headers.get('range');

  const getCommand = new GetObjectCommand({
    Bucket: env.B2_BUCKET_NAME,
    Key: key,
    Range: range || undefined,
  });

  const s3Response = await s3Client.send(getCommand);

  const headers = new Headers(corsHeaders);
  headers.set('Cache-Control', 'public, max-age=14400');
  headers.set('Accept-Ranges', 'bytes');
  const disposition = getContentDisposition(encodeURIComponent(filename), s3Response.ContentType || undefined);
  headers.set('Content-Disposition', disposition);
  headers.set('X-Token', token);

  if (s3Response.ContentType) {
    headers.set('Content-Type', s3Response.ContentType);
  }
  if (s3Response.ContentLength !== undefined) {
    headers.set('Content-Length', s3Response.ContentLength.toString());
  }
  if (s3Response.ContentRange) {
    headers.set('Content-Range', s3Response.ContentRange);
  }
  if (s3Response.ETag) {
    headers.set('ETag', s3Response.ETag);
  }
  if (s3Response.LastModified) {
    headers.set('Last-Modified', s3Response.LastModified.toUTCString());
  }

  const status = range ? 206 : 200;

  return new Response(s3Response.Body as ReadableStream, {
    status,
    headers,
  });
}
