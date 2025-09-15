# CBT Exam Backend

Simple Express + TypeScript + Mongoose API.

## Quick start

- Install dependencies
- Start the server in one line (builds automatically)

```powershell
npm install
npm start
```

Dev mode with auto-reload:

```powershell
npm run dev
```

Server listens on `PORT` (default 5000). Health check:

- GET `http://localhost:5000/api/tests/health` → `{ "status": "ok" }`

## Environment variables

Create a `.env` file in the project root with:

```
PORT=5000
MONGO_URI=mongodb+srv://<user>:<pass>@<cluster>/<db>?retryWrites=true&w=majority
JWT_SECRET=your_secret_here
```

Notes:

- If using MongoDB Atlas, ensure your current IP is allowed in the Atlas Network Access (IP whitelist).
- The server starts even if MongoDB connection fails, and logs an error. API endpoints that depend on DB may not work until connection succeeds.

## Scripts

- `npm start` → Builds TypeScript and starts Node on `dist/server.js`
- `npm run dev` → Starts with ts-node-dev (watch mode)
- `npm run build` → TypeScript compile to `dist/`

## Project structure

- `src/app.ts` → Express app and routes
- `src/server.ts` → HTTP server bootstrap and DB connect
- `src/config/db.ts` → Mongoose connection
- `src/routes/api` → Route modules
- `src/models` → Mongoose models

## Roles and Admin

The app supports three roles: `admin`, `teacher`, and `student`.

- Register endpoint creates a `student` by default.
- On first DB connection, a default `admin` is seeded using env vars or defaults.

Optional env vars for admin seeding:

```
ADMIN_EMAIL=admin@cbt.local
ADMIN_PASSWORD=Admin@123
ADMIN_NAME=System Admin
```

### Admin-only endpoints

All require an Authorization header with a Bearer JWT of an admin user.

- GET `/api/users/dashboard` → summary counts
- POST `/api/users` → create teacher/student `{ name, email, password, role: 'teacher' | 'student' }`
- GET `/api/users?role=teacher|student|admin` → list users (password omitted)
- GET `/api/users/:id` → get single user
- PUT `/api/users/:id` → update name/email/role/password
- DELETE `/api/users/:id` → delete user
