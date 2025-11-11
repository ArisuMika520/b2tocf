// src/index.ts

import {
  S3Client,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

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
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': '*',
    };

    try {
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: corsHeaders });
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

// 缓存代理模式
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
    const getCommand = new GetObjectCommand({
      Bucket: env.B2_BUCKET_NAME,
      Key: key,
      ResponseContentDisposition: `attachment; filename="${encodeURIComponent(filename)}"`,
    });

    const signedUrl = await getSignedUrl(s3Client, getCommand, {
      expiresIn: 3600,
    });

    const range = request.headers.get('range');
    const fetchHeaders: HeadersInit = {};
    if (range) {
      fetchHeaders['Range'] = range;
    }

    const b2Response = await fetch(signedUrl, {
      method: request.method,
      headers: fetchHeaders,
      cf: {
        cacheTtl: 86400,
        cacheEverything: true,
      },
    });

    const headers = new Headers(corsHeaders);
    headers.set('Cache-Control', 'public, max-age=86400');
    headers.set('Accept-Ranges', 'bytes');
    headers.set('Content-Disposition', `attachment; filename="${filename}"`);
    headers.set('X-Cache-Status', 'MISS');
    headers.set('X-Token', token);

    const contentType = b2Response.headers.get('content-type');
    const contentLength = b2Response.headers.get('content-length');
    const contentRange = b2Response.headers.get('content-range');
    const etag = b2Response.headers.get('etag');

    if (contentType) headers.set('Content-Type', contentType);
    if (contentLength) headers.set('Content-Length', contentLength);
    if (contentRange) headers.set('Content-Range', contentRange);
    if (etag) headers.set('Etag', etag);

    response = new Response(b2Response.body, {
      status: b2Response.status,
      headers: headers,
    });

    if (b2Response.status === 200 && !range) {
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

// 直接代理
async function handleDirectProxy(
  s3Client: S3Client,
  env: Env,
  key: string,
  filename: string,
  request: Request,
  corsHeaders: Record<string, string>,
  token: string
): Promise<Response> {
  const getCommand = new GetObjectCommand({
    Bucket: env.B2_BUCKET_NAME,
    Key: key,
    ResponseContentDisposition: `attachment; filename="${encodeURIComponent(filename)}"`,
  });

  const signedUrl = await getSignedUrl(s3Client, getCommand, {
    expiresIn: 3600,
  });

  const range = request.headers.get('range');
  const fetchHeaders: HeadersInit = {};
  if (range) {
    fetchHeaders['Range'] = range;
  }

  const b2Response = await fetch(signedUrl, {
    method: request.method,
    headers: fetchHeaders,
    cf: {
      cacheTtl: 14400,
      cacheEverything: true,
    },
  });

  const headers = new Headers(corsHeaders);
  headers.set('Cache-Control', 'public, max-age=14400');
  headers.set('Accept-Ranges', 'bytes');
  headers.set('Content-Disposition', `attachment; filename="${filename}"`);
  headers.set('X-Token', token);

  const contentType = b2Response.headers.get('content-type');
  const contentLength = b2Response.headers.get('content-length');
  const contentRange = b2Response.headers.get('content-range');
  const etag = b2Response.headers.get('etag');
  const cfCacheStatus = b2Response.headers.get('cf-cache-status');

  if (contentType) headers.set('Content-Type', contentType);
  if (contentLength) headers.set('Content-Length', contentLength);
  if (contentRange) headers.set('Content-Range', contentRange);
  if (etag) headers.set('Etag', etag);
  if (cfCacheStatus) headers.set('CF-Cache-Status', cfCacheStatus);

  return new Response(b2Response.body, {
    status: b2Response.status,
    headers: headers,
  });
}
