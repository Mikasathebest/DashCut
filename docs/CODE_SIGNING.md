# Release signing setup

FrameFlow releases fail closed: a tagged release is not published unless both installers are signed and the macOS app is notarized successfully.

## Required credentials

### Windows

Obtain an exportable OV Authenticode code-signing certificate from a trusted CA and export it as a password-protected `.pfx` containing its private key.

This workflow expects:

- `WINDOWS_CERTIFICATE_BASE64`: base64-encoded `.pfx`
- `WIN_CSC_KEY_PASSWORD`: `.pfx` password

EV certificates stored on hardware tokens cannot be exported as `.pfx`; use Azure Trusted Signing or an HSM-specific workflow instead.

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

## Upload secrets

With GitHub CLI authenticated, run:

```bash
./scripts/configure-signing-secrets.sh Mikasathebest/DashCat
```

The helper reads passwords without echoing them and uploads only encrypted GitHub Actions secrets. Certificates and private keys are never committed.

## Validate

Run the **Build signed desktop installers** workflow manually. It verifies:

- the Windows installer has a valid Authenticode signature;
- the macOS application has a strict Developer ID signature;
- Apple notarization succeeded and a ticket is stapled;
- Gatekeeper accepts the application;
- the final DMG is signed.

After validation, pushing a tag such as `v0.1.0` builds and attaches the signed `.exe` and notarized universal `.dmg` to the GitHub Release.
