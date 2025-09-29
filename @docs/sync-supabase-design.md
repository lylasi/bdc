# 方案 C（Supabase）最小後端設計

最後更新：2025-09-29

目標
- 以最少雲端工作量實現「賬號制多端同步」。
- 後端只存/取快照；前端做 LWW（Last‑Write‑Wins）合併。
- 先用單表 jsonb；後續可升級為實體級同步。

資料模型（快照式，最小可行）
- 表：public.snapshots（每位使用者 1 行）
- 欄位：
  - user_id uuid PK → 參考 auth.users(id)
  - version integer not null default 0（樂觀鎖）
  - payload jsonb not null default '{}'::jsonb（核心資產快照）
  - updated_at timestamptz not null default now()
- 索引：`create index if not exists idx_snapshots_updated_at on public.snapshots(updated_at desc);`

建表與 RLS（SQL）
```sql
create table if not exists public.snapshots (
  user_id uuid primary key references auth.users(id) on delete cascade,
  version integer not null default 0,
  payload jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.snapshots enable row level security;

create policy "snapshots_select_own"
  on public.snapshots for select
  using (auth.uid() = user_id);

create policy "snapshots_insert_own"
  on public.snapshots for insert
  with check (auth.uid() = user_id);

create policy "snapshots_update_own"
  on public.snapshots for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create index if not exists idx_snapshots_updated_at on public.snapshots(updated_at desc);
```

條件更新 RPC（If‑Match 語義）
```sql
create or replace function public.save_snapshot(expected_version int, p_payload jsonb)
returns table(version int, updated_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  curr int;
begin
  if uid is null then
    raise exception 'unauthorized' using errcode = '28P01';
  end if;

  insert into public.snapshots as s (user_id, version, payload)
  values (uid, 0, coalesce(p_payload, '{}'::jsonb))
  on conflict (user_id) do nothing;

  select s.version into curr
  from public.snapshots s
  where s.user_id = uid
  for update;

  if expected_version is distinct from curr then
    raise exception 'version_conflict' using errcode = '40001';
  end if;

  update public.snapshots
     set version = curr + 1,
         payload = coalesce(p_payload, '{}'::jsonb),
         updated_at = now()
   where user_id = uid;

  return query select curr + 1, now();
end $$;

revoke all on function public.save_snapshot(int, jsonb) from public;
grant execute on function public.save_snapshot(int, jsonb) to authenticated;

create or replace function public.get_snapshot()
returns table(version int, updated_at timestamptz, payload jsonb)
language sql
security definer
set search_path = public
as $$
  select s.version, s.updated_at, s.payload
  from public.snapshots s
  where s.user_id = auth.uid();
$$;

revoke all on function public.get_snapshot() from public;
grant execute on function public.get_snapshot() to authenticated;
```

前端整合（supabase-js，骨架）
```js
// modules/sync-supabase.js
import { createClient } from '@supabase/supabase-js';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true }
});

export async function pullSnapshot() {
  const { data, error } = await supabase.rpc('get_snapshot');
  if (error && error.message?.includes('null value')) return null; // 尚未建立
  if (error) throw error;
  return data; // { version, updated_at, payload }
}

export async function pushSnapshot(expectedVersion, payload) {
  const { data, error } = await supabase.rpc('save_snapshot', {
    expected_version: expectedVersion ?? 0,
    p_payload: payload
  });
  if (error) {
    if (error.code === '40001') return { conflict: true };
    throw error;
  }
  return { conflict: false, version: data?.[0]?.version, updatedAt: data?.[0]?.updated_at };
}

export async function syncNow(buildLocalSnapshot, applyMergedSnapshot) {
  const remote = await pullSnapshot();
  const local = await buildLocalSnapshot(); // { payload }
  const baseVersion = remote?.version ?? 0;
  const merged = lwwMerge(local.payload, remote?.payload);

  const needPush = JSON.stringify(merged) !== JSON.stringify(remote?.payload);
  if (needPush) {
    const res = await pushSnapshot(baseVersion, merged);
    if (res.conflict) {
      const latest = await pullSnapshot();
      const merged2 = lwwMerge(local.payload, latest?.payload);
      const res2 = await pushSnapshot(latest?.version ?? 0, merged2);
      if (res2.conflict) throw new Error('同步衝突重試仍失敗');
      await applyMergedSnapshot(merged2);
      return;
    }
    await applyMergedSnapshot(merged);
  } else if (JSON.stringify(local.payload) !== JSON.stringify(merged)) {
    await applyMergedSnapshot(merged);
  }
}

// LWW（簡版）：id 對齊後比 updatedAt；刪除優先
export function lwwMerge(local, remote) {
  if (!remote) return local;
  const out = { ...remote };
  // 按你的核心集合逐一合併，例如 books / qaSets / analyzedArticles ...
  return out;
}
```

快照 payload（示例）
```json
{
  "schemaVersion": 1,
  "updatedAt": "2025-09-29T12:34:56Z",
  "vocabularyBooks": [ { "id": "book-1", "name": "...", "words": [ ... ], "updatedAt": "...", "deleted": false } ],
  "activeBookId": "book-1",
  "qaManifest": [ { "id": "qa-1", "name": "...", "questionCount": 10, "updatedAt": "...", "deleted": false } ],
  "qaSets": { "qa-1": { "id": "qa-1", "questions": [ ... ], "updatedAt": "...", "deleted": false } },
  "analyzedArticles": [ { "id": "art-1", "article": "...", "result": { }, "updatedAt": "...", "deleted": false } ]
}
```

同步流程（建議）
- 觸發：使用者主動點「立即同步」，或在保存核心資料後 debounce 3–10 秒觸發。
- 步驟：pull → LWW 合併 → 若有差異則 push（帶 expected_version）。
- 失敗重試：遇 40001 衝突 → 重新 pull 再合併一次 → 再 push；仍衝突則提示重試。
- 節流：最小間隔（例如 15–30 秒）、大小上限（payload 幾 MB 以內）。

安全與隱私
- RLS：只允許 `auth.uid() = user_id` 的行存取。
- 備援：Supabase 預設備份可用；必要時再導出。
- 如需端到端加密：前端用 passphrase→PBKDF2/Scrypt→AES‑GCM 加密 payload；RPC 改存 `payload_enc bytea`＋`enc_meta jsonb`。

測試清單
- 單端：修改詞本→push→刷新→pull 應還原。
- 雙端：A 改書名、B 改單詞→sync 應按 updatedAt 合併且無覆蓋丟失。
- 權限：未登入或不同帳號無法取到他人資料。
- 衝突：If‑Match 不符時返回衝突並能自動重試成功。

後續演進
- 實體級表：將 books / qa_sets / articles 拆至獨立表，保留 `updatedAt/deleted`，前端改增量 upsert。
- Realtime：對重要集合開啟變更通知，另一端即時更新 UI。
- 成本：監控流量與行數；payload 超大時改 bytea（壓縮）或拆表。

