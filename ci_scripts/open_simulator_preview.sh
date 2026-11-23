#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
if ! xcrun --find simctl >/dev/null 2>&1; then
  export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
fi
simctl=$(xcrun --find simctl)
developer_dir=${simctl%/usr/bin/simctl}
devices=$(xcrun simctl list devices available -j)
device=$(python3 -c '
import json,sys
devices=json.load(sys.stdin)["devices"]
phones=[d for k in reversed(list(devices)) if ".iOS-" in k for d in devices[k] if "iPhone" in d["name"]]
if not phones: sys.exit("Install an iPhone Simulator runtime in Xcode, then run this again.")
print(next((d for d in phones if d["state"]=="Booted"),phones[0])["udid"])
' <<< "$devices")
xcrun simctl bootstatus "$device" -b
for viewer in "$developer_dir/Applications/Device Hub.app" "$developer_dir/Applications/Simulator.app"; do
  if [[ -d "$viewer" ]] && open "$viewer"; then
    break
  fi
done
echo "Building Galaxy Preview for the simulated iPhone..."
build_dir="$HOME/Library/Developer/Xcode/DerivedData/GalaxySimulatorPreview"
xcodebuild -quiet -project GalaxyBluetooth.xcodeproj -scheme GalaxyBluetooth -configuration Debug -destination "platform=iOS Simulator,id=$device" -derivedDataPath "$build_dir" build
for app in "$build_dir"/Build/Products/Debug-iphonesimulator/*.app; do
  bundle=$(/usr/libexec/PlistBuddy -c 'Print CFBundleIdentifier' "$app/Info.plist")
  if [[ $bundle == link.galaxy.bluetooth.natehuby76.preview ]]; then
    xcrun simctl install "$device" "$app"
    xcrun simctl privacy "$device" grant location "$bundle"
    xcrun simctl location "$device" set "${GALAXY_PREVIEW_LOCATION:-43.6426,-79.3871}"
    xcrun simctl launch --terminate-running-process "$device" "$bundle" --preview-galaxy --simulator-toggles -galaxy.app.navigationEnabled YES -navigation.defaultComma NO -navigation.offerPhoneTrip NO
    exit 0
  fi
done
echo 'The simulator preview app was not found.' >&2
exit 1
