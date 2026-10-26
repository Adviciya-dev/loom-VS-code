# Loom for VS Code: development notes

Developer documentation. The Marketplace description is in `README.md`.

**Milestone 1 (done):** open VS Code → click Loom → sign in → stay signed in → see your profile → see your assigned tasks.

## Develop

```bash
npm install
npm run build        # bundle to dist/ (esbuild)
npm test             # unit tests (vitest), no VS Code needed
npm run typecheck
npm run vsix         # package loom-vscode-<version>.vsix
```

Press **F5** in VS Code to launch an Extension Development Host with the extension loaded.

## Features

- **Activity Bar → Loom.** When signed out, the sidebar shows a sign-in form. When signed in, it shows **Account** and **My Tasks**.
- **My Tasks:** the tasks assigned to you (`assigneeId` = your user ID) in the workspace's Loom project, always grouped by status (Done and Live Build start collapsed), with subtasks nested under their parents.
- **Account:** your profile and a task overview for the project: a donut chart by status with percent done in the middle, a status legend (click one to show only that status in My Tasks), and Remaining / Overdue / Due ≤ 7 days / Blocked tiles. The Loom icon shows a badge with the remaining count.
- **Not a Loom project:** if the workspace has no `.loom` file, nothing is fetched. The view says so and offers **Link to Loom Project**, which writes the file for you.
- **Search and filter** (client-side), **refresh**, and a task **detail view** with a sanitized description.
- **Open in Loom**, **Copy key**, and context-menu actions.
- **Commands** (all in the Command Palette under the `Loom:` prefix): sign in/out, link workspace to a project, refresh, search, filter, open task, create/assign/change status/change priority/add comment.

## Project scope (`.loom`)

Put a `.loom` file in the root of a workspace folder to show only that project's tasks:

```
project=9cc074ac-6a05-4373-a6fc-8d2b69b77294
```

- Several projects: one `project=` line each, or comma-separated.
- All of your assigned tasks are fetched and filtered to the project client-side, since the API has no documented project filter. So there is no paging.
- The file is watched, so edits apply immediately. Without it, the workspace is treated as not a Loom project.

Subtasks are nested under their parent when the parent is also in the list; otherwise they appear at the top level. **Open in Loom** adds `taskProject=<projectId>` for subtasks.

## Settings

| Setting | Default | Notes |
|---|---|---|
| `loom.apiBaseUrl` | `https://loom.adviciya.com/api/v1` | |
| `loom.webBaseUrl` | `https://loom.adviciya.com` | |
| `loom.taskUrlTemplate` | `{webBaseUrl}/projects/{projectId}/tasks?task={taskId}` | |
| `loom.auth.refreshPath` | *(empty)* | Refresh endpoint is unconfirmed. When it is empty, the user is asked to sign in again ~60s before expiry. |
| `loom.pageSize` | `25` | |

No environment variables or `.env` files are used, so there is no `.env.example`. `.env` is still listed in `.gitignore` as a safeguard.

## Architecture

```
src/
  api/        HttpTransport (timeout, retries, envelope check), AuthApi, LoomClient (401 flow, cache), TaskWriteApi
  auth/       AuthManager (session, single-flight renewal, throttle), TokenManager (SecretStorage, JWT exp)
  models/     Task, User (+ Zod schemas)
  services/   TaskService (state), taskQueries (filter/group)
  views/      LoginView (webview), LoomTreeProvider, AccountView (webview), TaskDetailView (webview)
  commands/   one module per command group
  utils/      logger (redaction), sanitizer, formatters
```

Everything under `api/`, `auth/`, `models/`, `services/` and `utils/` is free of `vscode` imports, so it is unit-tested in plain Node.

## API assumptions to confirm

1. **`/general-tasks/page` response shape.** The parser accepts `data` as either an array or an object.
   - Items are read from `items`, `tasks`, `data`, `rows` or `results`.
   - Paging metadata is read from the top level, `pagination` or `meta`: `total` / `totalCount`, `page` / `currentPage`, `pageSize` / `limit`, `totalPages`.
   - Pages are assumed to be **1-based**.
2. **`/auth/me`** may return the user directly or wrapped as `{ user }`. Both are accepted.
3. **Write endpoints.** **Change status is implemented**:
   - `PATCH /projects/{projectId}/general-tasks/{taskId}` with every editable field (title, description, status, priority, type, assigneeIds, startDate, dueDate, requiresApproval, approverIds, customFields, timeEstimateMinutes, sprintId), the same body the Loom web app sends.
   - The response omits list-only fields (project name, prefix, parent title, counts), so it is merged over the task already loaded. The list updates in place without refetching.
   - Create, assign, priority, edit and comment are **not implemented**. `LoomTaskWriteApi` refuses them (search `TODO(loom-api)`). To enable one, implement it there and add it to `SUPPORTED`.
4. **Assignee names:** tasks only carry `assigneeIds` and there is no users endpoint yet. Assignees therefore show as "You", "You + N others" or a count.
