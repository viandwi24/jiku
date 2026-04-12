import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3'

export interface FilesystemAdapterConfig {
  endpoint: string
  accessKeyId: string
  secretAccessKey: string
  bucket: string
  region?: string
}

export class S3FilesystemAdapter {
  readonly id = 's3'
  readonly displayName = 'S3 / RustFS / MinIO'

  private config: FilesystemAdapterConfig

  constructor(config: FilesystemAdapterConfig) {
    this.config = config
  }

  /**
   * Legacy key format — encodes the virtual path into the S3 key.
   * Still needed by `persistContentToAttachment()` (Plan 33) which stores
   * attachments under a different prefix (`jiku/attachments/...`).
   *
   * @deprecated For filesystem files, use `buildKeyFromId()` instead.
   */
  buildKey(projectId: string, virtualPath: string): string {
    return `projects/${projectId}${virtualPath}`
  }

  /**
   * Plan 16 — UUID-based key with entropy prefix for S3 partition spread.
   *
   * Format: `objects/{2-char-prefix}/{fileId}`
   * The 2-char prefix is derived from the first 2 hex chars of the UUID
   * (which is already random), producing 256 prefixes for even S3 partition
   * distribution. The key NEVER changes after creation — move/rename only
   * touches DB metadata, not S3.
   */
  buildKeyFromId(fileId: string): string {
    const prefix = fileId.replace(/-/g, '').substring(0, 2)
    return `objects/${prefix}/${fileId}`
  }

  /** Returns true if the storage key uses the old path-encoded format. */
  static isLegacyKey(storageKey: string): boolean {
    return storageKey.startsWith('projects/')
  }

  async upload(key: string, content: string | Buffer, mimeType: string): Promise<void> {
    const client = this.getClient()
    await client.send(new PutObjectCommand({
      Bucket: this.config.bucket,
      Key: key,
      Body: content,
      ContentType: mimeType,
    }))
  }

  async download(key: string): Promise<Buffer> {
    const client = this.getClient()
    const result = await client.send(new GetObjectCommand({
      Bucket: this.config.bucket,
      Key: key,
    }))
    if (!result.Body) throw new Error(`Empty body for key: ${key}`)
    const bytes = await result.Body.transformToByteArray()
    return Buffer.from(bytes)
  }

  /** Stream the object directly — returns the raw GetObjectCommandOutput for proxy use. */
  async getStream(key: string): Promise<{ stream: NodeJS.ReadableStream; contentType: string; contentLength?: number }> {
    const client = this.getClient()
    const result = await client.send(new GetObjectCommand({
      Bucket: this.config.bucket,
      Key: key,
    }))
    if (!result.Body) throw new Error(`Empty body for key: ${key}`)
    // @aws-sdk/client-s3 returns a SdkStreamMixin that implements ReadableStream
    // In Node.js it's a Readable.
    return {
      stream: result.Body as unknown as NodeJS.ReadableStream,
      contentType: result.ContentType ?? 'application/octet-stream',
      contentLength: result.ContentLength,
    }
  }

  async delete(key: string): Promise<void> {
    const client = this.getClient()
    await client.send(new DeleteObjectCommand({
      Bucket: this.config.bucket,
      Key: key,
    }))
  }

  async exists(key: string): Promise<boolean> {
    try {
      const client = this.getClient()
      await client.send(new HeadObjectCommand({ Bucket: this.config.bucket, Key: key }))
      return true
    } catch {
      return false
    }
  }

  private getClient(): S3Client {
    return new S3Client({
      endpoint: this.config.endpoint,
      region: this.config.region ?? 'auto',
      credentials: {
        accessKeyId: this.config.accessKeyId,
        secretAccessKey: this.config.secretAccessKey,
      },
      forcePathStyle: true, // required for RustFS / MinIO
    })
  }
}

export function buildS3Adapter(fields: Record<string, string>, metadata: Record<string, string>): S3FilesystemAdapter {
  return new S3FilesystemAdapter({
    endpoint: metadata['endpoint'] ?? 'http://localhost:9000',
    accessKeyId: fields['access_key_id'] ?? '',
    secretAccessKey: fields['secret_access_key'] ?? '',
    bucket: metadata['bucket'] ?? 'jiku-local',
    region: metadata['region'] ?? 'auto',
  })
}
