import { inputSanitizerService } from '#src/services/inputSanitizerService.ts';
import { closeIndexedDbConnection, deleteIndexedDbDatabase } from '#src/utils/indexedDbStorage.ts';

const IMAGE_CACHE_DB_NAME = 'nostr-chat-image-cache';
const IMAGE_CACHE_DB_VERSION = 1;
const IMAGE_CACHE_STORE_NAME = 'images';

interface CachedImageRecord {
  url: string;
  blob: Blob;
  updatedAt: number;
}

function canUseIndexedDb(): boolean {
  return typeof window !== 'undefined' && typeof window.indexedDB !== 'undefined';
}

class ImageCacheService {
  private dbPromise: Promise<IDBDatabase | null> | null = null;
  private inFlightByUrl = new Map<string, Promise<string>>();
  private objectUrlBySource = new Map<string, string>();
  private passthroughByUrl = new Set<string>();

  async clearAllData(): Promise<void> {
    for (const objectUrl of this.objectUrlBySource.values()) {
      URL.revokeObjectURL(objectUrl);
    }

    this.objectUrlBySource.clear();
    this.inFlightByUrl.clear();
    this.passthroughByUrl.clear();
    await closeIndexedDbConnection(this.dbPromise);
    this.dbPromise = null;
    await deleteIndexedDbDatabase(IMAGE_CACHE_DB_NAME);
  }

  async resolveCachedImageUrl(sourceUrl: string): Promise<string> {
    const normalizedUrl = inputSanitizerService.normalizeUrl(sourceUrl);
    if (!normalizedUrl) {
      return '';
    }

    const inMemoryObjectUrl = this.objectUrlBySource.get(normalizedUrl);
    if (inMemoryObjectUrl) {
      return inMemoryObjectUrl;
    }

    if (this.passthroughByUrl.has(normalizedUrl)) {
      return normalizedUrl;
    }

    const existingRequest = this.inFlightByUrl.get(normalizedUrl);
    if (existingRequest) {
      return existingRequest;
    }

    const request = this.resolveCachedImageUrlInternal(normalizedUrl).finally(() => {
      this.inFlightByUrl.delete(normalizedUrl);
    });

    this.inFlightByUrl.set(normalizedUrl, request);
    return request;
  }

  private async resolveCachedImageUrlInternal(sourceUrl: string): Promise<string> {
    if (typeof window === 'undefined') {
      return sourceUrl;
    }

    const cachedRecord = await this.getRecord(sourceUrl);
    if (cachedRecord?.blob instanceof Blob && cachedRecord.blob.size > 0) {
      this.passthroughByUrl.delete(sourceUrl);
      return this.getOrCreateObjectUrl(sourceUrl, cachedRecord.blob);
    }

    try {
      const response = await fetch(sourceUrl, { credentials: 'omit', referrerPolicy: 'no-referrer' });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const blob = await response.blob();
      if (blob.size === 0) {
        return sourceUrl;
      }

      await this.putRecord(sourceUrl, blob);
      this.passthroughByUrl.delete(sourceUrl);
      return this.replaceObjectUrl(sourceUrl, blob);
    } catch (error) {
      this.passthroughByUrl.add(sourceUrl);
      console.warn('Failed to cache image, using remote URL directly.');
      return sourceUrl;
    }
  }

  private async getDatabase(): Promise<IDBDatabase | null> {
    if (!this.dbPromise) {
      this.dbPromise = this.openDatabase();
    }

    return this.dbPromise;
  }

  private async openDatabase(): Promise<IDBDatabase | null> {
    if (!canUseIndexedDb()) {
      return null;
    }

    return new Promise((resolve) => {
      const request = window.indexedDB.open(IMAGE_CACHE_DB_NAME, IMAGE_CACHE_DB_VERSION);

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(IMAGE_CACHE_STORE_NAME)) {
          db.createObjectStore(IMAGE_CACHE_STORE_NAME, { keyPath: 'url' });
        }
      };

      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => {
          db.close();
        };
        resolve(db);
      };

      request.onerror = () => {
        console.error('Failed to open IndexedDB image cache.', request.error);
        resolve(null);
      };

      request.onblocked = () => {
        console.error('IndexedDB image cache open request is blocked.');
        resolve(null);
      };
    });
  }

  private async getRecord(url: string): Promise<CachedImageRecord | null> {
    const db = await this.getDatabase();
    if (!db) {
      return null;
    }

    return new Promise((resolve) => {
      const transaction = db.transaction(IMAGE_CACHE_STORE_NAME, 'readonly');
      const request = transaction.objectStore(IMAGE_CACHE_STORE_NAME).get(url);

      request.onsuccess = () => {
        const result = request.result;
        if (!result || typeof result !== 'object') {
          resolve(null);
          return;
        }

        resolve(result as CachedImageRecord);
      };

      request.onerror = () => {
        console.error('Failed to read image from IndexedDB cache.', request.error);
        resolve(null);
      };

      transaction.onabort = () => {
        console.error('IndexedDB read transaction aborted for image cache.', transaction.error);
        resolve(null);
      };
    });
  }

  private async putRecord(url: string, blob: Blob): Promise<void> {
    const db = await this.getDatabase();
    if (!db) {
      return;
    }

    await new Promise<void>((resolve) => {
      const transaction = db.transaction(IMAGE_CACHE_STORE_NAME, 'readwrite');
      const request = transaction.objectStore(IMAGE_CACHE_STORE_NAME).put({
        url,
        blob,
        updatedAt: Date.now(),
      } satisfies CachedImageRecord);

      request.onerror = () => {
        console.error('Failed to write image to IndexedDB cache.', request.error);
      };

      transaction.oncomplete = () => {
        resolve();
      };

      transaction.onerror = () => {
        console.error('IndexedDB write transaction failed for image cache.', transaction.error);
        resolve();
      };

      transaction.onabort = () => {
        console.error('IndexedDB write transaction aborted for image cache.', transaction.error);
        resolve();
      };
    });
  }

  private getOrCreateObjectUrl(sourceUrl: string, blob: Blob): string {
    const existing = this.objectUrlBySource.get(sourceUrl);
    if (existing) {
      return existing;
    }

    const objectUrl = URL.createObjectURL(blob);
    this.objectUrlBySource.set(sourceUrl, objectUrl);
    return objectUrl;
  }

  private replaceObjectUrl(sourceUrl: string, blob: Blob): string {
    const previous = this.objectUrlBySource.get(sourceUrl);
    if (previous) {
      URL.revokeObjectURL(previous);
    }

    const objectUrl = URL.createObjectURL(blob);
    this.objectUrlBySource.set(sourceUrl, objectUrl);
    return objectUrl;
  }
}

export const imageCacheService = new ImageCacheService();
