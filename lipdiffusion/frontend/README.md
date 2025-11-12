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

## Deploy
Push commits to main (GitHub -> Cloudflare Pages). Build command: npm run build, output: dist.

## Notes
- Supabase Auth UI is bundled directly in `src/App.tsx`.
- The Gradio studio URL is controlled via `VITE_APP_URL`.
- Contact CTA currently points to `hello@lipdiffusion.uk` – adjust as needed.
