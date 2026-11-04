function canUseIndexedDb(): boolean {
  return typeof window !== 'undefined' && typeof window.indexedDB !== 'undefined';
}

const ACCOUNT_DATABASE_PREFIX = 'anagram-account-database:';
export function rememberAccountDatabase(name: string): void {
  if (typeof window !== 'undefined' && window.localStorage)
    window.localStorage.setItem(ACCOUNT_DATABASE_PREFIX + name, '1');
}
export function rememberedAccountDatabases(): string[] {
  if (typeof window === 'undefined' || !window.localStorage) return [];
  const storage = window.localStorage;
  const names: string[] = [];
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (key?.startsWith(ACCOUNT_DATABASE_PREFIX))
      names.push(key.slice(ACCOUNT_DATABASE_PREFIX.length));
  }
  return names;
}

interface IndexedDbDatabaseInfo {
  name?: string | null;
}

type IndexedDbFactoryWithDatabases = IDBFactory & {
  databases?: () => Promise<IndexedDbDatabaseInfo[]>;
};

export async function closeIndexedDbConnection(
  dbPromise: Promise<IDBDatabase | null> | Promise<IDBDatabase> | null,
): Promise<void> {
  if (!dbPromise) {
    return;
  }

  try {
    const db = await dbPromise;
    db?.close();
  } catch {
    // Ignore close failures while resetting storage.
  }
}

export async function deleteIndexedDbDatabase(databaseName: string): Promise<void> {
  if (!canUseIndexedDb()) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const request = window.indexedDB.deleteDatabase(databaseName);

    request.onsuccess = () => {
      resolve();
    };

    request.onerror = () => {
      reject(request.error ?? new Error(`Failed to delete IndexedDB database "${databaseName}".`));
    };

    request.onblocked = () => {
      reject(new Error(`Deleting IndexedDB database "${databaseName}" is blocked.`));
    };
  });
}

export async function listIndexedDbDatabaseNames(): Promise<string[]> {
  if (!canUseIndexedDb()) {
    return [];
  }

  const indexedDbFactory = window.indexedDB as IndexedDbFactoryWithDatabases;
  if (typeof indexedDbFactory.databases !== 'function') {
    return [];
  }

  try {
    const databases = await indexedDbFactory.databases();
    return Array.from(
      new Set(
        databases.flatMap((database) => {
          const name = typeof database?.name === 'string' ? database.name.trim() : '';
          return name ? [name] : [];
        }),
      ),
    );
  } catch (error) {
    console.warn('Failed to enumerate IndexedDB databases.', error);
    return [];
  }
}

export async function deleteAllIndexedDbDatabases(fallbackNames: string[] = []): Promise<void> {
  const databaseNames = Array.from(
    new Set(
      [...fallbackNames, ...(await listIndexedDbDatabaseNames())].flatMap((databaseName) => {
        const normalizedName = databaseName.trim();
        return normalizedName ? [normalizedName] : [];
      }),
    ),
  );

  for (const databaseName of databaseNames) {
    await deleteIndexedDbDatabase(databaseName);
  }
}
