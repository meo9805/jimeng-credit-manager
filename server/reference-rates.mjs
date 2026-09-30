import { randomUUID } from 'node:crypto';
import { fail, shape } from './domain.mjs';
import { referenceWalletKey, estimateReferenceRate } from '../shared/reference-pricing.mjs';
import { referenceFromCatalog } from './platform-prices.mjs';

const BASELINE = '1970-01-01T00:00:00.000Z';

/** Append-only reference prices. Collector payloads cannot set or replace them. */
export function createReferenceRates(db, now) {
  db.exec(`CREATE TABLE IF NOT EXISTS reference_rates (
    id TEXT PRIMARY KEY, wallet_key TEXT NOT NULL, effective_at TEXT NOT NULL,
    created_at TEXT NOT NULL, data TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS reference_rates_wallet_time ON reference_rates(wallet_key,effective_at);`);
  const list = () => db.prepare('SELECT data FROM reference_rates ORDER BY effective_at,created_at,rowid').all().map(row => JSON.parse(row.data));
  const last = key => db.prepare('SELECT data FROM reference_rates WHERE wallet_key=? ORDER BY effective_at DESC,rowid DESC LIMIT 1').get(key);
  const insert = (walletKey, perThousand, source, details = {}) => {
    const previous = last(walletKey), at = now();
    const record = { id: randomUUID(), walletKey, perThousand, revision: previous ? (JSON.parse(previous.data).revision ?? 1) + 1 : 1,
      effectiveAt: previous ? at : BASELINE, createdAt: at, source,
      basis: previous ? 'effective' : 'initial_reference', ...details };
    db.prepare('INSERT INTO reference_rates(id,wallet_key,effective_at,created_at,data) VALUES(?,?,?,?,?)')
      .run(record.id, walletKey, record.effectiveAt, at, JSON.stringify(record));
    return record;
  };
  function seed(accounts) {
    const suggestions = new Map();
    const priority = { platform_reference: 4, plan_estimate: 3, team_estimate: 2, purchase_estimate: 1 };
    for (const account of accounts) {
      const walletKey = referenceWalletKey(account);
      if (!walletKey || last(walletKey)) continue;
      const suggestion = estimateReferenceRate(account), previous = suggestions.get(walletKey);
      if (!previous || priority[suggestion.source] > priority[previous.source]) suggestions.set(walletKey, suggestion);
    }
    for (const [walletKey, suggestion] of suggestions) {
      const { perThousand, source, explanation, priceObservedAt } = suggestion;
      insert(walletKey, perThousand, source, { explanation, priceObservedAt });
    }
  }
  function set(input, accounts) {
    shape(input, ['walletKey', 'perThousand'], '折算单价');
    const { walletKey, perThousand } = input;
    if (typeof walletKey !== 'string' || !accounts.some(account => referenceWalletKey(account) === walletKey)) fail('钱包不存在', 404);
    if (typeof perThousand !== 'number' || !Number.isFinite(perThousand) || perThousand <= 0 || perThousand > 1000000) fail('请输入大于 0 的有效单价，最高 1000000 元/千积分');
    const previous = last(walletKey);
    if (previous && JSON.parse(previous.data).perThousand === perThousand) return JSON.parse(previous.data);
    return insert(walletKey, perThousand, 'manual');
  }
  function refreshFromCatalog(catalog, accounts, factsForAccount, monthlyCreditsForAccount) {
    if (!catalog) return 0;
    // One team wallet may be represented by a pool and several members. Use
    // the newest membership observation once, preferring the pool on a tie.
    const wallets = new Map();
    for (const account of accounts) {
      const key = referenceWalletKey(account);
      if (!key) continue;
      const prior = wallets.get(key);
      const observedAt = account.subscriptionObservedAt ?? account.lastSyncedAt ?? '';
      const priorAt = prior?.subscriptionObservedAt ?? prior?.lastSyncedAt ?? '';
      if (!prior || observedAt > priorAt || (observedAt === priorAt && account.scope === 'team_total' && prior.scope !== 'team_total')) wallets.set(key, account);
    }
    let changed = 0;
    for (const [walletKey, account] of wallets) {
      const previous = last(walletKey);
      if (previous && JSON.parse(previous.data).source === 'manual') continue;
      const suggestion = referenceFromCatalog(account, factsForAccount(account), catalog, monthlyCreditsForAccount(account));
      if (!suggestion || (previous && Math.abs(JSON.parse(previous.data).perThousand - suggestion.perThousand) < 1e-8)) continue;
      const {perThousand,source,...details}=suggestion;
      insert(walletKey,perThousand,source,details);
      changed++;
    }
    return changed;
  }
  return { list, seed, set, refreshFromCatalog };
}
