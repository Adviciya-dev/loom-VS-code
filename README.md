# Loom (Adviciya) for VS Code

**See and work on your Loom tasks without leaving your editor.**

Loom is the task and project management platform built by [Adviciya Solutions](https://loom.adviciya.com). This extension brings the tasks assigned to you into the VS Code sidebar, so you can check what is next, read the details, update a status and jump to the full task in Loom, all without switching windows.

> You need a Loom account to use this extension. Sign in with the same email and password you use at [loom.adviciya.com](https://loom.adviciya.com).

## Features

### Sign in once, stay signed in
- Click the **Loom** icon in the Activity Bar and sign in with your email and password.
- Your session is stored in VS Code's secure storage (your operating system's keychain). Your password is never stored.
- You stay signed in across restarts. If your session expires, you are asked to sign in again.
- Sign out at any time from the Account view.

### My Tasks
- Shows the tasks **assigned to you** in the Loom project linked to your workspace.
- Tasks are grouped by status. *Done* and *Live Build* start collapsed.
- Subtasks are nested under their parent task.
- Each row shows the task key, title, priority, due date and a short preview of the description.
- **Search** by key, title or project, and **filter** by status, then **clear** both in one click.

### Account overview
- Your profile and a summary of your work in the linked project.
- A donut chart by status, with the percentage done in the middle. Click a status in the legend to show only those tasks.
- Tiles for **Remaining**, **Overdue**, **Due within 7 days** and **Blocked**.
- A badge on the Loom icon shows how many tasks remain.

### Task details
Open any task to see a full detail page:
- Title, key, project, type, status, priority and blocked or approval state.
- The formatted description (sanitized for safety), including lists, code blocks, links and tables.
- Assignee, start and due dates (with an overdue warning), parent task, subtask and dependency progress, sprint, time estimate, approvers and activity timestamps.

### Quick actions
Right-click a task, or use the buttons on the detail page:
- **Open in Loom** opens the task in your browser.
- **Copy Task Key** copies a key such as `THE-129`.
- **Change Status** moves the task to a new status.
- **Change Priority**, **Assign** and **Add Comment** are present but currently turned off. They will be enabled as the Loom API endpoints they need become available.

## Getting started

1. Install the extension.
2. Click the **Loom** icon in the Activity Bar and **sign in**.
3. Open your project folder in VS Code.
4. Link the folder to a Loom project (see below). Your assigned tasks appear under **My Tasks**.

### Link a workspace to a Loom project
Put a file named `.loom` in the root of your workspace folder:

```
project=<your Loom project ID>
```

Or run **Loom: Link Workspace to Loom Project** from the Command Palette, which creates the file for you.

- To show several projects, add one `project=` line for each, or separate the IDs with commas.
- Lines starting with `#` are comments.
- The file is watched, so changes apply immediately.
- A workspace with no `.loom` file is treated as "not a Loom project", and no tasks are fetched.

## Commands

All commands are in the Command Palette (`Ctrl/Cmd+Shift+P`) under the **Loom:** prefix.

| Command | What it does |
|---|---|
| Sign In / Sign Out | Start or end your Loom session |
| Refresh Tasks | Reload your tasks from Loom |
| Search Tasks… | Search by key, title or project |
| Filter Tasks… | Filter by status |
| Clear Search and Filters | Show all your tasks again |
| Open Task… | Pick a task and open its detail page |
| View Task Details | Open the detail page for the selected task |
| Open in Loom | Open the task in your browser |
| Copy Task Key | Copy the task key to the clipboard |
| Change Status… | Move a task to another status |
| Link Workspace to Loom Project | Create the `.loom` file for this folder |
| Show Logs | Open the Loom output channel for troubleshooting |

## Settings

Settings are under **Settings → Extensions → Loom**. The connection settings can only be changed in your **user** settings, not per workspace. This stops an untrusted project from redirecting your sign-in to another server.

| Setting | Default | Description |
|---|---|---|
| `loom.apiBaseUrl` | `https://loom.adviciya.com/api/v1` | Base URL of the Loom REST API |
| `loom.webBaseUrl` | `https://loom.adviciya.com` | Base URL of the Loom web app |
| `loom.taskUrlTemplate` | `{webBaseUrl}/projects/{projectId}/tasks?task={taskId}` | URL used by **Open in Loom**. Placeholders: `{webBaseUrl}`, `{taskId}`, `{projectId}`, `{taskKey}`, `{taskNumber}` |
| `loom.auth.refreshPath` | *(empty)* | Optional token-refresh endpoint. Leave empty unless your administrator tells you otherwise |
| `loom.pageSize` | `25` | Number of tasks fetched per page (1–100) |

## Privacy and security

- Your access and refresh tokens are kept in VS Code's `SecretStorage`. Your password is sent only to the Loom sign-in endpoint and is never saved.
- Tokens, passwords and `Authorization` headers are never written to logs.
- Task descriptions are sanitized before display, and the detail page runs under a strict content security policy with no remote content.
- The extension talks only to the Loom server configured in `loom.apiBaseUrl`. It collects no telemetry.

## Requirements

- VS Code 1.90 or later
- A Loom account at your organization's Loom server

## Troubleshooting

| Problem | What to try |
|---|---|
| "This isn't a Loom project" | Add a `.loom` file with your project ID, or run **Loom: Link Workspace to Loom Project** |
| Tasks do not appear | Run **Loom: Refresh Tasks**. Only tasks assigned to you in the linked project are shown |
| Signed out unexpectedly | Your session expired. Sign in again |
| "Could not reach Loom" | Check your network connection and `loom.apiBaseUrl` |
| Something else | Run **Loom: Show Logs** and include the output when you contact us |

## Support and company

**Adviciya Solutions** builds Loom, a task and project management platform for teams.

- Loom: [loom.adviciya.com](https://loom.adviciya.com)
- Source and issue tracker: [github.com/Adviciya-dev/loom-VS-code](https://github.com/Adviciya-dev/loom-VS-code)
- Report a bug or request a feature: [open an issue](https://github.com/Adviciya-dev/loom-VS-code/issues)

## License

Copyright © 2026 Adviciya Solutions. All rights reserved. This software is proprietary. See the [LICENSE](LICENSE) file.
