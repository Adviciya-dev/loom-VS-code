# Publishing Loom (Adviciya) to the VS Code Marketplace

Releases are published from Azure DevOps using **Microsoft Entra ID** (Workload Identity Federation + a User-Assigned Managed Identity). No Personal Access Token (PAT) is stored anywhere.

> Global Azure DevOps PATs retire on **1 December 2026**, so do not set up `vsce login` / `VSCE_PAT` for this project.

```
Azure DevOps pipeline
  → Service connection (Workload Identity Federation)
  → User-Assigned Managed Identity (Azure)
  → Microsoft Entra ID token
  → Marketplace publisher "adviciya"
  → vsce publish --azure-credential
```

## Project facts this guide relies on

| Item | Value | Where |
|---|---|---|
| Extension ID | `adviciya.loom-vscode` | `package.json` (`publisher` + `name`) |
| Display name | Loom (Adviciya) | `package.json` |
| Publisher ID | `adviciya` (must match the Marketplace publisher exactly) | `package.json` |
| Min VS Code | `^1.90.0` | `engines.vscode` |
| Node | 20.x | `@types/node ^20` |
| Source repo | `Adviciya-dev/loom-VS-code` on GitHub | `git remote -v` |
| Bundling | esbuild → `dist/extension.js`, so `node_modules` is not shipped | `esbuild.mjs`, `.vscodeignore` |
| Package script | `vsce package --no-dependencies` | `npm run vsix` |
| Pre-publish hook | `npm run typecheck && npm run package` | `vscode:prepublish` |

## Before the first release: `package.json` checklist

1. **Remove `"private": true`.** `vsce` refuses to publish a private extension.
2. **Replace `"license": "UNLICENSED"`.** Keep it only if closed-source is intended. `vsce` warns when there is no `LICENSE` file, so add one (or pass `--skip-license` in the pipeline).
3. **Add a `repository` field** (`https://github.com/Adviciya-dev/loom-VS-code.git`). Without it, `vsce` warns and cannot rewrite relative links and images in `README.md`.
4. **Confirm `media/icon.png`** exists. It is referenced by `"icon"`, and Marketplace requires a PNG of at least 128×128.
5. **Bump `version`.** The Marketplace rejects a version that is already published.
6. Make sure `README.md` is what you want on the listing page. `Doc.md`, `.loom`, `icon.svg` and `src/`, `test/` are already excluded by `.vscodeignore`. **Add `PUBLISHING.md` to `.vscodeignore`** so this file is not shipped in the VSIX.

## One-time setup

### 1. Marketplace publisher

1. Go to <https://marketplace.visualstudio.com/manage> and sign in with the Microsoft account that will own the publisher.
2. **Create publisher**:
   - ID: `adviciya`
   - Name: `Adviciya Solutions`
3. Confirm `publisher` in `package.json` is exactly `adviciya`.

### 2. Azure resources

You need an Azure subscription (the free tier is enough; none of the resources below cost anything).

