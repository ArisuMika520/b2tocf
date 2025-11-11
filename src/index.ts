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

// 3. Worker 主入口
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
        return new Response('Method Not Allowed. This endpoint is for downloads only.', {
          status: 405,
          headers: corsHeaders
        });
      }

      const s3Client = getS3Client(env);
      const url = new URL(request.url);

      let key = url.pathname.substring(1);

      if (!key) {
        return new Response('Invalid path.', { status: 400, headers: corsHeaders });
      }

      try {
        key = decodeURIComponent(key);
      } catch (e) {
        console.log('Key decode failed, using original key:', key);
      }

      // 生成预签名 URL
      const filename = key.split('/').pop() || 'download';
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

      // 使用 Cloudflare 的 fetch 代理到 B2
      const b2Response = await fetch(signedUrl, {
        method: request.method,
        headers: fetchHeaders,
      });

      const headers = new Headers(corsHeaders);
      headers.set('Cache-Control', 'public, max-age=14400');
      headers.set('Accept-Ranges', 'bytes');
      headers.set('Content-Disposition', `attachment; filename="${filename}"`);

      const contentType = b2Response.headers.get('content-type');
      const contentLength = b2Response.headers.get('content-length');
      const contentRange = b2Response.headers.get('content-range');
      const etag = b2Response.headers.get('etag');

      if (contentType) headers.set('Content-Type', contentType);
      if (contentLength) headers.set('Content-Length', contentLength);
      if (contentRange) headers.set('Content-Range', contentRange);
      if (etag) headers.set('Etag', etag);

      // 返回响应，body 直接传递（Cloudflare 会优化处理）
      return new Response(b2Response.body, {
        status: b2Response.status,
        headers: headers,
      });

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
