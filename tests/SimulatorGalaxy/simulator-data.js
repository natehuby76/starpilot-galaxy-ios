(() => {
  const assetFetch = window.fetch.bind(window)
  const toggle = (label, on) => ({ label, choices: ["Off", "On"], value: on ? "On" : "Off" })
  const slider = (label, value, minimum, maximum, step, unit = "") =>
    ({ label, value: String(value), minimum, maximum, step, unit })
  const group = (page, label) => ({ page, label, value: "", available: true })
  const pages = new Map()
  function add(id, title, rows) {
    pages.set(id, {page: id, view: id, title, subtitle: "Simulator sample settings", parked: true,
      vehicleIdentified: true, rows: rows.map(row => ({choices: [], reason: "", action: !row.page, available: true, ...row}))})
  }
  add("aol", "Always On Lateral", [toggle("Enable Always On Lateral", true), slider("Brake pause below", 0, 0, 100, 1, "km/h")])
  add("lane_change", "Lane Changes", [toggle("Allow lane changes", true), toggle("One change per signal", true),
    toggle("Automatic Lane Changes", false), slider("Lane Change Speed", 5, 1, 10, 1),
    slider("Automatic lane-change delay", 1, 0, 5, 0.1, "s")])
  add("lane", "Lane Centering", [slider("Lane Centering Strength", 5, 1, 10, 1)])
  add("torque", "Steering & Torque", [{label: "Steering controller", value: "Torque Controller", choices: ["Default", "Torque Controller"]}])
  add("profiles", "Long Planner", [group("navigation", "Navigation Planner")])
  add("navigation", "Navigation Planner", [slider("Slow for navigation turns", 50, 0, 100, 1, "%")])
  add("slc", "Speed Limit Controller", [toggle("Speed Limit Controller", false), toggle("Match Speed Limit on Engage", false)])
  add("display", "Display", [slider("Screen brightness", 75, 0, 100, 5, "%")])
  add("hub", "Toggles", [...pages.values()].filter(page => page.page !== "navigation").map(page => group(page.page, page.title)))

  const pending = new Map()
  window.fetch = async (input, options = {}) => {
    const request = new Request(input, options)
    const url = new URL(request.url)
    const path = url.pathname
    if (url.origin !== location.origin) return Response.json({error: "Simulator only"}, {status: 403})
    if (path === "/data/runtime.json") return Response.json({schemaVersion: 1, monitor: "local", instance: "simulator"})
    if (!path.startsWith("/api/")) return assetFetch(request)
    if (request.method === "GET") {
      const id = path.replace("/api/settings/pages/", "")
      if (pages.has(id)) return Response.json(pages.get(id))
      if (path.startsWith("/api/sentry/image/")) return assetFetch("./sample-data/sentry-frame.jpg")
      return assetFetch("./sample-data/" + path.slice(5) + ".json")
    }
    if (request.method === "POST" && path === "/api/settings/preview") {
      const {view, row, value, direction} = await request.json()
      const setting = pages.get(view)?.rows[row]
      if (setting?.action) {
        const choices = setting.choices
        const next = value ?? (choices.length ? choices[(choices.indexOf(setting.value) + (direction || 1) + choices.length) % choices.length]
          : Math.min(setting.maximum, Math.max(setting.minimum, Number(setting.value) + direction * setting.step)))
        const intent = crypto.randomUUID()
        pending.set(intent, {setting, next})
        return Response.json({intent, question: "Apply this sample setting?"})
      }
    }
    if (request.method === "POST" && path === "/api/settings/confirm") {
      const {intent, confirmed, page} = await request.json()
      const change = pending.get(intent)
      if (confirmed && change) {
        change.setting.value = String(change.next)
        pending.delete(intent)
        return Response.json({saved: true, page: pages.get(page)})
      }
    }
    return Response.json({error: "Unavailable in simulator preview"}, {status: 404})
  }
  if (!location.hash) history.replaceState(null, "", "#/settings")
})()
