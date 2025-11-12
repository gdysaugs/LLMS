# lipdiffusion frontend

Cloudflare Pages landing page for lipdiffusion.uk.  
Handles Supabase-based sign-up/sign-in and links users to the Gradio studio once authenticated.

## Quick start

1. cd lipdiffusion/frontend
2. . /home/adama/.nvm/nvm.sh  (Node 20)
3. npm install
4. npm run dev  (http://localhost:5173)

Create a .env file (already provided for prod builds) to wire up the environment:
VITE_API_BASE_URL=https://api.lipdiffusion.uk
VITE_SUPABASE_URL=https://kfciddmtrdncfkdewhno.supabase.co
VITE_SUPABASE_ANON_KEY=<supabase anon key>
VITE_APP_URL=https://app.lipdiffusion.uk

### Supabase テーブル
Gradio 側で生成履歴を記録し、LP から過去24時間の URL を取得できるようにしています。  
以下のテーブルを Supabase で作成し、RLS で `auth.email() = email` のユーザーのみ参照/追加できるようにしてください。

```sql
create table public.generation_history (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  output_url text not null,
  created_at timestamptz not null default now()
);
```

## Deploy
Push commits to main (GitHub -> Cloudflare Pages). Build command: npm run build, output: dist.

## Notes
- Supabase Auth UI is bundled directly in `src/App.tsx`.
- The Gradio studio URL is controlled via `VITE_APP_URL`.
- Contact CTA currently points to `hello@lipdiffusion.uk` – adjust as needed.
