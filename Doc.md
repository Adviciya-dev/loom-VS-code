Build a production-ready VS Code extension for our team's task-management platform called **Loom (Adviciya)**.

Loom is our internal task/project management platform, similar to ClickUp or Zoho. The extension should allow developers to manage Loom tasks directly inside VS Code.

## 1. FIRST PRIORITY: LOGIN

When the extension is opened:

- Add a **Loom icon to the VS Code Activity Bar**.
- Open a Loom sidebar.
- If the user is not authenticated, show a professional Loom login screen.
- Login fields:
  - Email
  - Password
- Authenticate using:

`POST https://loom.adviciya.com/api/v1/auth/login`

Request:

```json
{
  "email": "<email>",
  "password": "<password>"
}
```

The response contains:

```ts
{
  accessToken: string;
  refreshToken: string;
  user: LoomUser;
}
```

After successful login:

- Store tokens securely using VS Code `SecretStorage`.
- Never store the password.
- Keep the user logged in across VS Code restarts.
- Decode JWT expiration locally to determine when renewal is required.
- Refresh/reauthenticate before the access token expires.
- Provide a Logout action.
- Never log tokens, passwords, or Authorization headers.

Do NOT invent authentication endpoints.

The confirmed endpoints are:

```text
POST /auth/login
GET  /auth/me
```

The refresh endpoint is currently unconfirmed, so keep refresh functionality abstract and configurable.

---

## 2. AUTHENTICATION MANAGER

Create an `AuthManager`.

It should provide:

```ts
getAccessToken(): Promise<string>
handleUnauthorized(): Promise<string>
logout(): Promise<void>
```

Requirements:

- Renew the access token when it expires within 60 seconds.
- If a refresh endpoint becomes available, use the refresh token.
- Otherwise require login again.
- If multiple requests need renewal simultaneously, only make ONE renewal request and let the others wait for it.
- A request receiving `401` may be retried only once after authentication renewal.
- Do not create authentication loops.
- Handle invalid credentials cleanly.
- Clear stored credentials on logout.

Use a 30-second throttle for repeated login attempts.

---

## 3. CURRENT USER

After login call:

```text
GET /auth/me
```

Header:

```text
Authorization: Bearer <accessToken>
```

Use `/auth/me` as the source of truth for the current user's identity.

Display:

- Name
- Email
- Role
- Avatar/initials
- GitHub username when available

The login response may contain additional profile fields, so merge those when appropriate.

---

## 4. TASK SIDEBAR

After successful authentication, replace the login screen with the Loom task interface.

Main sections:

- My Tasks
- Projects
- Status
- Assigned Tasks
- Created Tasks

Initially, fetch the current user's assigned tasks using:

```text
GET /general-tasks/page
```

Parameters:

```text
page
pageSize
assigneeId
sort
order
```

Default:

```text
assigneeId = currentUser.id
sort = createdAt
order = desc
```

Do not assume undocumented server-side filters.

---

## 5. TASK DISPLAY

Each task should display:

- Task key, e.g. `THE-129`
- Title
- Status
- Priority
- Project
- Assignee
- Due date
- Last activity
- Parent task when available
- Subtask count
- Dependency information
- Approval status when available

Task key:

```text
${projectTaskPrefix}-${taskNumber}
```

Example:

```text
THE-129
```

Support these statuses:

```text
todo
in_progress
in_review
to_be_tested
reopen
on_hold
stage_deployement
live_build
done
```

Keep the API's `stage_deployement` spelling internally, but display it as:

```text
Staging Deployment
```

Create friendly labels for all statuses.

---

## 6. TASK LIST FEATURES

Implement:

- Pagination
- Next/previous page
- Jump to page
- Refresh
- Search
- Client-side filtering
- Group by project
- Group by parent task
- Task detail view
- Open task in Loom web application

Display the API-provided task counts exactly as returned.

Do not recalculate them.

---

## 7. TASK CREATION / MANAGEMENT

The extension should be architected to support:

- Add task
- Assign task
- Reassign task
- Change status
- Change priority
- Edit task
- Add comments
- View task details

However, **do not invent write endpoints**.

The currently documented API only guarantees login, current-user, and task-list functionality.

Until write endpoints are provided:

- Implement the UI architecture.
- Keep write operations behind an API service abstraction.
- Clearly mark undocumented operations as TODO.
- Do not make fake API calls.

---

## 8. API CLIENT

Create a dedicated Loom API client.

Example:

```ts
loomClient.login(email, password)
loomClient.me()
loomClient.getTasksPage(params)
loomClient.getAllTasks(params)
```

Base URL:

```text
https://loom.adviciya.com/api/v1
```

Make it configurable.

Every API response uses:

```ts
interface ApiEnvelope<T> {
  success: boolean;
  data: T;
  message: string;
  meta: {
    timestamp: string;
  };
}
```

