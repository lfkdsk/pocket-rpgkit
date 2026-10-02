#!/bin/bash
# Developer ID signing and notarization steps for the "Studio desktop"
# workflow (.github/workflows/studio-desktop.yml). Runs on a macOS runner from
# studio-desktop/.
#
#   ci-mac-signing.sh setup            # keychain + certificate, API key file; writes $GITHUB_ENV
#   ci-mac-signing.sh sign-helper      # sign app/helper/* with entitlements.helper.plist
#   ci-mac-signing.sh verify-app <app> # codesign, stapler and Gatekeeper checks
#   ci-mac-signing.sh dmg <dmg>...     # sign, notarize, staple and assess each dmg
#   ci-mac-signing.sh cleanup          # delete what setup created
#
# Why the workflow signs some things itself: electron-builder signs every
# nested Mach-O file with one entitlements file (entitlementsInherit), so the
# helper is signed here first, with its own entitlements, and electron-builder
# is told to leave it alone (-c.mac.signIgnore). electron-builder also neither
# signs with a timestamp nor notarizes a dmg, so `dmg` does that.
#
# setup reads MAC_CERT_P12_BASE64 and MAC_CERT_PASSWORD, and optionally
# APPLE_API_KEY (the .p8 contents), APPLE_API_KEY_ID and APPLE_API_ISSUER.
# It never prints them.
set -euo pipefail

temp="${RUNNER_TEMP:?RUNNER_TEMP is not set}"
keychain="$temp/studio-signing.keychain-db"
cert_file="$temp/studio-signing.p12"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Append NAME=value to $GITHUB_ENV for the later steps.
export_env() {
  printf '%s=%s\n' "$1" "$2" >> "${GITHUB_ENV:?GITHUB_ENV is not set}"
}

setup() {
  : "${MAC_CERT_P12_BASE64:?MAC_CERT_P12_BASE64 is empty}"
  local password
  password="$(openssl rand -hex 24)"
  echo "::add-mask::$password"

  security create-keychain -p "$password" "$keychain"
  # No timeout and no lock on sleep: stays unlocked for the rest of the job.
  security set-keychain-settings "$keychain"
  security unlock-keychain -p "$password" "$keychain"

  (umask 077 && printf '%s' "$MAC_CERT_P12_BASE64" | base64 --decode > "$cert_file")
  security import "$cert_file" -k "$keychain" -P "${MAC_CERT_PASSWORD:-}" -f pkcs12 \
    -T /usr/bin/codesign >/dev/null
  rm -f "$cert_file"
  # An exported .p12 usually holds only the certificate and its key; codesign
  # also needs Apple's Developer ID intermediate to build the chain.
  local ca
  for ca in DeveloperIDG2CA DeveloperIDCA; do
    if curl -fsSL "https://www.apple.com/certificateauthority/$ca.cer" -o "$temp/$ca.cer"; then
      security import "$temp/$ca.cer" -k "$keychain" >/dev/null 2>&1 || true
      rm -f "$temp/$ca.cer"
    else
      echo "::warning::could not download Apple's $ca intermediate certificate"
    fi
  done
  security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$password" "$keychain" >/dev/null
  # codesign resolves the certificate chain only through the search list.
  local existing
  existing="$(security list-keychains -d user | sed -e 's/^[[:space:]]*"//' -e 's/"$//')"
  # shellcheck disable=SC2086
  security list-keychains -d user -s "$keychain" $existing

  local identity
  identity="$(security find-identity -v -p codesigning "$keychain" |
    awk '/"Developer ID Application: / { print $2; exit }')"
  if [ -z "$identity" ]; then
    echo "::error::MAC_CERT_P12_BASE64 holds no valid Developer ID Application identity"
    exit 1
  fi
  # electron-builder finds the identity in this keychain (no CSC_LINK, so it
  # does not create and import into a keychain of its own).
  export_env CSC_KEYCHAIN "$keychain"
  export_env STUDIO_SIGN_IDENTITY "$identity"

  if [ -n "${APPLE_API_KEY:-}" ] && [ -n "${APPLE_API_KEY_ID:-}" ] && [ -n "${APPLE_API_ISSUER:-}" ]; then
    local key_file="$temp/AuthKey_${APPLE_API_KEY_ID}.p8"
    (umask 077 && printf '%s\n' "$APPLE_API_KEY" > "$key_file")
    # electron-builder notarizes the app when all three are set.
    export_env APPLE_API_KEY "$key_file"
    export_env APPLE_API_KEY_ID "$APPLE_API_KEY_ID"
    export_env APPLE_API_ISSUER "$APPLE_API_ISSUER"
    export_env STUDIO_NOTARIZE true
  else
    echo "::notice::App Store Connect API key secrets are incomplete: the build is signed but not notarized."
    export_env STUDIO_NOTARIZE false
  fi
}

