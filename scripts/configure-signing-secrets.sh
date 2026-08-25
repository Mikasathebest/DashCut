#!/usr/bin/env bash
set -euo pipefail

repository="${1:-Mikasathebest/DashCat}"

read -r -p "Windows OV code-signing .pfx path: " windows_certificate
read -r -s -p "Windows .pfx password: " windows_password
printf '\n'
read -r -p "Apple Developer ID Application .p12 path: " mac_certificate
read -r -s -p "Apple .p12 password: " mac_password
printf '\n'
read -r -p "App Store Connect Team API key .p8 path: " apple_api_key
read -r -p "Apple API Key ID: " apple_api_key_id
read -r -p "Apple API Issuer ID: " apple_api_issuer

for file in "$windows_certificate" "$mac_certificate" "$apple_api_key"; do
  if [[ ! -f "$file" ]]; then
    echo "File not found: $file" >&2
    exit 1
  fi
done

if [[ -z "$windows_password" || -z "$mac_password" || -z "$apple_api_key_id" || -z "$apple_api_issuer" ]]; then
  echo "Passwords, Key ID, and Issuer ID must not be empty." >&2
  exit 1
fi

base64 < "$windows_certificate" | tr -d '\n' | gh secret set WINDOWS_CERTIFICATE_BASE64 --repo "$repository"
printf '%s' "$windows_password" | gh secret set WIN_CSC_KEY_PASSWORD --repo "$repository"
base64 < "$mac_certificate" | tr -d '\n' | gh secret set MAC_CERTIFICATE_BASE64 --repo "$repository"
printf '%s' "$mac_password" | gh secret set MAC_CSC_KEY_PASSWORD --repo "$repository"
base64 < "$apple_api_key" | tr -d '\n' | gh secret set APPLE_API_KEY_P8_BASE64 --repo "$repository"
printf '%s' "$apple_api_key_id" | gh secret set APPLE_API_KEY_ID --repo "$repository"
printf '%s' "$apple_api_issuer" | gh secret set APPLE_API_ISSUER --repo "$repository"

unset windows_password mac_password
echo "Signing secrets configured for $repository."
