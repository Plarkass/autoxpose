import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppDatabase } from '../src/core/database/index.js';
import * as schema from '../src/core/database/schema.js';
import { AccessListService } from '../src/features/access-lists/access-list.service.js';
import type { NpmAccessList } from '../src/features/proxy/providers/npm.js';
import type {
  ProxyHost,
  ProxyProvider,
  UpdateProxyHostInput,
} from '../src/features/proxy/proxy.types.js';
import type { SettingsService } from '../src/features/settings/settings.service.js';

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

const FAMILY: NpmAccessList = { id: 2, name: 'Family', satisfy_any: false, pass_auth: true };
const ADMINS: NpmAccessList = { id: 3, name: 'Admins', satisfy_any: false, pass_auth: true };

function createDatabase(): AppDatabase {
  const connection = new Database(':memory:');
  for (const tag of ['0000_sticky_shocker', '0001_real_zzzax', '0002_access_lists']) {
    const sql = readFileSync(join(migrationsDir, `${tag}.sql`), 'utf-8');
    for (const statement of sql.split('--> statement-breakpoint')) {
      if (statement.trim()) connection.exec(statement);
    }
  }
  return drizzle(connection, { schema });
}

function npmSettings(provider = 'npm'): SettingsService {
  return {
    getProxyConfig: async () => ({ provider, config: { url: 'http://npm.local' } }),
  } as unknown as SettingsService;
}

/** Records every write so tests can assert on what NPM was actually told. */
class FakeProxyProvider implements ProxyProvider {
  readonly name = 'npm';
  readonly updates: { hostId: string; input: UpdateProxyHostInput }[] = [];

  constructor(private host: ProxyHost) {}

  async updateHost(hostId: string, input: UpdateProxyHostInput): Promise<ProxyHost> {
    this.updates.push({ hostId, input });
    this.host = { ...this.host, accessListId: input.accessListId ?? this.host.accessListId };
    return this.host;
  }

  async createHost(): Promise<ProxyHost> {
    throw new Error('not used');
  }
  async deleteHost(): Promise<void> {
    throw new Error('not used');
  }
  async listHosts(): Promise<ProxyHost[]> {
    return [this.host];
  }
  async findByDomain(): Promise<ProxyHost | null> {
    return this.host;
  }
  async retrySsl(): Promise<{ success: boolean; error?: string }> {
    return { success: true };
  }
}

function existingHost(accessListId?: number): ProxyHost {
  return {
    id: '7',
    domain: 'grafana.example.com',
    targetHost: '10.0.0.5',
    targetPort: 3000,
    ssl: true,
    enabled: true,
    accessListId,
  };
}

function createService(lists: NpmAccessList[], provider = 'npm'): AccessListService {
  return new AccessListService(createDatabase(), npmSettings(provider), async () => ({
    listAccessLists: async () => lists,
  }));
}

describe('access list resolution', () => {
  let service: AccessListService;

  beforeEach(async () => {
    service = createService([FAMILY, ADMINS]);
    await service.syncFromProvider();
  });

  it('resolves an exact name to its NPM id', async () => {
    assert.deepEqual(await service.resolve('Family'), { kind: 'resolved', id: 2, name: 'Family' });
  });

  it('treats a missing label as "leave the protection alone"', async () => {
    assert.deepEqual(await service.resolve(null), { kind: 'unset' });
  });

  it('treats the reserved value public as an explicit removal', async () => {
    assert.deepEqual(await service.resolve('public'), { kind: 'public' });
    assert.deepEqual(await service.resolve('Public'), { kind: 'public' });
  });

  it('rejects a near miss instead of falling back to public', async () => {
    const result = await service.resolve('family');
    assert.equal(result.kind, 'error');
    assert.match(result.kind === 'error' ? result.message : '', /not found/);
  });

  it('lists the valid NPM names when validation fails', async () => {
    const result = await service.resolve('Nope');
    assert.equal(result.kind, 'error');
    assert.match(result.kind === 'error' ? result.message : '', /Admins, Family/);
  });

  it('rejects a duplicated name rather than guessing which list was meant', async () => {
    const duplicated = createService([FAMILY, { ...ADMINS, id: 9, name: 'Family' }]);
    await duplicated.syncFromProvider();

    const result = await duplicated.resolve('Family');
    assert.equal(result.kind, 'error');
    assert.match(result.kind === 'error' ? result.message : '', /ambiguous/);
  });

  it('rejects access lists when the proxy provider is not NPM', async () => {
    const caddy = createService([FAMILY], 'caddy');
    const result = await caddy.resolve('Family');
    assert.equal(result.kind, 'error');
    assert.match(result.kind === 'error' ? result.message : '', /Nginx Proxy Manager/);
  });

  it('blocks exposure by throwing when a create references an unknown list', async () => {
    await assert.rejects(
      () => service.accessListIdForCreate({ accessListName: 'Ghost' }),
      /not found/
    );
  });

  it('creates a host without an access list only when none was requested', async () => {
    assert.equal(await service.accessListIdForCreate({ accessListName: null }), undefined);
    assert.equal(await service.accessListIdForCreate({ accessListName: 'public' }), undefined);
    assert.equal(await service.accessListIdForCreate({ accessListName: 'Admins' }), 3);
  });
});

