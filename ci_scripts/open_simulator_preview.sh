#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
devices=$(xcrun simctl list devices available -j)
device=$(python3 -c '
import json,sys
devices=json.load(sys.stdin)["devices"]
phones=[d for k in reversed(list(devices)) if ".iOS-" in k for d in devices[k] if "iPhone" in d["name"]]
if not phones: sys.exit("Install an iPhone Simulator runtime in Xcode, then run this again.")
print(next((d for d in phones if d["state"]=="Booted"),phones[0])["udid"])
' <<< "$devices")
open -a Simulator
xcrun simctl bootstatus "$device" -b
build_dir="$HOME/Library/Developer/Xcode/DerivedData/GalaxySimulatorPreview"
xcodebuild -quiet -project GalaxyBluetooth.xcodeproj -scheme GalaxyBluetooth -configuration Debug -destination "platform=iOS Simulator,id=$device" -derivedDataPath "$build_dir" build
for app in "$build_dir"/Build/Products/Debug-iphonesimulator/*.app; do
  bundle=$(/usr/libexec/PlistBuddy -c 'Print CFBundleIdentifier' "$app/Info.plist")
  if [[ $bundle == link.galaxy.bluetooth.natehuby76.preview ]]; then
    xcrun simctl install "$device" "$app"
    xcrun simctl launch --terminate-running-process "$device" "$bundle" --preview-galaxy --simulator-toggles
    exit 0
  fi
done
echo 'The simulator preview app was not found.' >&2
exit 1
