// src/index.ts

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';

import { XMLParser } from 'fast-xml-parser';

import { DOMParser } from '@xmldom/xmldom';
// @ts-ignore
globalThis.Node = {
  ELEMENT_NODE: 1,
  ATTRIBUTE_NODE: 2,
  TEXT_NODE: 3,
  CDATA_SECTION_NODE: 4,
  PROCESSING_INSTRUCTION_NODE: 7,
  COMMENT_NODE: 8,
  DOCUMENT_NODE: 9,
  DOCUMENT_TYPE_NODE: 10,
  DOCUMENT_FRAGMENT_NODE: 11,
};
// @ts-ignore
globalThis.DOMParser = DOMParser;


const globalXmlParser = new XMLParser();

export interface Env {
  B2_BUCKET_NAME: string;
  B2_S3_ENDPOINT: string;
  B2_ACCESS_KEY_ID: string;
  B2_SECRET_APPLICATION_KEY: string;
}

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

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {

    try {
      const s3Client = getS3Client(env);
      const url = new URL(request.url);

      let path = url.pathname;
      const bucketPathPrefix = '/' + env.B2_BUCKET_NAME;
      let key: string;

      if (path.startsWith(bucketPathPrefix + '/')) {
        key = path.substring(bucketPathPrefix.length + 1);

      } else if (path === bucketPathPrefix || path === bucketPathPrefix + '/') {
        key = '';

        if (request.method === 'HEAD' || request.method === 'GET') {
          return new Response('Bucket exists (Proxy Validation)', { status: 200 });
        }

        if (request.method === 'POST' && url.searchParams.has('delete')) {
          const xmlBody = await request.text();
          const parsedXml = globalXmlParser.parse(xmlBody);

          let objectsArray = parsedXml.Delete?.Object;
          if (objectsArray && !Array.isArray(objectsArray)) {
            objectsArray = [objectsArray];
          }

          const objectsForSdk = objectsArray.map((obj: any) => ({
            Key: obj.Key,
          }));

          const deleteCommand = new DeleteObjectsCommand({
            Bucket: env.B2_BUCKET_NAME,
            Delete: {
              Objects: objectsForSdk,
              Quiet: parsedXml.Delete?.Quiet || false,
            },
          });

          const s3Response = await s3Client.send(deleteCommand);

          const deletedXml = s3Response.Deleted?.map((d: any) => `<Deleted><Key>${d.Key}</Key></Deleted>`).join('') || '';
          const errorsXml = s3Response.Errors?.map((e: any) => `<Error><Key>${e.Key}</Key><Code>${e.Code}</Code><Message>${e.Message}</Message></Error>`).join('') || '';

          const xmlResponse = `<?xml version="1.0" encoding="UTF-8"?>
<DeleteResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  ${deletedXml}
  ${errorsXml}
</DeleteResult>`;

          return new Response(xmlResponse, {
            status: 200,
            headers: { 'Content-Type': 'application/xml' },
          });
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


      switch (request.method) {

        case 'HEAD':
            const headCommand = new HeadObjectCommand({ Bucket: env.B2_BUCKET_NAME, Key: key });
            const s3Head = await s3Client.send(headCommand);
            const headers = new Headers();
            if (s3Head.ContentType) headers.set('Content-Type', s3Head.ContentType);
            if (s3Head.ContentLength) headers.set('Content-Length', s3Head.ContentLength.toString());
            if (s3Head.ETag) headers.set('Etag', s3Head.ETag);
            return new Response(null, { status: 200, headers: headers });

        case 'PUT':
          if (url.searchParams.has('partNumber') && url.searchParams.has('uploadId')) {
            const uploadPartCommand = new UploadPartCommand({
              Bucket: env.B2_BUCKET_NAME, Key: key,
              UploadId: url.searchParams.get('uploadId')!,
              PartNumber: parseInt(url.searchParams.get('partNumber')!, 10),
              Body: request.body,
            });
            const result = await s3Client.send(uploadPartCommand);
            const headers_put = new Headers();
            if (result.ETag) headers_put.set('Etag', result.ETag);
            return new Response(null, { status: 200, headers: headers_put });
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

            const xmlResponse = `<?xml version="1.0" encoding="UTF-8"?>
<InitiateMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Bucket>${s3Response.Bucket}</Bucket>
  <Key>${s3Response.Key}</Key>
  <UploadId>${s3Response.UploadId}</UploadId>
</InitiateMultipartUploadResult>`;

            return new Response(xmlResponse, {
              status: 200,
              headers: { 'Content-Type': 'application/xml' },
            });

          } else if (url.searchParams.has('uploadId')) {

            const xmlBody = await request.text();
            const parsedXml = globalXmlParser.parse(xmlBody);
            let partsArray = parsedXml.CompleteMultipartUpload?.Part;
            if (partsArray && !Array.isArray(partsArray)) {
              partsArray = [partsArray];
            }

            const partsForSdk = partsArray.map((part: any) => ({
              ETag: part.ETag,
              PartNumber: part.PartNumber,
            }));

            const completeUploadCommand = new CompleteMultipartUploadCommand({
              Bucket: env.B2_BUCKET_NAME, Key: key,
              UploadId: url.searchParams.get('uploadId')!,
              MultipartUpload: { Parts: partsForSdk, },
            });

            const s3Response = await s3Client.send(completeUploadCommand);

            const xmlResponse = `<?xml version="1.0" encoding="UTF-8"?>
<CompleteMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Location>${s3Response.Location}</Location>
  <Bucket>${s3Response.Bucket}</Bucket>
  <Key>${s3Response.Key}</Key>
  <ETag>${s3Response.ETag}</ETag>
</CompleteMultipartUploadResult>`;

            return new Response(xmlResponse, {
              status: 200,
              headers: { 'Content-Type': 'application/xml' },
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
      console.error('S3 Proxy Error Caught:', error);

      const errorMessage = `S3 Error: ${error.name || 'UnknownError'} - ${error.message || 'No details'}`;

      const errorXml = `<?xml version="1.0" encoding="UTF-8"?>
<Error>
  <Code>${error.name || "UnknownError"}</Code>
  <Message>${errorMessage}</Message>
  <RequestId>WORKER_PROXY_ERROR</RequestId>
</Error>`;

      return new Response(errorXml, {
        status: error.$metadata?.httpStatusCode ?? 500,
        headers: {'Content-Type': 'application/xml'}
      });
    }
  },
};
