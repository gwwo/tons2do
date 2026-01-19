A self-hosted productivity web app inspired by Things for macOS, with an emphasis on smooth motion and a clean interface.

Built from scratch as a personal project to learn modern full-stack development and **not affiliated with anyone.**

I am currently wrapping up the frontend. Next steps include developing a backend for authentication, data syncing, and possibly encryption.

Ultimately, the goal is a minimal, offline-friendly, functional, self-hosted web app for personal daily use.

for dev

1. vscode to open a devcontainer
2. run `bun run dev --host`
3. visit `http://localhost:5173`

for production

1. run `docker compose -f docker-compose.prod.yml up -d` to start services
2. visit your server/domain name
3. run `docker compose -f docker-compose.prod.yml down --remove-orphans` to take down
