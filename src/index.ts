// src/index.ts

import {
  S3Client,
  GetObjectCommand,
  GetObjectCommandInput, // Import GetObjectCommandInput
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

      const range = request.headers.get('range');

      const getCommandInput: GetObjectCommandInput = {
        Bucket: env.B2_BUCKET_NAME,
        Key: key,
      };

      if (range) {
        getCommandInput.Range = range;
      }

      const getCommand = new GetObjectCommand(getCommandInput);
      const s3Object = await s3Client.send(getCommand);

      const headers = new Headers(corsHeaders);
      headers.set('Cache-Control', 'public, max-age=14400');
      headers.set('Accept-Ranges', 'bytes');

      const filename = key.split('/').pop() || 'download';
      headers.set('Content-Disposition', `attachment; filename="${filename}"`);

      if (s3Object.ContentType) headers.set('Content-Type', s3Object.ContentType);
      if (s3Object.ContentLength) headers.set('Content-Length', s3Object.ContentLength.toString());
      if (s3Object.ETag) headers.set('Etag', s3Object.ETag);
      if (s3Object.ContentRange) headers.set('Content-Range', s3Object.ContentRange);

      const status = s3Object.ContentRange ? 206 : (s3Object.$metadata?.httpStatusCode ?? 200);

      return new Response(s3Object.Body as ReadableStream | null, {
        status: status,
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