Always verify:

```ts
success === true
```

Do not rely only on HTTP status.

API requirements:

- 10-second timeout.
- Retry network errors and 5xx responses up to 2 times.
- Never retry normal 4xx errors.
- 401 gets the special authentication renewal + one retry flow.
- Cache task pages for 30 seconds.
- Clear cache on logout/user change.
- Maximum 50 pages when fetching all tasks.

---

## 9. TASK TYPES

Use strong TypeScript types.

```ts
interface Task {
  id: string;
  projectId: string;
  projectName: string;
  projectTaskPrefix: string;
  taskNumber: number;
  title: string;
  description: string;
  status: TaskStatus;
  priority: "high" | "normal" | string;
  type: "issue" | "task" | string;
  assigneeIds: string[];
  createdById: string;
  dueDate: string | null;
  startDate: string | null;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string | null;
  parentTaskId: string | null;
  parentTitle: string | null;
  parentTaskNumber: number | null;
  sprintId: string | null;
  sprintName: string | null;
  sprintIsActive: boolean;
  requiresApproval: boolean;
  approverIds: string[];
  approvedByIds: string[];
  approvalStatus: "none" | string;
  dependencyCount: number;
  dependencyDoneCount: number;
  isBlocked: boolean;
  subtaskCount: number;
  subtaskDoneCount: number;
  timeEstimateMinutes: number | null;
  autoCompletedFromStatus: string | null;
  customFields: Record<string, unknown>;
}
```

Use Zod for runtime validation.

Unknown enum values must not crash the extension. Log them safely and display a generic label.

---

## 10. DESCRIPTION HANDLING

Task descriptions are HTML.

Sanitize HTML before displaying it.

Support elements such as:

```text
<p>
<br>
<strong>
<code>
```

Strip HTML and truncate descriptions to approximately 140 characters for list previews.

---

## 11. TITLE HANDLING

Some task titles may start with punctuation/whitespace.

Trim leading punctuation/whitespace for display while preserving the raw title.

Extract test-case references using:

```regex
/Related TC:\s*([A-Z]+-\d+)/i
```

Display the extracted test-case reference as a badge.

---

## 12. VS CODE UX

Use native VS Code APIs wherever possible.

Add:

- Activity Bar icon
- Sidebar TreeView
- Task detail view
- Command Palette commands
- Context menu actions
- Refresh command
- Login/logout commands
- Create task command
- Assign task command
- Open task command

The extension should feel like a native VS Code feature, not simply a website embedded inside VS Code.

Use Webviews only where they provide a clear UX benefit.

---

## 13. PROJECT STRUCTURE

Use TypeScript and a clean architecture such as:

```text
src/
  extension.ts

  api/
    LoomClient.ts
    ApiTypes.ts

  auth/
    AuthManager.ts
    TokenManager.ts

  commands/
    login.ts
    logout.ts
    refreshTasks.ts
    createTask.ts
    assignTask.ts

  models/
    User.ts
    Task.ts

  views/
    LoomTreeProvider.ts
    LoginView.ts
    TaskDetailView.ts

  services/
    TaskService.ts

  utils/
    logger.ts
    sanitizer.ts
    formatters.ts
```

Keep API logic completely separate from UI logic.

---

## 14. SECURITY

Strict requirements:

- Never hardcode credentials.
- Never commit credentials.
- Never log passwords.
- Never log tokens.
- Never log Authorization headers.
- Use VS Code SecretStorage for authentication tokens.
- Add `.env` to `.gitignore` if environment configuration is used.
- Provide `.env.example` with empty values.
- Redact sensitive information from logs.
- Unit-test the redaction logic.

---

## 15. TESTING

Create tests for:

- Successful login
- Invalid login
- Token expiration
- Token renewal
- 401 handling
- Concurrent requests requiring renewal
- Logout
- `/auth/me`
- Task parsing
- Pagination
- Status formatting
- Title cleanup
- Test-case extraction
- HTML sanitization
- Log redaction

Use fake tokens and fake credentials in tests.

Never use real credentials in fixtures.

---

## 16. IMPORTANT DEVELOPMENT ORDER

Build in this order:

### Phase 1
VS Code extension + Activity Bar + Loom sidebar.

### Phase 2
Login UI + `/auth/login`.

### Phase 3
Secure token storage + session management.

### Phase 4
`/auth/me` + user profile.

### Phase 5
Task API + task list.

### Phase 6
Pagination + grouping + filtering + task details.

### Phase 7
VS Code commands/context menus.

### Phase 8
Task creation/assignment/status editing once the corresponding Loom API endpoints are provided.

Do not move ahead by inventing undocumented API endpoints.

The first milestone should be:

**Open VS Code → click Loom → login → authenticate → stay logged in → display current user → display assigned tasks.**

After that works, build the task-management actions.