sign_helper() {
  : "${STUDIO_SIGN_IDENTITY:?run setup first}"
  local helper signed=0
  for helper in "$here"/app/helper/*; do
    [ -f "$helper" ] || continue
    codesign --force --timestamp --options runtime \
      --entitlements "$here/build-resources/entitlements.helper.plist" \
      --keychain "$keychain" --sign "$STUDIO_SIGN_IDENTITY" "$helper"
    codesign --verify --strict --verbose=2 "$helper"
    lipo -archs "$helper"
    signed=$((signed + 1))
  done
  if [ "$signed" -eq 0 ]; then
    echo "::error::no helper in app/helper (run bun run build first)"
    exit 1
  fi
}

verify_app() {
  local app="${1:?usage: verify-app <app>}"
  codesign --verify --deep --strict --verbose=2 "$app"
  codesign --display --verbose=2 "$app" 2>&1 | grep -E '^(Authority|TeamIdentifier|Timestamp|Runtime Version)' || true
  codesign --display --entitlements - "$app/Contents/Resources/helper/rpgkit-studio-helper"
  if [ "${STUDIO_NOTARIZE:-false}" = true ]; then
    xcrun stapler validate "$app"
    spctl -a -vvv -t exec "$app"
  fi
}

notarize_file() {
  local file="$1" result="$temp/notarytool.json" status id
  xcrun notarytool submit "$file" --key "$APPLE_API_KEY" --key-id "$APPLE_API_KEY_ID" \
    --issuer "$APPLE_API_ISSUER" --wait --output-format json > "$result" || true
  status="$(plutil -extract status raw -o - "$result" 2>/dev/null || echo unknown)"
  id="$(plutil -extract id raw -o - "$result" 2>/dev/null || echo "")"
  echo "notarytool: $(basename "$file"): $status ${id:+(submission $id)}"
  if [ "$status" != Accepted ]; then
    if [ -n "$id" ]; then
      xcrun notarytool log "$id" --key "$APPLE_API_KEY" --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_ISSUER" || true
    fi
    echo "::error::notarization of $(basename "$file") ended with status $status"
    exit 1
  fi
}

dmg() {
  : "${STUDIO_SIGN_IDENTITY:?run setup first}"
  [ "$#" -gt 0 ] || { echo "usage: dmg <dmg>..." >&2; exit 2; }
  local file
  for file in "$@"; do
    codesign --force --timestamp --keychain "$keychain" --sign "$STUDIO_SIGN_IDENTITY" "$file"
    codesign --verify --strict --verbose=2 "$file"
    if [ "${STUDIO_NOTARIZE:-false}" = true ]; then
      notarize_file "$file"
      xcrun stapler staple "$file"
      xcrun stapler validate "$file"
      spctl -a -vvv -t install "$file"
    fi
  done
}

cleanup() {
  if [ -f "$keychain" ]; then
    # Also removes it from the search list.
    security delete-keychain "$keychain" || rm -f "$keychain"
  fi
  rm -f "$cert_file" "$temp"/AuthKey_*.p8 "$temp/notarytool.json"
}

case "${1:-}" in
  setup) setup ;;
  sign-helper) sign_helper ;;
  verify-app) shift; verify_app "$@" ;;
  dmg) shift; dmg "$@" ;;
  cleanup) cleanup ;;
  *) echo "usage: $0 setup | sign-helper | verify-app <app> | dmg <dmg>... | cleanup" >&2; exit 2 ;;
esac
