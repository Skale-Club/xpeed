# Signing Xpeed Companion (optional)

An unsigned installer works, but Windows SmartScreen warns about an "unknown publisher". A signed one shows "Xpeed" (the
validated publisher) and the warning goes away much faster. Signing is **off until you set it up**: the release pipeline
(`.github/workflows/xpeed-sim.yml`, job `release`) signs only when every secret and variable below exists. Nothing breaks
without them: the release is made unsigned and its notes say "Unsigned build".

The service is **Azure Trusted Signing** (Microsoft may show it as Artifact Signing in the portal). Cost: the Basic plan,
about US$ 10 a month. Do the steps in this order; the validation in step 2 is the only slow one (days, sometimes weeks).

## 1. Azure account and the signing account

1. In the [Azure portal](https://portal.azure.com), use (or create) a subscription with billing turned on.
2. Subscriptions > your subscription > **Resource providers** > register **Microsoft.CodeSigning**.
3. Search "Trusted Signing Accounts" > **Create**. Pick a resource group, a **name** (this is `AZURE_SIGNING_ACCOUNT`),
   a **region** and the **Basic** plan.
4. Note the **endpoint** for the region you chose (this is `AZURE_SIGNING_ENDPOINT`), for example:
   `https://eus.codesigning.azure.net` (East US), `https://weu.codesigning.azure.net` (West Europe),
   `https://wus2.codesigning.azure.net` (West US 2), `https://neu.codesigning.azure.net` (North Europe).
   The list is in Microsoft's Trusted Signing documentation; use exactly the endpoint of the region of your account.

## 2. Identity validation

1. In the signing account: **Identity validations** > **New identity** > **Public**.
2. Fill in the legal name of the publisher (the company, or you as an individual where Microsoft allows it) and the
   address. Microsoft checks it against public records and may ask for documents. The name you validate is the name
   Windows shows as the publisher.
3. Wait until the status is **Completed**. You cannot create the certificate profile before that.

## 3. Certificate profile

1. In the signing account: **Certificate profiles** > **Create** > type **Public Trust**.
2. Give it a name (this is `AZURE_SIGNING_PROFILE`, for example `xpeed-public`) and pick the identity validated in step 2.

## 4. App registration that CI signs as

1. **Microsoft Entra ID** > **App registrations** > **New registration**, name it `xpeed-github-signing`, single tenant,
   no redirect address.
2. On its overview page copy the **Directory (tenant) ID** (`AZURE_TENANT_ID`) and the **Application (client) ID**
   (`AZURE_CLIENT_ID`).
3. **Certificates & secrets** > **New client secret**. Copy the **Value** right away (`AZURE_CLIENT_SECRET`); it is shown
   once. It expires (6 to 24 months, your choice): put the date in your calendar, signing stops when it lapses.
4. Back in the **signing account** > **Access control (IAM)** > **Add role assignment** > role
   **Trusted Signing Certificate Profile Signer** > assign it to the app registration from step 1.
   (The role is on the signing account or on the certificate profile; the account is simpler.)

## 5. What to add in GitHub

Repository **Skale-Club/xpeed** > Settings > Secrets and variables > Actions.

| Where | Name | Value |
| --- | --- | --- |
| Secret | `AZURE_TENANT_ID` | Directory (tenant) ID, step 4 |
| Secret | `AZURE_CLIENT_ID` | Application (client) ID, step 4 |
| Secret | `AZURE_CLIENT_SECRET` | the client secret value, step 4 |
| Variable | `AZURE_SIGNING_ENDPOINT` | the endpoint of your region, step 1 |
| Variable | `AZURE_SIGNING_ACCOUNT` | the signing account name, step 1 |
| Variable | `AZURE_SIGNING_PROFILE` | the certificate profile name, step 3 |

The secrets are under **Secrets**, the other three under **Variables** (they are not secret). All six must exist.

## 6. Check that it works

1. Release a new version (see [RELEASES.md](RELEASES.md)).
2. In the workflow run, the step "Is code signing set up?" says "Code signing is set up", and the two "Sign ..." steps run.
3. The `companion-latest` release notes say "Signed build.", and `https://<site>/api/companion/latest` answers
   `"signed": true`. The public Companion page then hides the SmartScreen note by itself.
4. On a Windows PC: right-click the downloaded installer > Properties > **Digital Signatures** shows the publisher.

## If it fails

- "403" or "not authorized" in a Sign step: the role in step 4.4 is missing or was given to another app registration.
- "profile not found": `AZURE_SIGNING_PROFILE` or `AZURE_SIGNING_ACCOUNT` has a typo, or the endpoint is the wrong region.
- It worked and then stopped: the client secret expired. Create a new one (step 4.3) and replace `AZURE_CLIENT_SECRET`.
- To go back to unsigned releases, delete any one of the six; the next release is unsigned again.