describe('access list reconciliation on an existing NPM host', () => {
  let service: AccessListService;

  beforeEach(async () => {
    service = createService([FAMILY, ADMINS]);
    await service.syncFromProvider();
  });

  it('adds an access list to a host that is currently public', async () => {
    const host = existingHost();
    const proxy = new FakeProxyProvider(host);

    const result = await service.reconcileProxyHost({ accessListName: 'Family' }, host, proxy);

    assert.deepEqual(proxy.updates, [{ hostId: '7', input: { accessListId: 2 } }]);
    assert.equal(result.accessListId, 2);
  });

  it('changes the access list when the label points somewhere else', async () => {
    const host = existingHost(2);
    const proxy = new FakeProxyProvider(host);

    const result = await service.reconcileProxyHost({ accessListName: 'Admins' }, host, proxy);

    assert.deepEqual(proxy.updates, [{ hostId: '7', input: { accessListId: 3 } }]);
    assert.equal(result.accessListId, 3);
  });

  it('removes the access list when the label is set to public', async () => {
    const host = existingHost(3);
    const proxy = new FakeProxyProvider(host);

    const result = await service.reconcileProxyHost({ accessListName: 'public' }, host, proxy);

    assert.deepEqual(proxy.updates, [{ hostId: '7', input: { accessListId: 0 } }]);
    assert.equal(result.accessListId, null);
  });

  it('preserves the current protection when the label is removed', async () => {
    const host = existingHost(3);
    const proxy = new FakeProxyProvider(host);

    const result = await service.reconcileProxyHost({ accessListName: null }, host, proxy);

    assert.deepEqual(proxy.updates, []);
    assert.equal(result.accessListId, 3);
  });

  it('does not write to NPM when the host is already correct', async () => {
    const host = existingHost(2);
    const proxy = new FakeProxyProvider(host);

    const result = await service.reconcileProxyHost({ accessListName: 'Family' }, host, proxy);

    assert.deepEqual(proxy.updates, []);
    assert.equal(result.accessListId, 2);
  });

  it('reports the real NPM state, not the label, when the name is unknown', async () => {
    const host = existingHost(3);
    const proxy = new FakeProxyProvider(host);

    const result = await service.reconcileProxyHost({ accessListName: 'Ghost' }, host, proxy);

    assert.deepEqual(proxy.updates, []);
    assert.equal(result.accessListId, 3, 'the host keeps the protection NPM actually enforces');
    assert.match(result.error ?? '', /not found/);
  });

  it('reports the real NPM state when the update call fails', async () => {
    const host = existingHost(3);
    const proxy = new FakeProxyProvider(host);
    proxy.updateHost = async () => {
      throw new Error('NPM unreachable');
    };

    const result = await service.reconcileProxyHost({ accessListName: 'Family' }, host, proxy);

    assert.equal(result.accessListId, 3);
    assert.match(result.error ?? '', /NPM unreachable/);
  });
});

describe('access list cache', () => {
  it('reports a sync failure instead of returning a successful zero', async () => {
    const failing = new AccessListService(createDatabase(), npmSettings(), async () => ({
      listAccessLists: async () => {
        throw new Error('401 Unauthorized');
      },
    }));

    assert.deepEqual(await failing.syncFromProvider(), {
      ok: false,
      synced: 0,
      error: '401 Unauthorized',
    });
  });

  it('clears services referencing a list that was deleted in NPM', async () => {
    const db = createDatabase();
    let lists = [FAMILY, ADMINS];
    const service = new AccessListService(db, npmSettings(), async () => ({
      listAccessLists: async () => lists,
    }));
    await service.syncFromProvider();

    await db.insert(schema.services).values({
      id: 'svc-1',
      name: 'grafana',
      subdomain: 'grafana',
      port: 3000,
      source: 'docker',
      accessListName: 'Admins',
      accessListId: 3,
    });

    lists = [FAMILY];
    await service.syncFromProvider();

    const rows = await db.select().from(schema.services);
    assert.equal(rows[0].accessListId, null, 'the stale reference is cleared');
    assert.equal(rows[0].accessListName, 'Admins', 'the label is still what the user asked for');
    assert.deepEqual(
      (await service.getAll()).map(l => l.id),
      [2]
    );
  });

  it('drops cached lists when the proxy configuration changes', async () => {
    const db = createDatabase();
    const service = new AccessListService(db, npmSettings('caddy'), async () => null);
    await db.insert(schema.npmAccessLists).values({ id: 2, name: 'Family' });
    await db.insert(schema.services).values({
      id: 'svc-1',
      name: 'grafana',
      subdomain: 'grafana',
      port: 3000,
      source: 'docker',
      accessListId: 2,
    });

    await service.onProxyConfigChanged();

    assert.deepEqual(await service.getAll(), []);
    const rows = await db.select().from(schema.services);
    assert.equal(rows[0].accessListId, null);
  });
});
