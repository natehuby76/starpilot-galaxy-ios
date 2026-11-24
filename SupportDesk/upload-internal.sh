#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
sdk="$(xcrun --sdk iphoneos --show-sdk-version)"
if (( ${sdk%%.*} < 27 )); then
  echo "Select Xcode with the iOS 27 SDK or newer for iPhone Duo." >&2
  exit 1
fi
xcodegen generate
output="$(mktemp -d)"
xcodebuild -project SupportDesk.xcodeproj -scheme SupportDesk -configuration Release \
  -destination 'generic/platform=iOS' -archivePath "$output/SupportDesk.xcarchive" \
  -allowProvisioningUpdates archive
xcodebuild -exportArchive -archivePath "$output/SupportDesk.xcarchive" \
  -exportOptionsPlist ExportOptions.plist -exportPath "$output/export" \
  -allowProvisioningUpdates
