# lipdiffusion frontend

Cloudflare Pages UI that talks to the Worker gateway (https://api.lipdiffusion.uk) and lets you
fire test requests against each RunPod worker.

## Quick start

1. cd lipdiffusion/frontend
2. . /home/adama/.nvm/nvm.sh  (Node 20)
3. npm install
4. npm run dev  (http://localhost:5173)

Create a .env file (already provided for prod builds) to override the API base:
VITE_API_BASE_URL=https://api.lipdiffusion.uk

## Deploy
Push commits to main (GitHub -> Cloudflare Pages). Build command: npm run build, output: dist.

## Notes
- Update DEFAULT_PAYLOADS inside src/App.tsx whenever RunPod payload schemas change.
- Extend styling/sections as needed – this project is only a lightweight launchpad.
- CORS is handled by the Worker; localhost and app.lipdiffusion.uk are already allowed.