1. [Azure Portal](https://portal.azure.com) → **Resource groups** → create `vscode-publishing-rg` in the nearest region (e.g. Central India).
2. **Managed Identities** → **Create** → *User Assigned Managed Identity*:
   - Name: `loom-vscode-publisher`
   - Resource group: `vscode-publishing-rg`
3. Record these from the identity's overview page: **Client ID**, **Tenant ID**, **Subscription ID**.

### 3. Azure DevOps service connection

1. <https://dev.azure.com> → open (or create) a project, e.g. `VSCodeExtensions`.
2. **Project Settings → Service connections → New service connection → Azure Resource Manager**.
3. Authentication method: **Workload Identity federation (manual)**. Name it `loom-vscode-publisher-connection` and save it as a **draft**.
4. Copy the generated **Issuer** and **Subject identifier**.
5. In the Azure Portal, open the managed identity → **Federated credentials → Add credential**:
   - Scenario: *Other issuer*
   - Issuer: the Azure DevOps issuer URL
   - Subject identifier: the Azure DevOps subject
   - Audience: `api://AzureADTokenExchange`
6. Back in Azure DevOps, finish the connection with the Tenant ID, Subscription ID, Subscription name and Client ID. Click **Verify**, then **Save**. It should show **Ready**.
7. Under the connection's security settings, either grant access to all pipelines or authorize only the release pipeline.

### 4. Give the identity access to the publisher

The Marketplace identifies the identity by its Azure DevOps profile ID, not by the Azure Client ID.

1. Create a throwaway pipeline that runs:

   ```yaml
   - task: AzureCLI@2
     displayName: Get identity profile ID
     inputs:
       azureSubscription: loom-vscode-publisher-connection
       scriptType: bash
       scriptLocation: inlineScript
       inlineScript: |
         az rest -u https://app.vssps.visualstudio.com/_apis/profile/profiles/me \
           --resource 499b84ac-1321-427f-aa17-267ca6975798
   ```

2. Copy the `id` from the JSON response.
3. At <https://marketplace.visualstudio.com/manage> → publisher `adviciya` → **Members → Add** → paste the `id` → role **Contributor** → save.
4. Delete the throwaway pipeline.

## Verify locally before releasing

```bash
npm ci
npm run typecheck
npm test
npm run vsix           # produces loom-vscode-<version>.vsix
```

Install the VSIX in VS Code (`Extensions: Install from VSIX…`) and check sign-in and My Tasks still work. Inspect the contents with `npx @vscode/vsce ls --no-dependencies`. It should list `dist/extension.js`, `media/`, `package.json`, `README.md` and no source or test files.

## Release pipeline

Save as `azure-pipelines.yml` in the repo root.

The source lives on GitHub, so in Azure DevOps create the pipeline via **New pipeline → GitHub** (this needs a GitHub service connection / the Azure Pipelines GitHub app on `Adviciya-dev/loom-VS-code`).

The pipeline runs on **version tags** (`v*`), not on every push to `main`. Publishing on every push fails whenever `version` has not been bumped.

```yaml
trigger:
  tags:
    include:
      - v*
pr: none

pool:
  vmImage: ubuntu-latest

steps:
  - task: NodeTool@0
    displayName: Use Node 20
    inputs:
      versionSpec: 20.x

  - script: |
      npm ci
      npm run typecheck
      npm test
    displayName: Install, typecheck, test

  - task: AzureCLI@2
    displayName: Publish to Marketplace
    inputs:
      azureSubscription: loom-vscode-publisher-connection
      scriptType: bash
      scriptLocation: inlineScript
      inlineScript: |
        npx --yes @vscode/vsce@latest publish --azure-credential --no-dependencies
```

Notes:

- `vsce publish` runs `vscode:prepublish` (`typecheck` + `package`), so the production bundle is built automatically.
- `--no-dependencies` matches `npm run vsix`. esbuild bundles everything into `dist/`, so `node_modules` must not be packaged.
- The `AzureCLI@2` task signs in to Azure with the service connection, and `--azure-credential` makes `vsce` use that session. Do not pass `-p` or set `VSCE_PAT`.

## Releasing a new version

```bash
npm version patch            # or minor / major; updates package.json and package-lock.json, creates tag vX.Y.Z
git push origin main --follow-tags
```

The tag triggers the pipeline. Then check <https://marketplace.visualstudio.com/manage> for the new version. Marketplace validation can take a few minutes before it appears publicly.

To publish by hand (for example, the very first release, to confirm the publisher is set up), upload `loom-vscode-<version>.vsix` via **Marketplace → publisher → New extension → Visual Studio Code**.

## Troubleshooting

| Symptom | Check |
|---|---|
| `Extension is marked as private` | Remove `"private": true` from `package.json`. |
| `Publisher 'adviciya' not found` / `ENOPUB` | `publisher` in `package.json` must match the Marketplace publisher ID exactly. |
| `You exceeded the number of allowed tags` / version already exists | Bump `version`. Marketplace never accepts a re-upload of the same version. |
| 401 / 403 on publish | The managed identity's profile ID is missing from the publisher's **Members**, or it is not **Contributor**. Redo step 4. |
| Service connection will not verify | Federated credential Issuer or Subject differs from what Azure DevOps generated. Copy them again, and check Client ID and Tenant ID. |
| `AADSTS70021: No matching federated identity record` | Same as above: the subject or issuer is wrong. |
| `--azure-credential` not recognised | Old `vsce`. Use `@vscode/vsce@latest`. |
| Pipeline cannot use the service connection | Authorize the pipeline on the connection (step 3.7). |
| Missing icon or broken images on the listing | Add `repository` to `package.json` and make sure `media/icon.png` exists. |

## Cost

All free: Marketplace publisher, Azure DevOps service connection, Workload Identity Federation, managed identity, Entra ID Free, and `vsce`. No Entra license purchase is needed.
