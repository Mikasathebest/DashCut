# Release signing setup

DashCut always builds a one-click Windows x64 NSIS installer. Windows signing is currently optional, so an unsigned installer displays `Unknown publisher` and might trigger Microsoft Defender SmartScreen.

macOS installers are built only when all Apple signing and notarization credentials are configured. A tagged release still publishes the Windows installer when Apple credentials are absent.

## Required credentials

### Windows

No Windows signing secrets are currently required. The release workflow builds an unsigned x64 `.exe` with NSIS `oneClick` enabled.

New publicly trusted code-signing certificates normally keep their private keys in hardware or a compliant cloud HSM and cannot be exported as `.pfx`. For trusted Windows releases, migrate the workflow to Microsoft Artifact Signing or another CI-compatible remote signing service instead of uploading a private key to GitHub.

### macOS

1. Join the Apple Developer Program.
2. Create a **Developer ID Application** certificate, install it with its private key, then export both as a password-protected `.p12` from Keychain Access.
3. In App Store Connect, create a **Team API Key** for CI notarization and download its `AuthKey_<KEY_ID>.p8` file. Apple allows this file to be downloaded only once.
4. Record the API Key ID and Issuer ID.

This workflow expects:

- `MAC_CERTIFICATE_BASE64`: base64-encoded Developer ID `.p12`
- `MAC_CSC_KEY_PASSWORD`: `.p12` password
- `APPLE_API_KEY_P8_BASE64`: base64-encoded Team API Key `.p8`
- `APPLE_API_KEY_ID`: App Store Connect API Key ID
- `APPLE_API_ISSUER`: App Store Connect API Issuer ID

## Upload Apple secrets

Add the five Apple secrets through GitHub **Settings → Secrets and variables → Actions**, use `gh secret set` directly, or run the repository helper after authenticating GitHub CLI:

```bash
./scripts/configure-signing-secrets.sh Mikasathebest/DashCut
```

The helper reads passwords without echoing them and uploads only encrypted GitHub Actions secrets. Certificates and private keys are never committed.

## Validate

Run the **Build desktop installers** workflow manually. It verifies:

- the unsigned Windows x64 one-click installer was produced;
- the macOS application has a strict Developer ID signature;
- Apple notarization succeeded and a ticket is stapled;
- Gatekeeper accepts the application;
- the final DMG is signed.

After validation, pushing a tag such as `v0.1.0` always attaches the unsigned Windows x64 `.exe`. When Apple credentials are configured, it also attaches notarized macOS arm64 and x64 `.dmg` installers.
