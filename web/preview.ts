// The preview's own web view: it holds the preview's frame apart from the editor's page, so a
// long document drawing here never holds up typing there. The page says what to show
// ("to-preview"); this passes it on to the frame, as the page did when the frame was its own.
const tauri = (window as any).__TAURI__
const frame = document.getElementById("frame") as HTMLIFrameElement

tauri.event
  .listen("to-preview", ({ payload: m }: { payload: any }) => {
    if ("src" in m) {
      const src = m.src || "about:blank"
      if (frame.src !== src) frame.src = src
    } else if ("bg" in m) document.body.style.background = m.bg
    else if (!frame.src.startsWith("about:")) {
      const url = new URL(frame.src) // quire://localhost has no URL.origin, so build it
      frame.contentWindow?.postMessage(m, `${url.protocol}//${url.host}`)
    }
  })
  .then(() => tauri.event.emit("from-preview", "start")) // the page says again what to show

// The Markdown viewer asks for the text once it has loaded.
addEventListener("message", (e) => {
  if (e.source === frame.contentWindow && e.data === "ready") tauri.event.emit("from-preview", "ready")
})
